mod pd_capture;
mod usb_port;
mod window_material;

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use witrn_hid::{decode_general_sample, decode_pd_report, Parser, ReportKind};

use pd_capture::{now_ms, PdEvent, PdLoadEntry, PdLog};

/// 已知的维简设备型号
#[derive(Clone)]
pub struct KnownDevice {
    pub name: &'static str,
    pub vid: u16,
    pub pid: u16,
}

/// 维简设备的厂商 ID
pub const WITRN_VID: u16 = 0x0716;

/// 支持的维简设备列表
pub const KNOWN_DEVICES: &[KnownDevice] = &[
    KnownDevice {
        name: "WITRN K2",
        vid: WITRN_VID,
        pid: 0x5060,
    },
    KnownDevice {
        name: "WITRN U3",
        vid: WITRN_VID,
        pid: 0x5063,
    },
    // Some U3 firmware/variants report PID 0x5044 (observed in the field).
    KnownDevice {
        name: "WITRN U3",
        vid: WITRN_VID,
        pid: 0x5044,
    },
    // Some C5 firmware/variants report PID 0x5053 (observed in the field).
    KnownDevice {
        name: "WITRN C5",
        vid: WITRN_VID,
        pid: 0x5053,
    },
    KnownDevice {
        name: "WITRN C5",
        vid: WITRN_VID,
        pid: 0x5064,
    },
];

/// 枚举到的设备信息
#[derive(Clone, Serialize, Debug)]
pub struct DeviceInfo {
    pub path: String,
    pub vid: u16,
    pub pid: u16,
    pub serial_number: Option<String>,
    pub usb_port: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub model_name: String,
    pub display_name: String,
    pub interface_number: i32,
    pub usage_page: u16,
}

type PhysicalDeviceKey = (u16, u16, String);

fn physical_device_key(device: &DeviceInfo) -> PhysicalDeviceKey {
    // USB serial on WITRN hardware is a production-batch date, not a unit id.
    // Group by port first so two meters from the same batch stay distinct.
    let discriminator = device
        .usb_port
        .as_deref()
        .filter(|port| !port.is_empty())
        .map(|port| format!("usb:{port}"))
        .or_else(|| {
            device
                .serial_number
                .as_deref()
                .filter(|serial| !serial.is_empty())
                .map(|serial| format!("serial:{serial}"))
        })
        .unwrap_or_default();

    (device.vid, device.pid, discriminator)
}

fn prefer_vendor_defined_interfaces(mut devices: Vec<DeviceInfo>) -> Vec<DeviceInfo> {
    let vendor_defined_groups: HashSet<PhysicalDeviceKey> = devices
        .iter()
        .filter(|device| device.usage_page >= 0xFF00)
        .map(physical_device_key)
        .collect();

    devices.retain(|device| {
        !vendor_defined_groups.contains(&physical_device_key(device)) || device.usage_page >= 0xFF00
    });
    devices
}

fn model_name_for(vid: u16, pid: u16) -> String {
    KNOWN_DEVICES
        .iter()
        .find(|device| device.vid == vid && device.pid == pid)
        .map(|device| device.name.to_string())
        .unwrap_or_else(|| format!("未知 WITRN 设备 ({vid:04X}:{pid:04X})"))
}

fn device_info_from_hid(api: &HidApi, device_info: &HidDeviceInfo) -> DeviceInfo {
    let vid = device_info.vendor_id();
    let pid = device_info.product_id();
    let model_name = model_name_for(vid, pid);
    let usb_port = usb_port::usb_port_for_device(api, device_info);
    let display_name = usb_port::format_device_display_name(&model_name, usb_port.as_deref(), None);

    DeviceInfo {
        path: device_info.path().to_string_lossy().to_string(),
        vid,
        pid,
        serial_number: device_info.serial_number().map(str::to_string),
        usb_port,
        manufacturer: device_info.manufacturer_string().map(str::to_string),
        product: device_info.product_string().map(str::to_string),
        model_name,
        display_name,
        interface_number: device_info.interface_number(),
        usage_page: device_info.usage_page(),
    }
}

