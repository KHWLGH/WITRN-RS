//! Probe authenticated AdcQueue streaming for one POWER-Z device.
//!
//! Usage: cargo run -p km003c --example probe_queue -- <bus-id> <address>

use std::env;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use km003c::meter::Meter;
use km003c::protocol::{Attribute, QueueSample};

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let bus = args.next().context("缺少 bus-id")?;
    let address: u8 = args.next().context("缺少 USB address")?.parse()?;
    let mut meter = Meter::open(&bus, address, None).context("打开 POWER-Z 失败")?;
    let device = meter
        .device_mut()
        .ok_or_else(|| anyhow::anyhow!("Bulk 句柄为空"))?;

    let hardware_id = device.memory_read(0x4001_0450, 12)?;
    let hardware_id: [u8; 12] = hardware_id
        .try_into()
        .map_err(|_| anyhow::anyhow!("HardwareID 长度不是 12 字节"))?;
    let timestamp_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    let level = device.stream_auth(hardware_id, timestamp_ms)?;
    device.start_graph(3)?;

    let started = Instant::now();
    let mut samples = 0u64;
    let mut holes = 0u64;
    let mut last_seq: Option<u16> = None;
    let mut last_report: Option<QueueSample> = None;
    while started.elapsed() < Duration::from_secs(10) {
        let response = device.get_data(Attribute::ADC_QUEUE | Attribute::ADC)?;
        for sample in response.queue {
            if let Some(previous) = last_seq {
                let delta = u64::from(sample.sequence.wrapping_sub(previous));
                if delta > 1 {
                    holes += delta - 1;
                }
            }
            last_seq = Some(sample.sequence);
            last_report = Some(sample);
            samples += 1;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let stop_result = device.stop_graph();
    stop_result.context("StopGraph 失败")?;

    let elapsed = started.elapsed().as_secs_f64();
    println!("auth_level={level}");
    println!("samples={samples}");
    println!("effective_sps={:.2}", samples as f64 / elapsed);
    println!("sequence_holes={holes}");
    if let Some(sample) = last_report {
        println!(
            "last_sample={{sequence:{}, voltage_uv:{}, current_ua:{}, marker:0x{:04X}}}",
            sample.sequence, sample.vbus_uv, sample.ibus_ua, sample.marker
        );
    }
    if samples == 0 {
        bail!("10 秒内没有收到 AdcQueue 样本");
    }
    Ok(())
}
