//! POWER-Z KM003C / KM002C sessions: the bulk poller that feeds the shared read loop,
//! and the trigger thread that owns the CDC port.
//!
//! The two run side by side on one meter. The poller reports sniffed Source_Capabilities
//! to the trigger through a [`PdoCache`], and tells it to forget the CDC port whenever
//! the bulk handle had to be reopened (the meter may have re-enumerated).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use km003c::meter::{self, Meter, Step};
use km003c::protocol::pd::{PdEventKind, PdMessage, Sop};
use km003c::protocol::{AdcData, Attribute, DataResponse, QueueSample};
use km003c::transport::{self, bulk};
use km003c::trigger::{wire_pdos, PdoCache, TriggerSession};
use km003c::{StopSignal, TriggerCommand, TriggerOutcome};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::acquire::{Arrival, Payload, Source, Stop};
use crate::{line_voltage, stream, usb_port, AppState, DeviceData, DeviceFamily, DeviceInfo};

/// Device paths of POWER-Z meters look like `km003c:{bus}#{address}`.
pub(crate) const PATH_PREFIX: &str = "km003c:";
/// Poll cadence: one GetData round trip every 10 ms feeds the 100/s selection grid.
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Longest single wait inside `read`, so controls are answered promptly.
const MAX_WAIT: Duration = Duration::from_millis(20);
/// How often the trigger thread checks whether its session is still running.
const TRIGGER_IDLE: Duration = Duration::from_millis(100);
const QUEUE_POLL: Duration = Duration::from_millis(20);
const QUEUE_START_TIMEOUT: Duration = Duration::from_millis(1500);
const KM003C_MAX_RATE_HZ: u32 = 1000;
// A USB response holds at most 204 queue samples (4096 / 20 bytes).
const QUEUE_HISTORY: usize = 256;

/// Handles the trigger commands need, kept outside the device slot so a draining stream
/// never blocks a cancel.
pub(crate) struct Km003cControl {
    generation: u64,
    tx: mpsc::Sender<TriggerMsg>,
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

enum TriggerMsg {
    Run {
        cmd: TriggerCommand,
        req_id: String,
        reply: mpsc::Sender<TriggerOutcome>,
    },
    /// The bulk handle was reopened; the CDC port and entered protocol are stale.
    DropCdc,
}

#[derive(Clone, Serialize)]
struct TriggerProgress<'a> {
    generation: u64,
    req_id: &'a str,
    text: &'a str,
}

#[derive(Clone, Serialize)]
struct PdmState {
    generation: u64,
    open: bool,
    message: &'static str,
}

/// Every POWER-Z meter on the bus. Enumeration problems are logged, never fatal: they
/// must not hide the WITRN meters listed alongside.
pub(crate) fn device_infos() -> Vec<DeviceInfo> {
    let devices = match bulk::list_devices() {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("枚举 POWER-Z 设备失败: {error:#}");
            return Vec::new();
        }
    };
    devices
        .into_iter()
        .map(|device| {
            let model_name = format!("POWER-Z {}", transport::model_name(device.pid));
            // Without a port path, the unit's serial is what tells two meters apart.
            let serial_label = device
                .serial
                .as_deref()
                .filter(|serial| !serial.trim().is_empty() && device.usb_port.is_none())
                .map(|serial| format!("SN {serial}"));
            let display_name = usb_port::format_device_display_name(
                &model_name,
                device.usb_port.as_deref(),
                serial_label.as_deref(),
            );
            DeviceInfo {
                path: format!("{PATH_PREFIX}{}#{}", device.bus_id, device.address),
                vid: device.vid,
                pid: device.pid,
                serial_number: device.serial,
                usb_port: device.usb_port,
                manufacturer: Some("ChargerLAB".into()),
                product: device.product,
                model_name,
                display_name,
                interface_number: i32::from(bulk::INTERFACE_VENDOR),
                usage_page: 0,
                family: DeviceFamily::Km003c,
                controls: true,
                max_rate_hz: KM003C_MAX_RATE_HZ,
            }
        })
        .collect()
}

fn parse_location(location: &str) -> Result<(String, u8), String> {
    let (bus, address) = location
        .rsplit_once('#')
        .ok_or_else(|| format!("无效的 POWER-Z 设备路径: {location}"))?;
    let address = address
        .parse()
        .map_err(|_| format!("无效的 POWER-Z 设备路径: {location}"))?;
    Ok((bus.to_string(), address))
}