fn finalize_device_infos(devices: Vec<DeviceInfo>) -> Vec<DeviceInfo> {
    let mut devices = prefer_vendor_defined_interfaces(devices);
    let mut physical_counts = HashMap::new();
    for device in &devices {
        *physical_counts
            .entry(physical_device_key(device))
            .or_insert(0usize) += 1;
    }

    let mut physical_indices = HashMap::new();
    for device in &mut devices {
        let key = physical_device_key(device);
        let interface_label = if physical_counts.get(&key).copied().unwrap_or(0) > 1 {
            let index = physical_indices.entry(key).or_insert(0usize);
            *index += 1;
            Some(if device.interface_number >= 0 {
                format!(
                    "接口 {} / Usage 0x{:04X}",
                    device.interface_number, device.usage_page
                )
            } else {
                format!("接口 {} / Usage 0x{:04X}", index, device.usage_page)
            })
        } else {
            None
        };

        device.display_name = usb_port::format_device_display_name(
            &device.model_name,
            device.usb_port.as_deref(),
            interface_label.as_deref(),
        );
    }

    devices
}

fn collect_supported_device_infos(api: &HidApi) -> Vec<DeviceInfo> {
    finalize_device_infos(
        api.device_list()
            .filter(|device_info| {
                let vid = device_info.vendor_id();
                let pid = device_info.product_id();
                vid == WITRN_VID
                    || KNOWN_DEVICES
                        .iter()
                        .any(|device| device.vid == vid && device.pid == pid)
            })
            .map(|device_info| device_info_from_hid(api, device_info))
            .collect(),
    )
}

#[derive(Clone, Serialize, Debug, PartialEq)]
struct DeviceData {
    voltage: f32,
    current: f32,
    power: f32,
    dp: Option<f32>,          // D+；越界或缺测为 null，不断整帧
    dn: Option<f32>,          // D-
    cc1: f32,                 // CC1
    cc2: f32,                 // CC2
    temperature: Option<f32>, // 仪表温度；缺失为 null，避免 JSON NaN 丢掉整帧
    ah: f32,                  // 累计容量 Ah
    wh: f32,                  // 累计能量 Wh
}

struct BackgroundTask {
    running: Arc<AtomicBool>,
    /// 先停生产者再停消费者：HID 读线程必须排在发射线程前面。
    joins: Vec<JoinHandle<()>>,
}

impl BackgroundTask {
    fn stop(self) {
        self.running.store(false, Ordering::Relaxed);
        for join in self.joins {
            if join.join().is_err() {
                eprintln!("后台任务线程异常退出");
            }
        }
    }
}

/// HID 读线程 → 发射线程。采样已按间隔节流，发射侧原样送出、不合并。
enum DeviceOutgoing {
    Sample(DeviceData),
    Pd(Box<PdEvent>),
    Disconnected,
}

fn drain_device_outgoing(
    first: DeviceOutgoing,
    rest: impl IntoIterator<Item = DeviceOutgoing>,
) -> (Vec<DeviceData>, Vec<PdEvent>, bool) {
    let mut samples = Vec::new();
    let mut pds = Vec::new();
    let mut disconnected = false;
    let mut take = |msg: DeviceOutgoing| match msg {
        DeviceOutgoing::Sample(sample) => samples.push(sample),
        DeviceOutgoing::Pd(event) => pds.push(*event),
        DeviceOutgoing::Disconnected => disconnected = true,
    };
    take(first);
    for msg in rest {
        take(msg);
    }
    (samples, pds, disconnected)
}

fn emit_device_outgoing(
    app: &AppHandle,
    first: DeviceOutgoing,
    rx: &mpsc::Receiver<DeviceOutgoing>,
) {
    let rest = std::iter::from_fn(|| rx.try_recv().ok());
    let (samples, pds, disconnected) = drain_device_outgoing(first, rest);
    for sample in samples {
        let _ = app.emit("device-data", sample);
    }
    if !pds.is_empty() {
        let _ = app.emit("pd-data-batch", pds);
    }
    if disconnected {
        let _ = app.emit("device-disconnected", ());
    }
}

const PD_IPC_PENDING_CAP: usize = 256;

fn enqueue_pd_pending(pending: &mut VecDeque<PdEvent>, event: PdEvent) {
    if pending.len() >= PD_IPC_PENDING_CAP {
        pending.pop_front();
    }
    pending.push_back(event);
}

