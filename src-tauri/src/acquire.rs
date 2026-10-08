//! The per-connection read loop, shared by every device family.
//!
//! A [`Source`] only reports what arrived. Everything the stream contract depends on stays
//! here, in one place and one order: segment and rate controls sealed between reads, peak
//! selection on the cadence grid, the PD log, the unacknowledged-capacity guard, and the
//! End receipt written after the last point.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use witrn_hid::{decode_pd_report, Parser};

use crate::app_nap::AcquisitionActivity;
use crate::pd_capture::{now_ms, PdEvent, PdLog};
use crate::stream;
use crate::{drain_pd_pending, enqueue_pd_pending, DeviceData, DeviceInfo, DeviceOutgoing};

/// What a device delivered, stamped on the session clock.
pub(crate) struct Arrival {
    /// Microseconds since the session epoch.
    pub received_us: u64,
    pub payload: Payload,
}

pub(crate) enum Payload {
    Sample(DeviceData),
    /// A captured PD message as a 64-byte WITRN report, the format `PdLog` stores.
    Pd(Vec<u8>),
    /// The PD conversation restarted (detach); earlier capabilities no longer apply.
    PdReset,
}

/// Why a source ended the session.
pub(crate) enum Stop {
    /// The device went away. The stream ends quietly, like a cable pulled mid-read.
    Unplugged,
    /// The device is still there but failed beyond recovery; the reason reaches the UI.
    Failed(String),
}

/// One device family's acquisition.
///
/// `read` performs exactly one bounded step (a short wait, one transfer or one recovery
/// attempt) so controls are answered promptly. Arrivals are appended oldest first; on
/// `Err` nothing is appended.
pub(crate) trait Source: Send {
    fn read(&mut self, rate_ms: u64, out: &mut Vec<Arrival>) -> Result<(), Stop>;

    /// Minimum selection interval supported by this transport.
    fn min_rate_ms(&self) -> u64 {
        1
    }

    /// A transport can lower the effective rate after a negotiated mode fails.
    fn rate_override(&mut self) -> Option<u64> {
        None
    }

    /// Deliver whatever the device holds before a segment or rate boundary is sealed.
    fn barrier(&mut self, _out: &mut Vec<Arrival>) -> Result<(), Stop> {
        Ok(())
    }

    /// The selection interval changed.
    fn set_rate(&mut self, _rate_ms: u64) {}
}

/// Session resources the reader owns or shares with the emitter and the commands.
pub(crate) struct ReaderCtx {
    pub generation: u64,
    pub epoch: Instant,
    pub wall_anchor_ms: u64,
    pub running: Arc<AtomicBool>,
    pub sample_rate: Arc<AtomicU64>,
    pub pd_log: Arc<Mutex<PdLog>>,
    pub pd_capture: Arc<AtomicBool>,
    pub device_info: Arc<Mutex<Option<DeviceInfo>>>,
    pub tx: mpsc::SyncSender<DeviceOutgoing>,
    pub controls: mpsc::Receiver<stream::Control>,
    pub produced: Arc<AtomicU64>,
    pub consumed: Arc<AtomicU64>,
    pub end: Arc<Mutex<Option<stream::End>>>,
}

/// Mutable loop state, grouped so ingestion reads the same after a read as after a barrier.
struct Loop<'a> {
    generation: u64,
    wall_anchor_ms: u64,
    tx: &'a mpsc::SyncSender<DeviceOutgoing>,
    pd_log: &'a Mutex<PdLog>,
    pd_capture: &'a AtomicBool,
    selection: stream::Selection,
    next_selection_at: Option<u64>,
    pd_pending: VecDeque<PdEvent>,
    last_bus: Option<(f32, f32)>,
    pd_parser: Parser,
    segment: u64,
    segment_start_us: u64,
    rate_ms: u64,
    // Debug-only bus probe: what the device actually puts on the wire, independent of what
    // we decide to select. `offers/s` above `selects/s` means the cadence gate is decimating.
    #[cfg(debug_assertions)]
    bus_probe: stream::BusProbe,
}