/// Open the meter, then start the stream threads and the trigger thread.
///
/// The bulk handshake happens before a generation is taken, so a driver problem is a
/// plain connect error rather than a stream that opens and immediately fails.
pub(crate) fn connect(
    path: &str,
    location: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<stream::Open, String> {
    let (bus_id, address) = parse_location(location)?;
    let info = device_infos()
        .into_iter()
        .find(|device| device.path == path)
        .ok_or("找不到指定设备")?;
    let (mut task_slot, had_session) = crate::claim_device_slot(state)?;
    let meter = match Meter::open(&bus_id, address, info.serial_number.as_deref()) {
        Ok(meter) => meter,
        Err(error) => {
            crate::report_open_failure(state, &app, had_session);
            return Err(format!("无法打开设备: {error:#}"));
        }
    };
    let serial = info
        .serial_number
        .clone()
        .filter(|serial| !serial.trim().is_empty() && serial != "-");
    let pdo_cache = PdoCache::default();
    let (trigger_tx, trigger_rx) = mpsc::channel();
    let busy = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let trigger_app = app.clone();
    let source_app = app.clone();
    let source_rate = Arc::clone(&state.sample_rate);
    let open = crate::launch_stream(state, app, &mut task_slot, info, |seed| {
        let session = TriggerSession::new(
            serial,
            StopSignal::new(Arc::clone(&seed.running), Arc::clone(&cancel)),
        );
        let running = Arc::clone(&seed.running);
        let generation = seed.generation;
        let cache = pdo_cache.clone();
        let trigger_join = thread::spawn(move || {
            trigger_loop(session, trigger_rx, running, cache, trigger_app, generation)
        });
        let source = Km003cSource {
            meter,
            epoch: seed.epoch,
            next_poll: Instant::now(),
            trigger_tx: trigger_tx.clone(),
            pdo_cache,
            app: source_app,
            sample_rate: source_rate,
            hardware_id: None,
            queue: None,
            queue_failed: false,
            rate_override: None,
            last_temperature: None,
        };
        (source, vec![trigger_join])
    });
    *state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")? = Some(Km003cControl {
        generation: open.generation,
        tx: trigger_tx,
        busy,
        cancel,
    });
    Ok(open)
}