/// 把 pending 里的 PD 事件尽量送进通道。发送端已断开时返回 `false`。
fn drain_pd_pending(tx: &mpsc::SyncSender<DeviceOutgoing>, pending: &mut VecDeque<PdEvent>) -> bool {
    while let Some(event) = pending.pop_front() {
        match tx.try_send(DeviceOutgoing::Pd(Box::new(event))) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Disconnected(_)) => return false,
            Err(mpsc::TrySendError::Full(msg)) => {
                if let DeviceOutgoing::Pd(boxed) = msg {
                    pending.push_front(*boxed);
                }
                break;
            }
        }
    }
    true
}

/// 读线程已退出、发送端 drop 之后：先排空通道里残留的采样/PD，再发断开。
/// 若队列里没有 `Disconnected`（例如 `try_send` 失败），仍通知前端。
fn flush_outgoing_on_sender_drop(app: &AppHandle, rx: &mpsc::Receiver<DeviceOutgoing>) {
    let mut remaining = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        remaining.push(msg);
    }
    if !remaining.is_empty() {
        let first = remaining.remove(0);
        let (samples, pds, _disconnected) = drain_device_outgoing(first, remaining);
        for sample in samples {
            let _ = app.emit("device-data", sample);
        }
        if !pds.is_empty() {
            let _ = app.emit("pd-data-batch", pds);
        }
    }
    let _ = app.emit("device-disconnected", ());
}

fn stop_task(slot: &mut Option<BackgroundTask>) {
    if let Some(task) = slot.take() {
        task.stop();
    }
}

pub(crate) struct AppState {
    device_task: Mutex<Option<BackgroundTask>>,
    sample_rate: Arc<AtomicU64>,
    current_device_info: Arc<Mutex<Option<DeviceInfo>>>,
    temp_task: Mutex<Option<BackgroundTask>>,
    pd_log: Arc<Mutex<PdLog>>,
    pd_capture_enabled: Arc<AtomicBool>,
    pub(crate) window_material_available: AtomicBool,
    pub(crate) window_material_enabled: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device_task: Mutex::new(None),
            sample_rate: Arc::new(AtomicU64::new(250)),
            current_device_info: Arc::new(Mutex::new(None)),
            temp_task: Mutex::new(None),
            pd_log: Arc::new(Mutex::new(PdLog::default())),
            // 默认跟随记录且未开始记录：与前端 ingest 门控一致，不入库。
            pd_capture_enabled: Arc::new(AtomicBool::new(false)),
            window_material_available: AtomicBool::new(false),
            window_material_enabled: AtomicBool::new(false),
        }
    }
}

/// 枚举所有已连接的维简设备
#[tauri::command(async)]
fn enumerate_devices() -> Result<Vec<DeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| format!("无法初始化HID API: {}", e))?;
    Ok(collect_supported_device_infos(&api))
}

/// 获取当前连接的设备信息
#[tauri::command]
fn get_current_device_info(state: State<'_, AppState>) -> Option<DeviceInfo> {
    state.current_device_info.lock().unwrap().clone()
}

#[tauri::command(async)]
fn connect_device_by_path(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    connect_device_on_path(path, &state, app)
}