impl Loop<'_> {
    /// Feed arrivals in order. Every sample is offered and gated at its own receive time,
    /// so a batch of device-timed samples is selected exactly as if each arrived alone.
    /// Returns whether any sample was offered.
    fn ingest(&mut self, arrivals: &mut Vec<Arrival>) -> Result<bool, String> {
        let mut offered = false;
        for arrival in arrivals.drain(..) {
            match arrival.payload {
                Payload::Sample(data) => {
                    self.last_bus = Some((data.voltage, data.current));
                    #[cfg(debug_assertions)]
                    self.bus_probe.offer(arrival.received_us);
                    self.selection.offer(stream::Sample {
                        data,
                        generation: self.generation,
                        seq: 0,
                        segment: self.segment,
                        received_us: arrival.received_us,
                        wall_anchor_ms: self.wall_anchor_ms,
                        segment_start_us: self.segment_start_us,
                        rate_ms: self.rate_ms,
                    });
                    self.gate(arrival.received_us)?;
                    offered = true;
                }
                Payload::Pd(report) => match decode_pd_report(&mut self.pd_parser, &report) {
                    Ok(metadata) if self.pd_capture.load(Ordering::Acquire) => {
                        let (vbus, ibus) = self
                            .last_bus
                            .map_or((None, None), |(v, i)| (Some(v), Some(i)));
                        let event = self.pd_log.lock().unwrap().push_message(
                            now_ms(),
                            report,
                            metadata,
                            vbus,
                            ibus,
                        );
                        if let Some(event) = event {
                            enqueue_pd_pending(&mut self.pd_pending, event);
                        }
                    }
                    Err(error) => eprintln!("PD 报告解析错误: {}", error),
                    _ => {}
                },
                Payload::PdReset => self.pd_parser.reset(),
            }
        }
        Ok(offered)
    }

    /// Select the pending peak once its window has closed at `now_us`.
    fn gate(&mut self, now_us: u64) -> Result<(), String> {
        let (due, next_deadline) = stream::selection_deadline(
            now_us,
            self.next_selection_at,
            Duration::from_millis(self.rate_ms).as_micros() as u64,
        );
        // The grid only moves when a point was actually taken: a read-timeout tick has no point
        // in it, and arming the deadline from that would put it a hair past the next arrival.
        if self.selection.pending.is_some() && due {
            self.selection
                .select()
                .and_then(|()| self.selection.drain(self.tx))?;
            // Selection cadence does not depend on transport capacity.
            self.next_selection_at = Some(next_deadline);
            #[cfg(debug_assertions)]
            self.bus_probe.select();
        }
        Ok(())
    }
}

