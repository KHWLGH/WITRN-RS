//! Rust-side hot-path benchmarks. `cargo bench -p witrn-rs`.
//!
//! Why these and not others:
//! - `decode_general_sample` is the allocation-free floor. It should stay flat; if it ever
//!   moves, something was added to the per-report path.
//! - `emit_json_batch` is the number that decides whether a binary transport is worth anything.
//!   `Sample` carries `#[serde(flatten)] data`, which forces serde's intermediate `Content`
//!   buffering, and 17 JSON fields per point. The `bytes/*` measurements below make that cost
//!   visible next to the time.
//! - `selection_*` is what actually runs at 100Hz between the HID read and the channel.
//!
//! `pd_metadata_tree_build` covers the PD path as a slope detector, not a gate: PD is event-driven,
//! so its cost cannot break 100Hz, but `Value::Str` / `Value::List` / raw-bit handling can regress
//! silently. This used to be skipped with the rationale that a synthetic frame only measures the CRC
//! rejection path and that the repo has no captured frame to bench against. That premise was wrong:
//! `pd_capture.rs`'s own tests carry valid-CRC Source_Capabilities and GoodCRC reports, and those are
//! what this bench feeds the decoder — with a start-of-run assertion that the caps frame really builds
//! a materially bigger tree than the GoodCRC one, so the numbers describe a tree being built. If the
//! fixtures stop decoding, the bench panics rather than reporting a flattering measurement.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use witrn_hid::{decode_pd_report, Parser};
use witrn_rs_lib::stream::{self, sample_at, Outgoing, Sample};

/// A 64-byte general-measurement report: kind byte 0xFF, then the little-endian fields the
/// decoder reads. Values are arbitrary but finite; the decoder does no CRC on this path.
fn general_report() -> Vec<u8> {
    let mut buf = vec![0u8; 64];
    buf[0] = 0xFF;
    buf[2..6].copy_from_slice(&1995u32.to_le_bytes()); // 5.000 V
    buf[6..10].copy_from_slice(&1000u32.to_le_bytes()); // 1.000 A
    buf[10..14].copy_from_slice(&2600u32.to_le_bytes()); // temp
    buf[14..18].copy_from_slice(&5555u32.to_le_bytes()); // D+
    buf[18..22].copy_from_slice(&3300u32.to_le_bytes()); // D-
    buf
}

fn samples(n: usize) -> Vec<Sample> {
    (0..n as u64)
        .map(|i| sample_at(i * 10_000, ((i % 7) as f32 - 3.0) * 0.5))
        .collect()
}

fn decode_floor(c: &mut Criterion) {
    let report = general_report();
    let mut g = c.benchmark_group("decode");
    g.bench_function("general_sample", |b| {
        b.iter(|| witrn_hid::decode_general_sample(black_box(&report)).unwrap())
    });
    g.finish();
}

fn json_batch_cost(c: &mut Criterion) {
    let mut g = c.benchmark_group("emit_json_batch");
    for n in [1usize, 8, 32, 64] {
        let batch = samples(n);
        // Record the payload size once, outside the timed closure: the per-point JSON width is
        // what a columnar transport would remove, and it is a constant, not a measurement.
        let bytes = serde_json::to_vec(&batch).unwrap().len();
        g.throughput(criterion::Throughput::Elements(n as u64));
        g.bench_function(format!("to_vec_n{n}"), |b| {
            b.iter(|| serde_json::to_vec(black_box(&batch)).unwrap())
        });
        g.bench_function(format!("to_string_n{n}"), |b| {
            b.iter(|| serde_json::to_string(black_box(&batch)).unwrap())
        });
        println!(
            "emit_json_batch: n={n} json={bytes}B ({:.1} B/point)",
            bytes as f64 / n as f64
        );
    }
    g.finish();
}