fn connect_device_on_path(
    path: String,
    state: &AppState,
    app: AppHandle,
) -> Result<String, String> {
    let api = HidApi::new().map_err(|e| e.to_string())?;

    let current_info = collect_supported_device_infos(&api)
        .into_iter()
        .find(|device| device.path == path)
        .or_else(|| {
            api.device_list()
                .find(|device| device.path().to_string_lossy() == path)
                .map(|device| device_info_from_hid(&api, device))
        })
        .ok_or("找不到指定设备")?;
    let display_name = current_info.display_name.clone();

    // 先停止并等待上一代读取线程，避免旧线程看到新连接重新置 true 后复活。
    let mut task_slot = state
        .device_task
        .lock()
        .map_err(|_| "设备任务状态已损坏".to_string())?;
    let had_session = task_slot.is_some();
    stop_task(&mut task_slot);

    // 打开设备
    let path_cstr = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = match api.open_path(path_cstr.as_c_str()) {
        Ok(device) => device,
        Err(e) => {
            if had_session {
                if let Ok(mut info) = state.current_device_info.lock() {
                    *info = None;
                }
                let _ = app.emit("device-disconnected", ());
            }
            return Err(format!("无法打开设备: {}", e));
        }
    };

    // Store device info
    {
        let mut info = state.current_device_info.lock().unwrap();
        *info = Some(current_info);
    }

    // 每个连接拥有自己的停止标志；旧连接即使延迟醒来也不会看到新连接的状态。
    let running_arc = Arc::new(AtomicBool::new(true));
    let running_for_thread = Arc::clone(&running_arc);
    let sample_rate_arc = Arc::clone(&state.sample_rate);
    let pd_log_arc = Arc::clone(&state.pd_log);
    let pd_capture_arc = Arc::clone(&state.pd_capture_enabled);
    let device_info_arc = Arc::clone(&state.current_device_info);

    let (tx, rx) = mpsc::sync_channel(8192);
    let emit_app = app.clone();
    let emit_join = thread::spawn(move || loop {
        match rx.recv_timeout(Duration::from_millis(8)) {
            Ok(first) => emit_device_outgoing(&emit_app, first, &rx),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                flush_outgoing_on_sender_drop(&emit_app, &rx);
                break;
            }
        }
    });

    // 读线程只读 HID / 解码 / 入日志 / 入通道，不在这里 emit。
    let read_join = thread::spawn(move || {
        let mut buf = [0u8; 64];
        let mut last_emit: Option<Instant> = None;
        let mut pending: Option<DeviceData> = None;
        let mut pd_pending: VecDeque<PdEvent> = VecDeque::new();
        // 最近一次 0xFF 采样，给 PD 报文盖 V/I；不随监控节流 take() 清掉。
        let mut last_bus: Option<(f32, f32)> = None;
        // PD state belongs to this connection and is discarded with the thread.
        let mut pd_parser = Parser::new();
        let mut last_report_at = Instant::now();
        let mut saw_report = false;

        loop {
            if !running_for_thread.load(Ordering::Relaxed) {
                break;
            }

            if !drain_pd_pending(&tx, &mut pd_pending) {
                break;
            }

            let rate_ms = sample_rate_arc.load(Ordering::Relaxed).max(1);

            // Read from device. We read frequently and *throttle emits* so the UI sample rate works
            // even if the device reports faster.
            let read_timeout_ms = rate_ms.min(20) as i32;
            let maybe_sample = match device.read_timeout(&mut buf, read_timeout_ms) {
                Ok(0) => {
                    // hidapi 超时是 Ok(0)。部分平台拔线也一直超时，不会走 Err。
                    if saw_report && last_report_at.elapsed() >= UNPLUG_IDLE {
                        if running_for_thread.load(Ordering::Relaxed) {
                            if let Ok(mut info) = device_info_arc.lock() {
                                *info = None;
                            }
                            let _ = tx.try_send(DeviceOutgoing::Disconnected);
                        }
                        break;
                    }
                    None
                }
                Ok(read_len) => {
                    last_report_at = Instant::now();
                    saw_report = true;
                    let report = &buf[..read_len.min(buf.len())];
                    match ReportKind::of(report) {
                        Some(ReportKind::General) => parse_device_data(report),
                        Some(ReportKind::Pd) => {
                            // Parser 必须吃到每一帧，否则跟随记录打开时握手丢失，后续 Request 对不上 PDO。
                            match decode_pd_report(&mut pd_parser, report) {
                                Ok(metadata) => {
                                    if pd_capture_arc.load(Ordering::Relaxed) {
                                        let (vbus, ibus) = match last_bus {
                                            Some((v, i)) => (Some(v), Some(i)),
                                            None => (None, None),
                                        };
                                        let event = {
                                            let mut log = pd_log_arc.lock().unwrap();
                                            log.push_message(
                                                now_ms(),
                                                report.to_vec(),
                                                metadata,
                                                vbus,
                                                ibus,
                                            )
                                        };
                                        if let Some(event) = event {
                                            enqueue_pd_pending(&mut pd_pending, event);
                                        }
                                    }
                                }
                                Err(error) => {
                                    eprintln!("PD 报告解析错误: {}", error);
                                }
                            }
                            None
                        }
                        Some(_) | None => None,
                    }
                }
                Err(_) => {
                    if running_for_thread.load(Ordering::Relaxed) {
                        if let Ok(mut info) = device_info_arc.lock() {
                            *info = None;
                        }
                        let _ = tx.try_send(DeviceOutgoing::Disconnected);
                    }
                    break;
                }
            };

            if !running_for_thread.load(Ordering::Relaxed) {
                break;
            }

            if let Some(sample) = maybe_sample {
                last_bus = Some((sample.voltage, sample.current));
                pending = Some(retain_pending_sample(pending.take(), sample));
            }

            let emit_interval = Duration::from_millis(rate_ms);
            let due = last_emit
                .map(|t| t.elapsed() >= emit_interval)
                .unwrap_or(true);
            if pending.is_some() && due {
                let sample = pending.take().unwrap();
                match tx.try_send(DeviceOutgoing::Sample(sample)) {
                    Ok(()) => last_emit = Some(Instant::now()),
                    Err(mpsc::TrySendError::Disconnected(_)) => break,
                    Err(mpsc::TrySendError::Full(msg)) => {
                        if let DeviceOutgoing::Sample(sample) = msg {
                            pending = Some(sample);
                        }
                    }
                }
            }
        }
        let _ = drain_pd_pending(&tx, &mut pd_pending);
        if let Some(sample) = pending.take() {
            let _ = tx.try_send(DeviceOutgoing::Sample(sample));
        }
        // device dropped here, HID connection closed cleanly
        running_for_thread.store(false, Ordering::Relaxed);
    });

    task_slot.replace(BackgroundTask {
        running: Arc::clone(&running_arc),
        joins: vec![read_join, emit_join],
    });

    Ok(format!("已连接: {}", display_name))
}