/// Run until the source stops, the session is stopped, or the stream contract fails.
pub(crate) fn run_reader<S: Source>(mut source: S, ctx: ReaderCtx) {
    let ReaderCtx {
        generation,
        epoch,
        wall_anchor_ms,
        running,
        sample_rate,
        pd_log,
        pd_capture,
        device_info,
        tx,
        controls,
        produced,
        consumed,
        end,
    } = ctx;
    // 读线程存活期间退出 App Nap：窗口隐藏时 HID 读取与合批定时器不被合并。
    // 录制段打开期间另外阻止系统空闲睡眠。
    let mut activity = AcquisitionActivity::begin();
    let rate_ms = sample_rate
        .load(Ordering::Relaxed)
        .max(source.min_rate_ms());
    sample_rate.store(rate_ms, Ordering::Release);
    source.set_rate(rate_ms);
    let mut state = Loop {
        generation,
        wall_anchor_ms,
        tx: &tx,
        pd_log: &pd_log,
        pd_capture: &pd_capture,
        selection: stream::Selection::new(stream::SELECTED_CAP, produced),
        next_selection_at: None,
        pd_pending: VecDeque::new(),
        last_bus: None,
        pd_parser: Parser::new(),
        segment: 0,
        segment_start_us: 0,
        rate_ms,
        #[cfg(debug_assertions)]
        bus_probe: stream::BusProbe::default(),
    };
    let mut last_segment = 0;
    let mut arrivals = Vec::new();
    let mut failure = None;
    'read: loop {
        if !running.load(Ordering::Acquire) {
            break;
        }
        if let Err(error) = state.selection.drain(&tx) {
            failure = Some(error);
            break;
        }
        if state
            .selection
            .seq
            .saturating_sub(consumed.load(Ordering::Acquire))
            >= stream::UNACKED_CAP
        {
            failure = Some("unacknowledged sample capacity exceeded; acquisition stopped".into());
            break;
        }
        while let Ok(control) = controls.try_recv() {
            // Points the device already holds belong to the window being sealed.
            let flushed = match source.barrier(&mut arrivals) {
                Ok(()) => state.ingest(&mut arrivals).map(|_| ()),
                Err(Stop::Unplugged) => break 'read,
                Err(Stop::Failed(message)) => Err(message),
            };
            if let Err(error) = flushed
                .and_then(|()| state.selection.select())
                .and_then(|()| state.selection.drain(&tx))
            {
                failure = Some(error);
                break 'read;
            }
            let at = epoch.elapsed().as_micros() as u64;
            let reply = match control {
                stream::Control::Segment {
                    segment: next,
                    pd_enabled,
                    reply,
                } => {
                    if next != 0 && next <= last_segment {
                        let _ = reply.send(Err("recording segment must increase".into()));
                        continue;
                    }
                    state.segment = next;
                    last_segment = last_segment.max(next);
                    state.segment_start_us = at;
                    pd_capture.store(pd_enabled, Ordering::Release);
                    activity.set_recording(next != 0);
                    reply
                }
                stream::Control::Rate { rate, reply } => {
                    state.rate_ms = rate.max(source.min_rate_ms());
                    sample_rate.store(state.rate_ms, Ordering::Release);
                    source.set_rate(state.rate_ms);
                    reply
                }
            };
            state.next_selection_at = None;
            let _ = reply.send(Ok(stream::Boundary {
                generation,
                after_seq: state.selection.seq,
                segment: state.segment,
                received_us: at,
                wall_anchor_ms,
                rate_ms: state.rate_ms,
            }));
        }
        if !drain_pd_pending(&tx, &mut state.pd_pending) {
            failure = Some("PD emitter disconnected".into());
            break;
        }
        match source.read(state.rate_ms, &mut arrivals) {
            Ok(()) => {}
            Err(Stop::Unplugged) => break,
            Err(Stop::Failed(message)) => {
                failure = Some(message);
                break;
            }
        }
        if let Some(rate) = source.rate_override() {
            state.rate_ms = rate.max(source.min_rate_ms());
            sample_rate.store(state.rate_ms, Ordering::Release);
        }
        // Stamped as the read returns: an idle tick still closes a window whose time is up.
        let tick_us = epoch.elapsed().as_micros() as u64;
        match state.ingest(&mut arrivals) {
            Ok(true) => {}
            Ok(false) => {
                if let Err(error) = state.gate(tick_us) {
                    failure = Some(error);
                    break;
                }
            }
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
        #[cfg(debug_assertions)]
        if let Some(line) = state
            .bus_probe
            .take_report(Duration::from_secs(5), state.rate_ms)
        {
            eprintln!("{line}");
        }
    }
    running.store(false, Ordering::Release);
    if let Ok(mut info) = device_info.lock() {
        *info = None;
    }
    if let Err(error) = state.selection.finish(&tx) {
        failure = Some(error);
    }
    // PD remains recoverable from its log even if its bounded live queue overflowed.
    for event in state.pd_pending.drain(..) {
        if tx.send(DeviceOutgoing::Pd(Box::new(event))).is_err() {
            break;
        }
    }
    let receipt = stream::End {
        generation,
        last_seq: state.selection.seq,
        error: failure,
    };
    *end.lock().unwrap() = Some(receipt.clone());
    let _ = tx.send(DeviceOutgoing::End(receipt));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted device: each `read` replays one step.
    struct Script {
        steps: VecDeque<Result<Vec<Arrival>, Stop>>,
        rates: Arc<Mutex<Vec<u64>>>,
        barriers: Arc<AtomicU64>,
    }

    impl Source for Script {
        fn read(&mut self, _rate_ms: u64, out: &mut Vec<Arrival>) -> Result<(), Stop> {
            match self.steps.pop_front() {
                Some(Ok(arrivals)) => {
                    out.extend(arrivals);
                    Ok(())
                }
                Some(Err(stop)) => Err(stop),
                None => {
                    std::thread::sleep(Duration::from_millis(1));
                    Ok(())
                }
            }
        }

        fn barrier(&mut self, _out: &mut Vec<Arrival>) -> Result<(), Stop> {
            self.barriers.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn set_rate(&mut self, rate_ms: u64) {
            self.rates.lock().unwrap().push(rate_ms);
        }
    }

    fn data(current: f32) -> DeviceData {
        DeviceData {
            voltage: 5.0,
            current,
            power: 5.0 * current,
            dp: None,
            dn: None,
            cc1: 0.0,
            cc2: 0.0,
            temperature: None,
            ah: None,
            wh: None,
        }
    }

    fn sample(at_ms: u64, current: f32) -> Arrival {
        Arrival {
            received_us: at_ms * 1000,
            payload: Payload::Sample(data(current)),
        }
    }

    struct Harness {
        rx: mpsc::Receiver<DeviceOutgoing>,
        controls: mpsc::SyncSender<stream::Control>,
        running: Arc<AtomicBool>,
        end: Arc<Mutex<Option<stream::End>>>,
        pd_log: Arc<Mutex<PdLog>>,
        rates: Arc<Mutex<Vec<u64>>>,
        barriers: Arc<AtomicU64>,
        join: std::thread::JoinHandle<()>,
    }

    fn start(steps: Vec<Result<Vec<Arrival>, Stop>>, rate_ms: u64, capture_pd: bool) -> Harness {
        let (tx, rx) = mpsc::sync_channel(4096);
        let (controls, control_rx) = mpsc::sync_channel(8);
        let running = Arc::new(AtomicBool::new(true));
        let end = Arc::new(Mutex::new(None));
        let pd_log = Arc::new(Mutex::new(PdLog::default()));
        let rates = Arc::new(Mutex::new(Vec::new()));
        let barriers = Arc::new(AtomicU64::new(0));
        let ctx = ReaderCtx {
            generation: 3,
            epoch: Instant::now(),
            wall_anchor_ms: 1_000,
            running: Arc::clone(&running),
            sample_rate: Arc::new(AtomicU64::new(rate_ms)),
            pd_log: Arc::clone(&pd_log),
            pd_capture: Arc::new(AtomicBool::new(capture_pd)),
            device_info: Arc::new(Mutex::new(None)),
            tx,
            controls: control_rx,
            produced: Arc::new(AtomicU64::new(0)),
            consumed: Arc::new(AtomicU64::new(u64::MAX / 2)),
            end: Arc::clone(&end),
        };
        let source = Script {
            steps: steps.into(),
            rates: Arc::clone(&rates),
            barriers: Arc::clone(&barriers),
        };
        let join = std::thread::spawn(move || run_reader(source, ctx));
        Harness {
            rx,
            controls,
            running,
            end,
            pd_log,
            rates,
            barriers,
            join,
        }
    }

    fn collect(harness: Harness) -> (Vec<stream::Sample>, usize, stream::End, Harness) {
        let mut samples = Vec::new();
        let mut pds = 0;
        let end = loop {
            match harness
                .rx
                .recv_timeout(Duration::from_secs(5))
                .expect("reader stalled")
            {
                DeviceOutgoing::Sample(s) => samples.push(s),
                DeviceOutgoing::Pd(_) => pds += 1,
                DeviceOutgoing::End(end) => break end,
            }
        };
        (samples, pds, end, harness)
    }

    #[test]
    fn a_device_timed_batch_is_selected_point_by_point() {
        // One read carrying ten 1 ms samples, as a queue-mode poll does: at a 1 ms interval
        // every one of them must be selected, in order, with its own timestamp.
        let batch = (0..10).map(|i| sample(100 + i, i as f32)).collect();
        let harness = start(vec![Ok(batch), Err(Stop::Unplugged)], 1, false);
        let (samples, _, end, harness) = collect(harness);
        harness.join.join().unwrap();
        assert_eq!(end.error, None, "an unplug ends quietly");
        assert_eq!(samples.len(), 10);
        for (i, s) in samples.iter().enumerate() {
            assert_eq!(s.seq, i as u64 + 1, "seq stays gapless");
            assert_eq!(s.received_us, (100 + i as u64) * 1000);
            assert_eq!(s.generation, 3);
        }
        assert_eq!(end.last_seq, 10);
        assert!(!harness.running.load(Ordering::Acquire));
        assert_eq!(harness.end.lock().unwrap().as_ref().unwrap().last_seq, 10);
    }

    #[test]
    fn a_coarse_interval_keeps_the_peak_of_each_window() {
        // 100 ms interval over samples 10 ms apart. The half-period grace closes windows at
        // 50/150/250 ms, each keeping its largest |I|; `finish` seals the open tail.
        let mut steps = Vec::new();
        for i in 0..30u64 {
            let current = if i % 10 == 4 { -9.0 } else { 1.0 };
            steps.push(Ok(vec![sample(i * 10, current)]));
        }
        steps.push(Err(Stop::Unplugged));
        let (samples, _, end, harness) = collect(start(steps, 100, false));
        harness.join.join().unwrap();
        assert_eq!(
            samples
                .iter()
                .map(|s| (s.received_us / 1000, s.data.current))
                .collect::<Vec<_>>(),
            [(0, 1.0), (40, -9.0), (140, -9.0), (240, -9.0), (290, 1.0)]
        );
        assert_eq!(end.last_seq, 5);
    }

    #[test]
    fn a_failed_source_reaches_the_receipt() {
        let steps = vec![
            Ok(vec![sample(0, 1.0)]),
            Err(Stop::Failed("KM003C 读取失败: x".into())),
        ];
        let (samples, _, end, harness) = collect(start(steps, 10, false));
        harness.join.join().unwrap();
        assert_eq!(samples.len(), 1, "the retained point is still delivered");
        assert_eq!(end.error.as_deref(), Some("KM003C 读取失败: x"));
    }

    #[test]
    fn controls_seal_through_the_source_barrier_and_retarget_the_rate() {
        let harness = start(Vec::new(), 250, false);
        let (reply, rx) = mpsc::channel();
        harness
            .controls
            .send(stream::Control::Rate { rate: 1, reply })
            .unwrap();
        let boundary = rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!((boundary.generation, boundary.rate_ms), (3, 1));
        let (reply, rx) = mpsc::channel();
        harness
            .controls
            .send(stream::Control::Segment {
                segment: 1,
                pd_enabled: true,
                reply,
            })
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap()
                .segment,
            1
        );
        let (reply, rx) = mpsc::channel();
        harness
            .controls
            .send(stream::Control::Segment {
                segment: 1,
                pd_enabled: true,
                reply,
            })
            .unwrap();
        assert!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap().is_err(),
            "segments must increase"
        );
        assert_eq!(*harness.rates.lock().unwrap(), vec![250, 1]);
        assert!(harness.barriers.load(Ordering::Relaxed) >= 2);
        harness.running.store(false, Ordering::Release);
        let (_, _, end, harness) = collect(harness);
        harness.join.join().unwrap();
        assert_eq!(end.last_seq, 0);
    }

    #[test]
    fn pd_frames_follow_the_capture_switch_and_carry_the_last_bus_reading() {
        // Source_Capabilities 5 V / 3 A wrapped as a WITRN report.
        let mut frame = vec![0u8; witrn_hid::REPORT_LEN];
        let msg = [0xA1u8, 0x11, 0x2C, 0x91, 0x01, 0x08];
        frame[0] = 0xFE;
        frame[1] = msg.len() as u8 + 1;
        frame[2] = 224;
        frame[3..3 + msg.len()].copy_from_slice(&msg);
        let pd = |frame: &Vec<u8>| Arrival {
            received_us: 0,
            payload: Payload::Pd(frame.clone()),
        };
        let steps = vec![
            Ok(vec![sample(0, 2.0), pd(&frame)]),
            Ok(vec![Arrival {
                received_us: 1,
                payload: Payload::PdReset,
            }]),
            Err(Stop::Unplugged),
        ];
        let (_, pds, _, harness) = collect(start(steps, 10, true));
        harness.join.join().unwrap();
        assert_eq!(pds, 1);
        let log = harness.pd_log.lock().unwrap();
        let events = log.events_after(None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].msg_type.as_deref(), Some("Source_Capabilities"));
        assert_eq!((events[0].vbus, events[0].ibus), (Some(5.0), Some(2.0)));

        let (_, pds, _, harness) = collect(start(
            vec![Ok(vec![pd(&frame)]), Err(Stop::Unplugged)],
            10,
            false,
        ));
        harness.join.join().unwrap();
        assert_eq!(pds, 0, "capture off: decoded for context, not logged");
    }
}