/// Commands run one at a time, in arrival order, until the session stops.
fn trigger_loop(
    mut session: TriggerSession,
    rx: mpsc::Receiver<TriggerMsg>,
    running: Arc<AtomicBool>,
    pdo_cache: PdoCache,
    app: AppHandle,
    generation: u64,
) {
    while running.load(Ordering::Acquire) {
        match rx.recv_timeout(TRIGGER_IDLE) {
            Ok(TriggerMsg::Run { cmd, req_id, reply }) => {
                let outcome = session.run(&cmd, &pdo_cache, &mut |text| {
                    let _ = app.emit(
                        "km003c-trigger-progress",
                        TriggerProgress {
                            generation,
                            req_id: &req_id,
                            text,
                        },
                    );
                });
                let _ = reply.send(outcome);
            }
            Ok(TriggerMsg::DropCdc) => {
                if session.drop_cdc() {
                    let _ = app.emit(
                        "km003c-pdm-state",
                        PdmState {
                            generation,
                            open: false,
                            message: "PDM 已断开，请重新打开",
                        },
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Clears the busy flag however the waiting command ends.
struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Run one trigger command on the connected meter and wait for its outcome.
///
/// Replies stream in as `km003c-trigger-progress` events meanwhile. A scan can take
/// minutes, so the wait happens on a blocking-pool thread, not an async worker.
#[tauri::command]
pub(crate) async fn km003c_trigger(
    generation: u64,
    req_id: String,
    cmd: TriggerCommand,
    state: State<'_, AppState>,
) -> Result<TriggerOutcome, String> {
    let (tx, busy, cancel) = {
        let slot = state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")?;
        let control = slot
            .as_ref()
            .filter(|control| control.generation == generation)
            .ok_or("设备未连接或已更换")?;
        (
            control.tx.clone(),
            Arc::clone(&control.busy),
            Arc::clone(&control.cancel),
        )
    };
    if busy.swap(true, Ordering::AcqRel) {
        return Err("上一条协议命令仍在执行".into());
    }
    let guard = BusyGuard(busy);
    // Cleared before sending: a cancel that races the dequeue still applies to this command.
    cancel.store(false, Ordering::Release);
    let (reply, outcome) = mpsc::channel();
    tx.send(TriggerMsg::Run { cmd, req_id, reply })
        .map_err(|_| "设备未连接")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        outcome.recv()
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|_| "协议控制线程已退出".to_string())
}

/// Abort the command in flight; its reply arrives with code `cancelled`.
#[tauri::command(async)]
pub(crate) fn km003c_cancel_trigger(
    generation: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let slot = state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")?;
    if let Some(control) = slot
        .as_ref()
        .filter(|control| control.generation == generation)
    {
        control.cancel.store(true, Ordering::Release);
    }
    Ok(())
}

struct Km003cSource {
    meter: Meter,
    epoch: Instant,
    next_poll: Instant,
    trigger_tx: mpsc::Sender<TriggerMsg>,
    pdo_cache: PdoCache,
    app: AppHandle,
    sample_rate: Arc<AtomicU64>,
    /// HardwareID is stable for the physical meter. Keep it across queue restarts and
    /// USB re-enumeration so a rate toggle does not repeat the encrypted memory exchange.
    hardware_id: Option<[u8; 12]>,
    queue: Option<QueueMode>,
    queue_failed: bool,
    rate_override: Option<u64>,
    last_temperature: Option<f32>,
}

struct QueueMode {
    rate_index: u8,
    started: Instant,
    saw_sample: bool,
    clock: QueueClock,
    holes_reported: bool,
    replays_reported: bool,
    recent: VecDeque<QueueSample>,
}

/// Expand the meter's wrapping 1 kHz sequence into host-relative microseconds.
#[derive(Clone, Default)]
struct QueueClock {
    last_seq: Option<u16>,
    last_us: u64,
    last_observed_us: u64,
    holes: u64,
}

impl QueueClock {
    fn observe(&mut self, sequence: u16, observed_us: u64, rate_index: u8) -> u64 {
        let step = match rate_index {
            0 => 500u64,
            1 => 100,
            2 => 20,
            _ => 1,
        };
        let Some(previous) = self.last_seq else {
            self.last_seq = Some(sequence);
            self.last_us = observed_us;
            self.last_observed_us = observed_us;
            return observed_us;
        };
        let delta = u64::from(sequence.wrapping_sub(previous));
        if delta > 5000 {
            // A device reset or a long pause is not a meaningful continuation.
            self.last_seq = Some(sequence);
            self.last_us = observed_us;
            self.last_observed_us = observed_us;
            return observed_us;
        }
        if delta > step {
            self.holes += delta / step - 1;
        }
        let predicted = self.last_us.saturating_add(delta * 1000);
        let timestamp = if predicted > observed_us {
            // Never publish a device timestamp in the future. This also pulls a fast
            // device back to the host clock immediately.
            observed_us
        } else {
            let lag = observed_us.saturating_sub(predicted);
            if lag > 5_000 {
                // A slow device clock may be corrected, but at no more than 1 ms per
                // second. Use host time elapsed since the previous observation so a
                // batched response cannot consume the entire correction budget.
                let observed_elapsed = observed_us.saturating_sub(self.last_observed_us);
                let correction = observed_elapsed / 1_000;
                predicted.saturating_add(correction).min(observed_us)
            } else {
                predicted
            }
        }
        .max(self.last_us);
        self.last_seq = Some(sequence);
        self.last_us = timestamp;
        self.last_observed_us = observed_us;
        timestamp
    }

    fn take_holes(&mut self) -> u64 {
        let holes = self.holes;
        self.holes = 0;
        holes
    }
}

impl Source for Km003cSource {
    fn min_rate_ms(&self) -> u64 {
        1
    }

    fn read(&mut self, rate_ms: u64, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        if rate_ms == 1 {
            return self.read_queue(out);
        }
        self.stop_queue();
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(Attribute::ADC_AND_PD, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, POLL_INTERVAL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver(response, received_us, out);
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn barrier(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        // A control boundary must first drain one response already waiting in the
        // meter. Otherwise a queue batch can be stamped into the next recording
        // segment even though it arrived before the boundary was requested.
        let queue_mode = self.queue.is_some();
        let attr = if queue_mode {
            Attribute::ADC | Attribute::ADC_QUEUE | Attribute::PD_PACKET
        } else {
            Attribute::ADC_AND_PD
        };
        let period = if queue_mode {
            QUEUE_POLL
        } else {
            POLL_INTERVAL
        };
        let now = Instant::now();
        let step = self.meter.step(attr, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, period, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                if queue_mode {
                    self.deliver_queue(response, received_us, out)?;
                } else {
                    self.deliver(response, received_us, out);
                }
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                if queue_mode {
                    self.stop_queue();
                }
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn set_rate(&mut self, rate_ms: u64) {
        if rate_ms == 1 {
            self.queue_failed = false;
            self.next_poll = Instant::now();
        } else {
            self.stop_queue();
            self.queue_failed = false;
        }
    }

    fn rate_override(&mut self) -> Option<u64> {
        self.rate_override.take()
    }
}

impl Km003cSource {
    fn read_queue(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        if self.queue.is_none() {
            if self.queue_failed {
                // The reader will have lowered the shared setting after the first failure.
                return self.read_average(out);
            }
            if let Err(error) = self.start_queue() {
                self.queue_failed = true;
                self.rate_override = Some(10);
                self.sample_rate.store(10, Ordering::Release);
                let _ = self.app.emit(
                    "km003c-high-rate",
                    serde_json::json!({ "ok": false, "message": error }),
                );
                return self.read_average(out);
            }
        }
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(
            Attribute::ADC | Attribute::ADC_QUEUE | Attribute::PD_PACKET,
            now,
        );
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, QUEUE_POLL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver_queue(response, received_us, out)?;
                if self.queue.as_ref().is_some_and(|mode| !mode.saw_sample)
                    && self
                        .queue
                        .as_ref()
                        .is_some_and(|mode| mode.started.elapsed() >= QUEUE_START_TIMEOUT)
                {
                    self.fail_queue("AdcQueue 在 1.5 秒内没有返回样本".into());
                }
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                self.stop_queue();
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn read_average(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(Attribute::ADC_AND_PD, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, POLL_INTERVAL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver(response, received_us, out);
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn start_queue(&mut self) -> Result<(), String> {
        let hardware_id = if let Some(hardware_id) = self.hardware_id {
            hardware_id
        } else {
            let device = self
                .meter
                .device_mut()
                .ok_or_else(|| "Bulk 设备当前不可用".to_string())?;
            let hardware_id = device
                .memory_read(0x4001_0450, 12)
                .map_err(|error| format!("读取 HardwareID 失败: {error:#}"))?;
            let hardware_id: [u8; 12] = hardware_id
                .try_into()
                .map_err(|_| "HardwareID 长度错误".to_string())?;
            self.hardware_id = Some(hardware_id);
            hardware_id
        };
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("系统时钟错误: {error}"))?
            .as_millis() as u64;
        let device = self
            .meter
            .device_mut()
            .ok_or_else(|| "Bulk 设备当前不可用".to_string())?;
        let level = device
            .stream_auth(hardware_id, timestamp_ms)
            .map_err(|error| format!("StreamingAuth 失败: {error:#}"))?;
        device
            .start_graph(3)
            .map_err(|error| format!("StartGraph 失败: {error:#}"))?;
        let _ = self.app.emit(
            "km003c-high-rate",
            serde_json::json!({ "ok": true, "auth_level": level }),
        );
        self.queue = Some(QueueMode {
            rate_index: 3,
            started: Instant::now(),
            saw_sample: false,
            clock: QueueClock::default(),
            holes_reported: false,
            replays_reported: false,
            recent: VecDeque::with_capacity(QUEUE_HISTORY),
        });
        self.next_poll = Instant::now();
        Ok(())
    }

    fn stop_queue(&mut self) {
        if self.queue.take().is_some() {
            if let Some(device) = self.meter.device_mut() {
                let _ = device.stop_graph();
            }
        }
    }

    fn fail_queue(&mut self, message: String) {
        self.stop_queue();
        self.queue_failed = true;
        self.rate_override = Some(10);
        self.sample_rate.store(10, Ordering::Release);
        let _ = self.app.emit(
            "km003c-high-rate",
            serde_json::json!({ "ok": false, "message": message }),
        );
    }

    /// The sample goes first, so PD rows from the same poll carry its V/I.
    fn deliver(&self, response: DataResponse, received_us: u64, out: &mut Vec<Arrival>) {
        if let Some(adc) = response.adc {
            out.push(Arrival {
                received_us,
                payload: Payload::Sample(map_adc(&adc)),
            });
        }
        for event in response.pd_events {
            match event.kind {
                PdEventKind::Message(message) => {
                    if message.is_source_capabilities() {
                        self.pdo_cache.update(wire_pdos(&message.pdos));
                    }
                    if let Some(frame) = witrn_pd_frame(&message) {
                        out.push(Arrival {
                            received_us,
                            payload: Payload::Pd(frame),
                        });
                    }
                }
                PdEventKind::Disconnect => out.push(Arrival {
                    received_us,
                    payload: Payload::PdReset,
                }),
                PdEventKind::Connect | PdEventKind::Unknown { .. } => {}
            }
        }
    }

    fn deliver_queue(
        &mut self,
        response: DataResponse,
        received_us: u64,
        out: &mut Vec<Arrival>,
    ) -> Result<(), Stop> {
        if let Some(adc) = response.adc {
            let temperature = adc.temp_c() as f32;
            self.last_temperature = (-40.0..=150.0)
                .contains(&temperature)
                .then_some(temperature);
        }
        let Some(mode) = self.queue.as_mut() else {
            return Ok(());
        };
        let (skip, timestamps) = queue_timestamps(
            &mut mode.clock,
            &mode.recent,
            &response.queue,
            received_us,
            mode.rate_index,
        )
        .map_err(Stop::Failed)?;
        if skip > 0 && !mode.replays_reported {
            mode.replays_reported = true;
            eprintln!("KM003C AdcQueue 已核实并跳过 {skip} 个重放样本");
        }
        for (sample, timestamp_us) in response.queue[skip..].iter().zip(timestamps) {
            if mode.recent.len() == QUEUE_HISTORY {
                mode.recent.pop_front();
            }
            mode.recent.push_back(*sample);
            let mut data = map_queue(sample, mode.rate_index);
            data.temperature = self.last_temperature;
            out.push(Arrival {
                received_us: timestamp_us,
                payload: Payload::Sample(data),
            });
            mode.saw_sample = true;
        }
        let holes = mode.clock.take_holes();
        if holes > 0 && !mode.holes_reported {
            mode.holes_reported = true;
            eprintln!("KM003C AdcQueue 检测到 {holes} 个序号空洞");
        }
        self.deliver_pd(&response, received_us, out);
        Ok(())
    }

    fn deliver_pd(&self, response: &DataResponse, received_us: u64, out: &mut Vec<Arrival>) {
        for event in &response.pd_events {
            match &event.kind {
                PdEventKind::Message(message) => {
                    if message.is_source_capabilities() {
                        self.pdo_cache.update(wire_pdos(&message.pdos));
                    }
                    if let Some(frame) = witrn_pd_frame(message) {
                        out.push(Arrival {
                            received_us,
                            payload: Payload::Pd(frame),
                        });
                    }
                }
                PdEventKind::Disconnect => out.push(Arrival {
                    received_us,
                    payload: Payload::PdReset,
                }),
                PdEventKind::Connect | PdEventKind::Unknown { .. } => {}
            }
        }
    }
}

/// Firmware can replay an old queue prefix. Verify its complete wire values before
/// omitting it, and validate the new timestamps before publishing any of the batch.
fn queue_timestamps(
    clock: &mut QueueClock,
    recent: &VecDeque<QueueSample>,
    samples: &[QueueSample],
    received_us: u64,
    rate_index: u8,
) -> Result<(usize, Vec<u64>), String> {
    let mut skip = 0;
    if let Some(previous) = clock.last_seq {
        for sample in samples {
            let delta = sample.sequence.wrapping_sub(previous);
            if delta != 0 && delta < 0x8000 {
                break;
            }
            if !recent.contains(sample) {
                return Err("KM003C AdcQueue 返回无法核实的倒序样本；采集已停止".into());
            }
            skip += 1;
        }
    }
    let first_us = received_us.saturating_sub(samples.len().saturating_sub(1) as u64 * 1000);
    let mut next = clock.clone();
    let mut timestamps = Vec::with_capacity(samples.len() - skip);
    for (index, sample) in samples.iter().enumerate().skip(skip) {
        if next.last_seq.is_some_and(|previous| {
            let delta = sample.sequence.wrapping_sub(previous);
            delta == 0 || delta >= 0x8000
        }) {
            return Err("KM003C AdcQueue 返回无法核实的倒序样本；采集已停止".into());
        }
        let previous_us = next.last_seq.map(|_| next.last_us);
        let timestamp = next.observe(sample.sequence, first_us + index as u64 * 1000, rate_index);
        if previous_us.is_some_and(|previous| timestamp <= previous) {
            return Err("KM003C AdcQueue 时间未递增；采集已停止".into());
        }
        timestamps.push(timestamp);
    }
    *clock = next;
    Ok((skip, timestamps))
}

impl Drop for Km003cSource {
    fn drop(&mut self) {
        self.stop_queue();
    }
}

/// Keep polls on a fixed grid; after a stall, restart the grid instead of bursting.
fn next_on_grid(due: Instant, period: Duration, now: Instant) -> Instant {
    let next = due + period;
    if next <= now {
        now + period
    } else {
        next
    }
}

/// Averaged V/I (the values the meter itself displays); CC and D± are instantaneous.
fn map_adc(adc: &AdcData) -> DeviceData {
    let temperature = adc.temp_c() as f32;
    DeviceData {
        voltage: adc.vbus_v() as f32,
        current: adc.ibus_a() as f32,
        power: adc.power_w() as f32,
        dp: line_voltage(adc.vdp_v() as f32),
        dn: line_voltage(adc.vdm_v() as f32),
        cc1: adc.vcc1_v() as f32,
        cc2: adc.vcc2_v() as f32,
        temperature: (-40.0..=150.0)
            .contains(&temperature)
            .then_some(temperature),
        ah: None,
        wh: None,
    }
}

fn map_queue(sample: &QueueSample, rate_index: u8) -> DeviceData {
    let aux_scale = if rate_index == 0 { 0.0001 } else { 0.001 };
    let voltage = sample.vbus_uv as f32 / 1_000_000.0;
    let current = sample.ibus_ua as f32 / 1_000_000.0;
    DeviceData {
        voltage,
        current,
        power: voltage * current,
        dp: line_voltage(sample.dp_mv as f32 * aux_scale),
        dn: line_voltage(sample.dm_mv as f32 * aux_scale),
        cc1: sample.cc1_mv as f32 * aux_scale,
        cc2: sample.cc2_mv as f32 * aux_scale,
        temperature: None,
        ah: None,
        wh: None,
    }
}

/// Wrap a sniffed message the way WITRN reports carry PD traffic, so the PD log, the
/// detail decoder and capture files treat both meters alike.
///
/// `None` for an ordered set WITRN reports cannot express, or a message too short (or,
/// in theory, too long) for a 64-byte report.
fn witrn_pd_frame(message: &PdMessage) -> Option<Vec<u8>> {
    let sop = match message.sop {
        Sop::Sop => 224,
        Sop::SopPrime => 192,
        Sop::SopDoublePrime => 160,
        Sop::Unknown(_) => return None,
    };
    let payload = message.payload()?;
    if payload.len() < 2 || payload.len() > witrn_hid::REPORT_LEN - 3 {
        return None;
    }
    let mut frame = vec![0u8; witrn_hid::REPORT_LEN];
    frame[0] = 0xFE;
    frame[1] = (payload.len() + 1) as u8;
    frame[2] = sop;
    frame[3..3 + payload.len()].copy_from_slice(payload);
    Some(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pd_capture::summarize;
    use witrn_hid::{decode_pd_report, Parser};

    fn message(sop: u8, wire: &[u8]) -> PdMessage {
        PdMessage::parse(Sop::from_u8(sop), wire.to_vec())
    }

    #[test]
    fn sniffed_messages_decode_like_witrn_reports() {
        // Source_Capabilities 5 V / 3 A + 9 V / 3 A, then a Request for position 2, both
        // with trailing capture bytes that are not part of the message.
        let caps = [
            0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00, 0xEE, 0xEE,
        ];
        let req = [0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20, 0xEE];
        let mut parser = Parser::new();
        let caps_frame = witrn_pd_frame(&message(0, &caps)).unwrap();
        assert_eq!(caps_frame.len(), witrn_hid::REPORT_LEN);
        assert_eq!(&caps_frame[..3], &[0xFE, 11, 224]);
        let caps_meta = decode_pd_report(&mut parser, &caps_frame).unwrap();
        assert_eq!(summarize(&caps_meta).msg_type, "Source_Capabilities");
        let req_meta =
            decode_pd_report(&mut parser, &witrn_pd_frame(&message(0, &req)).unwrap()).unwrap();
        let summary = summarize(&req_meta);
        assert_eq!(summary.msg_type, "Request");
        assert_eq!(summary.summary, "Position:2 Fixed:9.0V,3.0A");
    }

    #[test]
    fn ordered_sets_map_onto_witrn_encoding() {
        let goodcrc = [0x41, 0x00];
        assert_eq!(witrn_pd_frame(&message(1, &goodcrc)).unwrap()[2], 192);
        assert_eq!(witrn_pd_frame(&message(2, &goodcrc)).unwrap()[2], 160);
        assert!(witrn_pd_frame(&message(7, &goodcrc)).is_none());
        assert!(witrn_pd_frame(&message(0, &[0x41])).is_none());
    }

    #[test]
    fn adc_maps_to_averaged_readings_and_filters_implausible_lines() {
        let mut bytes = vec![0u8; 44];
        bytes[8..12].copy_from_slice(&9_000_000i32.to_le_bytes());
        bytes[12..16].copy_from_slice(&(-2_000_000i32).to_le_bytes());
        bytes[24..26].copy_from_slice(&(25 * 128i16).to_le_bytes());
        bytes[26..28].copy_from_slice(&16_500u16.to_le_bytes());
        bytes[30..32].copy_from_slice(&6_000u16.to_le_bytes());
        let data = map_adc(&AdcData::parse(&bytes).unwrap());
        assert_eq!((data.voltage, data.current, data.power), (9.0, -2.0, -18.0));
        assert_eq!(data.temperature, Some(25.0));
        assert_eq!(data.cc1, 1.65);
        assert_eq!(data.dp, Some(0.6));
        assert_eq!((data.ah, data.wh), (None, None));
        bytes[24..26].copy_from_slice(&(i16::MAX).to_le_bytes());
        assert_eq!(map_adc(&AdcData::parse(&bytes).unwrap()).temperature, None);
    }

    #[test]
    fn polling_keeps_its_grid_and_resynchronises_after_a_stall() {
        let start = Instant::now();
        let period = Duration::from_millis(10);
        assert_eq!(
            next_on_grid(start, period, start + Duration::from_millis(3)),
            start + period
        );
        let late = start + Duration::from_millis(35);
        assert_eq!(next_on_grid(start, period, late), late + period);
    }

    #[test]
    fn device_paths_round_trip_bus_ids_containing_hashes() {
        assert_eq!(parse_location("1-4#12").unwrap(), ("1-4".to_string(), 12));
        assert_eq!(parse_location("a#b#7").unwrap(), ("a#b".to_string(), 7));
        assert!(parse_location("nohash").is_err());
        assert!(parse_location("1#999").is_err());
    }

    #[test]
    fn queue_clock_expands_sequence_and_counts_gaps() {
        let mut clock = QueueClock::default();
        assert_eq!(clock.observe(0xFFFE, 100_000, 3), 100_000);
        assert_eq!(clock.observe(0xFFFF, 101_000, 3), 101_000);
        assert_eq!(clock.observe(0, 102_000, 3), 102_000);
        assert_eq!(clock.take_holes(), 0);
        assert_eq!(clock.observe(4, 105_000, 3), 105_000);
        assert_eq!(clock.take_holes(), 3);
    }

    #[test]
    fn queue_clock_never_places_a_sample_after_host_receive() {
        let mut clock = QueueClock::default();
        assert_eq!(clock.observe(10, 100_000, 3), 100_000);
        assert_eq!(clock.observe(11, 100_500, 3), 100_500);
        assert!(clock.last_us <= 100_500);
    }

    #[test]
    fn queue_clock_catches_up_to_a_slow_device_at_one_ms_per_second() {
        let mut clock = QueueClock::default();
        assert_eq!(clock.observe(0, 0, 3), 0);
        // Six milliseconds of lag is over the correction threshold, but only seven
        // microseconds are allowed for the seven milliseconds of host time elapsed.
        assert_eq!(clock.observe(1, 7_000, 3), 1_007);
        // Even after a full second, the correction budget is one millisecond.
        assert_eq!(clock.observe(2, 1_007_000, 3), 3_007);
    }

    fn queued_sample(sequence: u16) -> QueueSample {
        QueueSample {
            sequence,
            marker: 0x3C,
            vbus_uv: 9_000_000,
            ibus_ua: -2_000_000,
            cc1_mv: 1650,
            cc2_mv: 0,
            dp_mv: 600,
            dm_mv: 0,
        }
    }

    #[test]
    fn queue_replay_prefix_preserves_new_samples_and_sequence_wrap() {
        let recent: VecDeque<_> = [0xFFFE, 0xFFFF, 0].map(queued_sample).into();
        let mut clock = QueueClock::default();
        clock.observe(0, 102_000, 3);
        let samples = [0xFFFF, 0, 1, 2].map(queued_sample);
        let (skip, timestamps) =
            queue_timestamps(&mut clock, &recent, &samples, 104_000, 3).unwrap();
        assert_eq!(skip, 2);
        assert_eq!(timestamps, [103_000, 104_000]);
        assert_eq!(clock.last_seq, Some(2));
        assert_eq!(clock.take_holes(), 0);
    }

    #[test]
    fn fully_replayed_queue_does_not_advance_the_clock() {
        let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
        let mut clock = QueueClock::default();
        clock.observe(11, 100_000, 3);
        let samples = [10, 11].map(queued_sample);
        let (skip, timestamps) =
            queue_timestamps(&mut clock, &recent, &samples, 120_000, 3).unwrap();
        assert_eq!(skip, 2);
        assert!(timestamps.is_empty());
        assert_eq!(clock.last_seq, Some(11));
        assert_eq!(clock.last_us, 100_000);
        assert_eq!(clock.last_observed_us, 100_000);
    }

    #[test]
    fn equal_measurements_with_new_sequences_are_not_replay() {
        let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
        let mut clock = QueueClock::default();
        clock.observe(11, 100_000, 3);
        let samples = [12, 13].map(queued_sample);
        let (skip, timestamps) =
            queue_timestamps(&mut clock, &recent, &samples, 102_000, 3).unwrap();
        assert_eq!(skip, 0);
        assert_eq!(timestamps, [101_000, 102_000]);
    }

    #[test]
    fn replay_must_match_every_wire_field() {
        let mut clock = QueueClock::default();
        clock.observe(11, 100_000, 3);
        let recent: VecDeque<_> = [queued_sample(11)].into();
        let original = queued_sample(11);
        let conflicts = [
            QueueSample {
                marker: 0,
                ..original
            },
            QueueSample {
                vbus_uv: 1,
                ..original
            },
            QueueSample {
                ibus_ua: 1,
                ..original
            },
            QueueSample {
                cc1_mv: 1,
                ..original
            },
            QueueSample {
                cc2_mv: 1,
                ..original
            },
            QueueSample {
                dp_mv: 1,
                ..original
            },
            QueueSample {
                dm_mv: 1,
                ..original
            },
        ];
        for conflict in conflicts {
            assert!(queue_timestamps(&mut clock, &recent, &[conflict], 101_000, 3).is_err());
            assert_eq!(clock.last_seq, Some(11));
            assert_eq!(clock.last_us, 100_000);
        }
    }

    #[test]
    fn unrecognised_reversal_and_invalid_tail_publish_no_clock_changes() {
        let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
        let mut clock = QueueClock::default();
        clock.observe(11, 100_000, 3);
        assert!(queue_timestamps(&mut clock, &recent, &[queued_sample(9)], 101_000, 3).is_err());
        let bad_tail = [12, 11].map(queued_sample);
        assert!(queue_timestamps(&mut clock, &recent, &bad_tail, 102_000, 3).is_err());
        assert_eq!(clock.last_seq, Some(11));
        assert_eq!(clock.last_us, 100_000);
        assert_eq!(clock.last_observed_us, 100_000);
        assert_eq!(clock.take_holes(), 0);
        assert!(queue_timestamps(&mut clock, &recent, &[queued_sample(12)], 99_000, 3).is_err());
        assert_eq!(clock.last_us, 100_000);
    }

    #[test]
    fn replay_does_not_hide_a_gap_in_new_samples() {
        let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
        let mut clock = QueueClock::default();
        clock.observe(11, 100_000, 3);
        let samples = [11, 14].map(queued_sample);
        let (skip, timestamps) =
            queue_timestamps(&mut clock, &recent, &samples, 103_000, 3).unwrap();
        assert_eq!(skip, 1);
        assert_eq!(timestamps, [103_000]);
        assert_eq!(clock.take_holes(), 2);
    }

    #[test]
    fn queue_sample_mapping_keeps_signed_power_and_aux_lines() {
        let sample = QueueSample {
            sequence: 1,
            marker: 0x3C,
            vbus_uv: 9_000_000,
            ibus_ua: -2_000_000,
            cc1_mv: 1650,
            cc2_mv: 0,
            dp_mv: 600,
            dm_mv: 0,
        };
        let data = map_queue(&sample, 3);
        assert_eq!((data.voltage, data.current, data.power), (9.0, -2.0, -18.0));
        assert!((data.cc1 - 1.65).abs() < 1e-6);
        assert_eq!(data.dp, Some(0.6));
    }
}