#[tauri::command(async)]
fn disconnect_device(state: State<'_, AppState>) -> Result<String, String> {
    let mut task_slot = state
        .device_task
        .lock()
        .map_err(|_| "设备任务状态已损坏".to_string())?;
    stop_task(&mut task_slot);

    // Clear device info immediately
    {
        let mut info = state.current_device_info.lock().unwrap();
        *info = None;
    }

    Ok("设备已断开".to_string())
}

#[tauri::command]
fn set_pd_capture_enabled(enabled: bool, state: State<'_, AppState>) {
    state.pd_capture_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn pd_log_clear(state: State<'_, AppState>) -> Result<u64, String> {
    Ok(state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())?
        .clear())
}

#[tauri::command]
fn decode_pd_at(index: u64, state: State<'_, AppState>) -> Result<witrn_hid::Metadata, String> {
    let log = state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())?;
    log.meta_at(index as usize)
        .cloned()
        .ok_or_else(|| "没有这条报文的解码树".to_string())
}

#[tauri::command(async)]
fn pd_log_replace(
    entries: Vec<PdLoadEntry>,
    state: State<'_, AppState>,
) -> Result<Vec<PdEvent>, String> {
    let (next, events) = PdLog::build(entries)?;
    let mut log = state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())?;
    Ok(log.install(next, events))
}