fn selection_churn(c: &mut Criterion) {
    let mut g = c.benchmark_group("selection");
    g.bench_function("offer_select_retain", |b| {
        let produced = Arc::new(AtomicU64::new(0));
        b.iter_batched(
            || {
                (
                    stream::Selection::new(stream::SELECTED_CAP, Arc::clone(&produced)),
                    Vec::new(),
                )
            },
            |(mut selection, mut drained)| {
                let (tx, rx) = mpsc::sync_channel(stream::CHANNEL_CAP);
                for i in 0..64u64 {
                    // Two offers per window exercise the peak-retention rule, which is the
                    // branch that decides what actually reaches the channel.
                    selection.offer(sample_at(i * 10_000, 1.0));
                    selection.offer(sample_at(i * 10_000 + 5_000, -4.0));
                    selection.select().unwrap();
                }
                selection.drain(&tx).unwrap();
                drop(tx);
                drained.extend(rx);
                black_box((
                    drained.len(),
                    selection.seq,
                    produced.load(Ordering::Acquire),
                ))
            },
            criterion::BatchSize::SmallInput,
        )
    });
    g.bench_function("emit_loop_channel_only", |b| {
        let batch = samples(64);
        b.iter(|| {
            let (tx, rx) = mpsc::sync_channel::<Outgoing>(1024);
            for s in &batch {
                tx.send(Outgoing::Sample(s.clone())).unwrap();
            }
            drop(tx);
            let mut delivered = 0usize;
            stream::emit_loop(
                rx,
                || std::time::Duration::from_millis(8),
                |samples, _pds, _end| {
                    delivered += samples.len();
                    Ok(())
                },
            )
            .unwrap();
            black_box(delivered)
        })
    });
    g.finish();
}

/// Known-good PD reports, copied from `pd_capture.rs`'s own tests (`summarize_goodcrc_and_source_caps`).
/// The payload bytes carry a real CRC, so `decode_pd_report` takes the success path and builds the
/// whole `Metadata` tree; if that ever stops being true these benches panic rather than quietly
/// measuring an error path.
const PD_SOURCE_CAPS: &[u8] = &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08];
const PD_GOOD_CRC: &[u8] = &[0x41, 0x00];

fn pd_frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![0u8; 64];
    frame[0] = 0xFE;
    frame[1] = payload.len() as u8 + 1;
    frame[2] = 0xE0; // SOP1
    frame[3..3 + payload.len()].copy_from_slice(payload);
    frame
}

/// The cost of turning one PD report into the tree the UI shows, and into the bytes that cross IPC.
/// Deliberately *not* a gate: PD is event-driven, not 100 Hz. It exists so that a change to
/// `Value::Str` / `Value::List` / raw-bit handling cannot land without anyone noticing the slope.
fn pd_metadata_tree_build(c: &mut Criterion) {
    let caps = pd_frame(PD_SOURCE_CAPS);
    let goodcrc = pd_frame(PD_GOOD_CRC);
    // 前提本身要被检查一次，否则这条 bench 可能在计时一条 CRC 拒绝路径而没人知道。
    // 真建出树来的证据：Capabilities 的序列化结果必须显著大于 GoodCRC 那种单对象帧。
    let mut probe = Parser::new();
    let caps_bytes = serde_json::to_vec(
        &decode_pd_report(&mut probe, &caps).expect("known-good CAPABILITIES frame"),
    );
    let good_bytes = serde_json::to_vec(
        &decode_pd_report(&mut probe, &goodcrc).expect("known-good GoodCRC frame"),
    );
    assert!(
        caps_bytes.expect("caps serializes").len()
            > good_bytes.expect("goodcrc serializes").len() * 2,
        "PD 前提变了：Source_Capabilities 没有比 GoodCRC 建出更大的树，这条 bench 测的东西不可信"
    );
    let mut g = c.benchmark_group("pd_metadata_tree_build");
    for (name, payload) in [("source_caps", &caps), ("good_crc", &goodcrc)] {
        g.bench_with_input(BenchmarkId::from_parameter(name), payload, |b, frame| {
            let mut parser = Parser::new();
            b.iter(|| {
                let meta =
                    decode_pd_report(&mut parser, black_box(frame)).expect("known-good frame");
                black_box(serde_json::to_vec(&meta).expect("metadata serializes"))
            })
        });
    }
    g.finish();
}

criterion_group!(
    benches,
    decode_floor,
    json_batch_cost,
    selection_churn,
    pd_metadata_tree_build
);
criterion_main!(benches);