#[tauri::command]
fn set_sample_rate(rate: u64, state: State<'_, AppState>) -> Result<(), String> {
    if !(10..=60_000).contains(&rate) {
        return Err("采样间隔必须在 10 到 60000 毫秒之间".to_string());
    }
    state.sample_rate.store(rate, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn pd_log_after(
    after_seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<PdEvent>, String> {
    state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())
        .map(|log| log.events_after(after_seq))
}

/// 退出流程的唯一入口：先停后台任务，再强制销毁主窗口。
///
/// 必须用 `destroy` 而不是 `close`——`close` 会重新派发 close-requested 事件，
/// 与前端的退出确认监听器构成回环，窗口反而关不掉（Tauri v2 起的行为变更）。
///
/// 标为 `async` 交由 Tauri 的工作线程调度：`stop_task` 会 join 后台线程，
/// 而这些线程退出前可能仍在 `emit`（需要主线程处理），在主线程上阻塞等待会死锁。
#[tauri::command(async)]
fn shutdown(state: State<'_, AppState>, app: AppHandle) {
    if let Ok(mut task) = state.device_task.lock() {
        stop_task(&mut task);
    }
    if let Ok(mut task) = state.temp_task.lock() {
        stop_task(&mut task);
    }

    match app.get_webview_window("main") {
        Some(window) => {
            if let Err(e) = window.destroy() {
                eprintln!("销毁主窗口失败，回退为进程退出: {}", e);
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// 连接温度服务
#[tauri::command(async)]
fn connect_temp_service(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    {
        let mut task_slot = state
            .temp_task
            .lock()
            .map_err(|_| "温度任务状态已损坏".to_string())?;
        stop_task(&mut task_slot);
    }

    let addr = format!("{ip}:{port}");
    let mut addrs: Vec<_> = (ip.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("无效地址: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("无法解析地址 {addr}"));
    }
    addrs.sort_by_key(|socket| u8::from(socket.is_ipv6()));

    let mut last_error = None;
    let mut stream = None;
    for socket in addrs {
        match TcpStream::connect_timeout(&socket, Duration::from_secs(5)) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let stream = stream.ok_or_else(|| {
        format!(
            "连接失败: {}",
            last_error
                .map(|e| e.to_string())
                .unwrap_or_else(|| "无可用地址".to_string())
        )
    })?;

    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| format!("设置超时失败: {}", e))?;

    let mut task_slot = state
        .temp_task
        .lock()
        .map_err(|_| "温度任务状态已损坏".to_string())?;
    stop_task(&mut task_slot);

    // 启动接收线程
    let running = Arc::new(AtomicBool::new(true));
    let running_for_thread = Arc::clone(&running);

    let join = thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            if !running_for_thread.load(Ordering::Relaxed) {
                break;
            }
            // 读超时会带着已读到的半行数据返回 Err，因此只在整行处理完之后才清空缓冲，
            // 让下一轮把剩余部分续上——每轮开头就清会把半行丢掉，剩下的半行成为坏数据。
            match reader.read_line(&mut line) {
                Ok(0) => {
                    if running_for_thread.load(Ordering::Relaxed) {
                        let _ = app.emit("temp-disconnected", ());
                    }
                    break;
                }
                Ok(_) => {
                    if line.len() > 256 {
                        line.clear();
                    } else {
                        let trimmed = line.trim();
                        if let Ok(temp) = trimmed.parse::<f32>() {
                            if temp.is_finite() {
                                let _ = app.emit("temp-data", temp);
                            }
                        }
                        line.clear();
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    if line.len() > 256 {
                        line.clear();
                    }
                    continue;
                }
                Err(e) => {
                    if running_for_thread.load(Ordering::Relaxed) {
                        eprintln!("温度读取错误: {}", e);
                        let _ = app.emit("temp-disconnected", ());
                    }
                    break;
                }
            }
        }
        running_for_thread.store(false, Ordering::Relaxed);
    });
    task_slot.replace(BackgroundTask {
        running,
        joins: vec![join],
    });

    Ok(format!("已连接到温度服务 {}", addr))
}

/// 断开温度服务
#[tauri::command(async)]
fn disconnect_temp_service(state: State<'_, AppState>) -> Result<String, String> {
    let mut task_slot = state
        .temp_task
        .lock()
        .map_err(|_| "温度任务状态已损坏".to_string())?;
    stop_task(&mut task_slot);
    Ok("已断开温度服务连接".to_string())
}

/// 连续超时超过此时长且曾经读到过报告，视为拔线。
const UNPLUG_IDLE: Duration = Duration::from_secs(2);

fn retain_pending_sample(pending: Option<DeviceData>, sample: DeviceData) -> DeviceData {
    match pending {
        Some(prev) if prev.current.abs() > sample.current.abs() => prev,
        _ => sample,
    }
}

fn line_voltage(value: f32) -> Option<f32> {
    (0.0..=60.0).contains(&value).then_some(value)
}

fn parse_device_data(buf: &[u8]) -> Option<DeviceData> {
    let sample = decode_general_sample(buf).ok()?;
    Some(DeviceData {
        voltage: sample.voltage,
        current: sample.current,
        power: sample.power,
        dp: line_voltage(sample.dp),
        dn: line_voltage(sample.dn),
        cc1: sample.cc1,
        cc2: sample.cc2,
        temperature: sample.temperature,
        ah: sample.ah,
        wh: sample.wh,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_decorum::init())
        .manage(AppState::default())
        .setup(|app| {
            // 自定义标题栏：Windows 由 decorum 注入带贴靠布局浮窗的窗口控制按钮
            // （前端按设计令牌重绘，并用内置 Fluent SVG 替换 Segoe 字形以免 Win10 缺字）；
            // Linux 无此支持，改由前端 windowcontrols.js 自绘按钮与边缘调整大小热区。
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use tauri_plugin_decorum::WebviewWindowExt;
                let main_window = app
                    .get_webview_window("main")
                    .expect("main window must exist");
                main_window
                    .create_overlay_titlebar()
                    .expect("failed to create overlay titlebar");
                // 默认尝试 Mica（Win10 / 远程桌面会失败，前端保持不透明底色）
                let state = app.state::<AppState>();
                window_material::try_enable_on_setup(&main_window, &state, true);
            }
            #[cfg(not(target_os = "windows"))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_device_by_path,
            disconnect_device,
            set_sample_rate,
            shutdown,
            enumerate_devices,
            get_current_device_info,
            connect_temp_service,
            disconnect_temp_service,
            set_pd_capture_enabled,
            pd_log_clear,
            decode_pd_at,
            pd_log_after,
            pd_log_replace,
            window_material::get_window_material,
            window_material::set_window_material_theme,
            window_material::set_window_material_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_frame() -> [u8; 64] {
        let mut frame = [0u8; 64];
        frame[0] = 0xFF;
        frame[14..18].copy_from_slice(&1.25f32.to_le_bytes());
        frame[18..22].copy_from_slice(&4.5f32.to_le_bytes());
        frame[30..34].copy_from_slice(&1.2f32.to_le_bytes());
        frame[34..38].copy_from_slice(&1.1f32.to_le_bytes());
        frame[42..46].copy_from_slice(&23.5f32.to_le_bytes());
        frame[46..50].copy_from_slice(&5.0f32.to_le_bytes());
        frame[50..54].copy_from_slice(&2.0f32.to_le_bytes());
        frame[55] = 50;
        frame[56] = 90;
        frame
    }

    fn device_info(path: &str, interface_number: i32, usage_page: u16) -> DeviceInfo {
        DeviceInfo {
            path: path.to_string(),
            vid: 0x0716,
            pid: 0x5060,
            serial_number: Some("test-device".to_string()),
            usb_port: Some("4-4".to_string()),
            manufacturer: Some("WITRN".to_string()),
            product: Some("K2".to_string()),
            model_name: "WITRN K2".to_string(),
            display_name: "WITRN K2 (USB 4-4)".to_string(),
            interface_number,
            usage_page,
        }
    }

    #[test]
    fn known_pids_map_to_model_names() {
        assert_eq!(model_name_for(WITRN_VID, 0x5060), "WITRN K2");
        assert_eq!(model_name_for(WITRN_VID, 0x5063), "WITRN U3");
        assert_eq!(model_name_for(WITRN_VID, 0x5044), "WITRN U3");
        assert_eq!(model_name_for(WITRN_VID, 0x5053), "WITRN C5");
        assert_eq!(model_name_for(WITRN_VID, 0x5064), "WITRN C5");
        assert_eq!(
            model_name_for(WITRN_VID, 0x50FF),
            "未知 WITRN 设备 (0716:50FF)"
        );
    }

    #[test]
    fn drain_keeps_every_sample_and_pd_event() {
        let sample = |voltage: f32| DeviceData {
            voltage,
            current: 1.0,
            power: voltage,
            dp: None,
            dn: None,
            cc1: 0.0,
            cc2: 0.0,
            temperature: None,
            ah: 0.0,
            wh: 0.0,
        };
        let pd = |t: u64| PdEvent::divider(t);
        let (samples, pds, disconnected) = drain_device_outgoing(
            DeviceOutgoing::Sample(sample(5.0)),
            [
                DeviceOutgoing::Pd(Box::new(pd(1))),
                DeviceOutgoing::Sample(sample(9.0)),
                DeviceOutgoing::Pd(Box::new(pd(2))),
                DeviceOutgoing::Disconnected,
            ],
        );
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].voltage, 5.0);
        assert_eq!(samples[1].voltage, 9.0);
        assert_eq!(pds.len(), 2);
        assert!(disconnected);
    }

    #[test]
    fn parses_valid_frame_at_protocol_offsets() {
        let data = parse_device_data(&valid_frame()).expect("valid frame should parse");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.current, 2.0);
        assert_eq!(data.power, 10.0);
        assert_eq!(data.temperature, Some(23.5));
        assert_eq!(data.cc1, 5.0);
        assert_eq!(data.cc2, 9.0);
    }

    #[test]
    fn rejects_wrong_header_and_non_finite_values() {
        let mut frame = valid_frame();
        frame[0] = 0;
        assert!(parse_device_data(&frame).is_none());

        let mut frame = valid_frame();
        frame[46..50].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());
    }

    #[test]
    fn rejects_out_of_range_measurements() {
        let mut frame = valid_frame();
        frame[46..50].copy_from_slice(&60.1f32.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());

        let mut frame = valid_frame();
        frame[50..54].copy_from_slice(&10.1f32.to_le_bytes());
        assert!(
            parse_device_data(&frame).is_some(),
            "10.1 A overshoot should still parse"
        );

        let mut frame = valid_frame();
        frame[50..54].copy_from_slice(&20.1f32.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());
    }

    #[test]
    fn throttle_keeps_the_higher_current_sample() {
        let mild = DeviceData {
            voltage: 5.0,
            current: 0.2,
            power: 1.0,
            dp: None,
            dn: None,
            cc1: 0.0,
            cc2: 0.0,
            temperature: None,
            ah: 0.0,
            wh: 0.0,
        };
        let spike = DeviceData {
            current: 3.5,
            power: 17.5,
            ..mild.clone()
        };
        let kept = retain_pending_sample(Some(mild.clone()), spike.clone());
        assert_eq!(kept.current, 3.5);
        let kept = retain_pending_sample(Some(spike.clone()), mild);
        assert_eq!(kept.current, 3.5);
    }

    #[test]
    fn keeps_frame_but_drops_temperature_when_out_of_range() {
        let mut frame = valid_frame();
        frame[42..46].copy_from_slice(&150.1f32.to_le_bytes());

        let data = parse_device_data(&frame).expect("越界温度不应丢掉整帧");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.temperature, None);
        let json = serde_json::to_string(&data).expect("缺失温度必须能进 JSON");
        assert!(
            json.contains("\"temperature\":null"),
            "temperature must serialize as null, got {json}"
        );
    }

    #[test]
    fn drops_out_of_range_data_lines_without_rejecting_the_frame() {
        let mut frame = valid_frame();
        frame[30..34].copy_from_slice(&1e20f32.to_le_bytes());
        let data = parse_device_data(&frame).expect("越界 D+ 不应丢掉整帧");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.dp, None);
    }

    #[test]
    fn prefers_vendor_defined_hid_interface_for_same_physical_device() {
        let devices = vec![
            device_info("keyboard", 0, 0x0001),
            device_info("data", 1, 0xFF00),
        ];

        let filtered = prefer_vendor_defined_interfaces(devices);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].path, "data");
    }

    #[test]
    fn keeps_same_batch_meters_on_different_ports_separate() {
        let mut left = device_info("left", 1, 0xFF00);
        left.usb_port = Some("4-4".to_string());
        let mut right = device_info("right", 1, 0xFF00);
        right.path = "right".to_string();
        right.usb_port = Some("4-5".to_string());

        let filtered = prefer_vendor_defined_interfaces(vec![left, right]);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn uses_usb_port_to_group_devices_without_serial_numbers() {
        let mut keyboard = device_info("keyboard", 0, 0x0001);
        keyboard.serial_number = None;
        keyboard.usb_port = Some("4-4".to_string());

        let mut data = device_info("data", 1, 0xFF00);
        data.serial_number = None;
        data.usb_port = Some("4-5".to_string());

        let filtered = prefer_vendor_defined_interfaces(vec![keyboard, data]);
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn keeps_usb_name_when_adding_multiple_interface_suffixes() {
        let devices = finalize_device_infos(vec![
            device_info("data-0", 0, 0xFF00),
            device_info("data-1", 1, 0xFF01),
        ]);

        assert_eq!(
            devices[0].display_name,
            "WITRN K2 (USB 4-4) [接口 0 / Usage 0xFF00]"
        );
        assert_eq!(
            devices[1].display_name,
            "WITRN K2 (USB 4-4) [接口 1 / Usage 0xFF01]"
        );
    }
}
