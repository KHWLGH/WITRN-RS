mod acquire;
mod app_error;
mod app_nap;
mod locale;
// Public so  can read the file it writes without duplicating the layout.
pub mod boot_timing;
mod file_io;
mod km003c_session;
mod pd_capture;
// Public only so `cargo bench` can drive the emit path; the app itself never re-exports it.
pub mod stream;
mod usb_port;
#[cfg(target_os = "windows")]
mod windows_icon;

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::net::ToSocketAddrs;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use witrn_hid::{decode_general_sample, ReportKind};

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

/// 设备家族：决定采集源、是否提供协议控制
#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceFamily {
    Witrn,
    Km003c,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) model_description: Option<app_error::AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) interface_description: Option<app_error::AppError>,
    pub interface_number: i32,
    pub usage_page: u16,
    pub family: DeviceFamily,
    /// 支持协议触发（PDM / PD 请求 / 快充触发）
    pub controls: bool,
    /// 设备能提供的最高采样率（次/秒）
    pub max_rate_hz: u32,
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
        .unwrap_or_else(|| format!("Unknown WITRN device ({vid:04X}:{pid:04X})"))
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
        model_description: (!KNOWN_DEVICES
            .iter()
            .any(|device| device.vid == vid && device.pid == pid))
        .then(|| {
            app_error::AppError::message(
                "unknownWitrnDevice",
                [("vid", format!("{vid:04X}")), ("pid", format!("{pid:04X}"))],
            )
        }),
        interface_description: None,
        interface_number: device_info.interface_number(),
        usage_page: device_info.usage_page(),
        family: DeviceFamily::Witrn,
        controls: false,
        max_rate_hz: 100,
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
            let interface = if device.interface_number >= 0 {
                device.interface_number.to_string()
            } else {
                index.to_string()
            };
            device.interface_description = Some(app_error::AppError::message(
                "deviceInterface",
                [
                    ("index", interface),
                    ("usage", format!("{:04X}", device.usage_page)),
                ],
            ));
            Some(if device.interface_number >= 0 {
                format!(
                    "Interface {} / Usage 0x{:04X}",
                    device.interface_number, device.usage_page
                )
            } else {
                format!("Interface {} / Usage 0x{:04X}", index, device.usage_page)
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
    ah: Option<f32>,          // 仪表累计容量 Ah；没有累加器的设备为 null
    wh: Option<f32>,          // 仪表累计能量 Wh
}

struct DeviceSession {
    generation: u64,
    controls: mpsc::SyncSender<stream::Control>,
    produced: Arc<AtomicU64>,
    consumed: Arc<AtomicU64>,
    end: Arc<Mutex<Option<stream::End>>>,
}

struct BackgroundTask {
    running: Arc<AtomicBool>,
    /// Producer precedes emitter; commands joining these always run off the UI thread.
    joins: Vec<JoinHandle<()>>,
    session: Option<DeviceSession>,
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

use stream::Outgoing as DeviceOutgoing;

fn emit_device_outgoing(
    app: &AppHandle,
    samples: &[stream::Sample],
    pds: &[PdEvent],
    end: Option<&stream::End>,
) -> Result<(), String> {
    if !samples.is_empty() {
        app.emit("device-data-batch", samples)
            .map_err(|e| e.to_string())?;
    }
    if !pds.is_empty() {
        app.emit("pd-data-batch", pds).map_err(|e| e.to_string())?;
    }
    if let Some(end) = end {
        let payload = serde_json::json!({
            "generation": end.generation, "last_seq": end.last_seq, "error": end.error,
            "description": end.error.as_ref().map(|detail| app_error::AppError::new("streamStopped", detail.clone()))
        });
        if end.error.is_some() {
            app.emit("stream-error", &payload)
                .map_err(|e| e.to_string())?;
        }
        app.emit("device-stream-end", &payload)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

const PD_IPC_PENDING_CAP: usize = 256;

fn enqueue_pd_pending(pending: &mut VecDeque<PdEvent>, event: PdEvent) {
    if pending.len() >= PD_IPC_PENDING_CAP {
        pending.pop_front();
    }
    pending.push_back(event);
}

/// 把 pending 里的 PD 事件尽量送进通道。发送端已断开时返回 `false`。
fn drain_pd_pending(
    tx: &mpsc::SyncSender<DeviceOutgoing>,
    pending: &mut VecDeque<PdEvent>,
) -> bool {
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

/// Keep the stopped session until its final seq has been acknowledged.
fn drain_device_task(task: &mut BackgroundTask) -> Result<Option<stream::End>, String> {
    task.running.store(false, Ordering::Release);
    for join in task.joins.drain(..) {
        join.join().map_err(|_| "device worker panicked")?;
    }
    match &task.session {
        Some(session) => Ok(session
            .end
            .lock()
            .map_err(|_| "stream end state poisoned")?
            .clone()),
        None => Ok(None),
    }
}

fn stop_task(slot: &mut Option<BackgroundTask>) {
    if let Some(task) = slot.take() {
        task.stop();
    }
}

/// 终态逃生口的前半段：校验并取回末包回执，不动 `consumed`。
///
/// 与 `drain_device_task` 分开放，是为了让 `shutdown` 的严格校验一字不改地继续守着
/// 正常路径。走到这里的生产端已经停止、线程已 join、`end` 已定稿，屏障保护的样本
/// 不会再出现；此时只剩「放行销毁」与「整个进程再也退不出去」两个选项。
/// 这里绝不写 `consumed`——空洞仍然是未消费。
fn abandon_device_task(
    task: &mut BackgroundTask,
    generation: u64,
) -> Result<Option<stream::End>, String> {
    if task.running.load(Ordering::Acquire) {
        return Err("cannot abandon a running stream".into());
    }
    if !task.joins.is_empty() {
        return Err("drain_device_stream must complete before abandon_device_stream".into());
    }
    let Some(session) = task.session.as_ref() else {
        return Ok(None);
    };
    if session.generation != generation {
        return Err("stale stream generation".into());
    }
    let end = session
        .end
        .lock()
        .map_err(|_| "stream end state poisoned")?
        .clone()
        .ok_or("no stream end receipt to abandon")?;
    Ok(Some(end))
}

pub(crate) struct AppState {
    device_task: Mutex<Option<BackgroundTask>>,
    generation: AtomicU64,
    sample_rate: Arc<AtomicU64>,
    current_device_info: Arc<Mutex<Option<DeviceInfo>>>,
    temp_task: Mutex<Option<BackgroundTask>>,
    pd_log: Arc<Mutex<PdLog>>,
    pd_capture_enabled: Arc<AtomicBool>,
    /// 当前 POWER-Z 会话的协议控制句柄；与设备槽分开加锁，排空流时不阻塞取消。
    km003c: Mutex<Option<km003c_session::Km003cControl>>,
    /// CSV 导入 / 导出 / 临时恢复文件的文件句柄。
    files: Mutex<file_io::FileRegistry>,
    /// 末包已校验、进入销毁流程：置位后禁止新建连接，退出事件放行。
    shutting_down: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device_task: Mutex::new(None),
            generation: AtomicU64::new(0),
            sample_rate: Arc::new(AtomicU64::new(250)),
            current_device_info: Arc::new(Mutex::new(None)),
            temp_task: Mutex::new(None),
            pd_log: Arc::new(Mutex::new(PdLog::default())),
            // 默认跟随记录且未开始记录：与前端 ingest 门控一致，不入库。
            pd_capture_enabled: Arc::new(AtomicBool::new(false)),
            km003c: Mutex::new(None),
            files: Mutex::new(file_io::FileRegistry::default()),
            shutting_down: AtomicBool::new(false),
        }
    }
}

/// 返回原生运行平台，不依赖 WebView 的 UA 或窗口样式。
#[tauri::command]
fn get_runtime_platform() -> &'static str {
    std::env::consts::OS
}

/// Return the locale selected by the host environment. The frontend applies
/// the language mapping and browser fallback so this command stays read-only.
#[tauri::command]
fn get_system_locale() -> String {
    locale::system_locale()
}

/// 枚举所有已连接的设备：维简 HID 仪表与 POWER-Z KM003C / KM002C
#[tauri::command(async)]
fn enumerate_devices() -> Result<Vec<DeviceInfo>, crate::app_error::AppError> {
    let result: Result<Vec<DeviceInfo>, String> = (|| {
        let api = HidApi::new().map_err(|e| format!("无法初始化HID API: {}", e))?;
        let mut devices = collect_supported_device_infos(&api);
        devices.extend(km003c_session::device_infos());
        Ok(devices)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("hidInitFailed", detail))
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
) -> Result<stream::Open, crate::app_error::AppError> {
    let result: Result<stream::Open, String> = connect_device_on_path(path, &state, app);
    result.map_err(|detail| crate::app_error::AppError::new("deviceConnectionFailed", detail))
}

fn connect_device_on_path(
    path: String,
    state: &AppState,
    app: AppHandle,
) -> Result<stream::Open, String> {
    if let Some(location) = path.strip_prefix(km003c_session::PATH_PREFIX) {
        return km003c_session::connect(&path, location, state, app);
    }
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
    let (mut task_slot, had_session) = claim_device_slot(state)?;

    // 与 USB 端口枚举共用非独占打开策略。
    let path_cstr = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = match usb_port::open_device_nonexclusive(&api, path_cstr.as_c_str()) {
        Ok(device) => device,
        Err(e) => {
            report_open_failure(state, &app, had_session);
            return Err(format!("无法打开设备: {}", e));
        }
    };
    // 维简仪表没有写通路，不提供协议控制。
    if let Ok(mut control) = state.km003c.lock() {
        *control = None;
    }
    Ok(launch_stream(
        state,
        app,
        &mut task_slot,
        current_info,
        |seed| (HidSource::new(device, seed.epoch), Vec::new()),
    ))
}

/// 为新连接占用设备槽：退出中拒绝；旧代还有未消费的已选点时拒绝退休它。
///
/// 返回持有中的设备槽锁，以及之前是否存在会话（打开失败时据此通知前端断开）。
fn claim_device_slot(
    state: &AppState,
) -> Result<(std::sync::MutexGuard<'_, Option<BackgroundTask>>, bool), String> {
    // Reconnect cannot retire a generation with unconsumed selected data.
    let mut task_slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
    if state.shutting_down.load(Ordering::Acquire) {
        return Err("app is shutting down".into());
    }
    if let Some(task) = task_slot.as_mut() {
        let end = drain_device_task(task)?.ok_or("missing stream end receipt")?;
        let session = task.session.as_ref().ok_or("missing stream session")?;
        if session.consumed.load(Ordering::Acquire) != end.last_seq {
            return Err("consume and acknowledge old generation before reconnecting".into());
        }
    }
    let had_session = task_slot.is_some();
    stop_task(&mut task_slot);
    Ok((task_slot, had_session))
}

/// 旧会话已退休、新设备却打不开：前端仍以为连着，必须告诉它断开了。
fn report_open_failure(state: &AppState, app: &AppHandle, had_session: bool) {
    if had_session {
        if let Ok(mut info) = state.current_device_info.lock() {
            *info = None;
        }
        let _ = app.emit("device-disconnected", ());
    }
}

/// 新会话的身份与时钟，在构造采集源之前确定。
pub(crate) struct SessionSeed {
    pub generation: u64,
    pub epoch: Instant,
    /// 会话存活标志；读线程、发射线程与附属线程共用。
    pub running: Arc<AtomicBool>,
}

/// 为已打开的设备启动发射线程与读线程，并装入设备槽。
///
/// `build` 在分配 generation 之后构造采集源，可以顺带启动附属线程；附属线程排在
/// 读线程与发射线程之后 join，停止条件同样是 `running`。
fn launch_stream<S, F>(
    state: &AppState,
    app: AppHandle,
    task_slot: &mut Option<BackgroundTask>,
    info: DeviceInfo,
    build: F,
) -> stream::Open
where
    S: acquire::Source + 'static,
    F: FnOnce(&SessionSeed) -> (S, Vec<JoinHandle<()>>),
{
    if let Ok(mut current) = state.current_device_info.lock() {
        *current = Some(info);
    }

    // 每个连接拥有自己的停止标志；旧连接即使延迟醒来也不会看到新连接的状态。
    let running_arc = Arc::new(AtomicBool::new(true));
    let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
    let epoch = Instant::now();
    let wall_anchor_ms = now_ms();
    let seed = SessionSeed {
        generation,
        epoch,
        running: Arc::clone(&running_arc),
    };
    let (source, extra_joins) = build(&seed);

    let (tx, rx) = mpsc::sync_channel(stream::CHANNEL_CAP);
    let (controls, control_rx) = mpsc::sync_channel(64);
    let produced = Arc::new(AtomicU64::new(0));
    let consumed = Arc::new(AtomicU64::new(0));
    let end = Arc::new(Mutex::new(None));
    let emit_app = app.clone();
    let emit_rate_arc = Arc::clone(&state.sample_rate);
    let emit_running = Arc::clone(&running_arc);
    let emit_join = thread::spawn(move || {
        let result = emit_app
            .emit(
                "device-stream-open",
                stream::Open {
                    generation,
                    wall_anchor_ms,
                },
            )
            .map_err(|e| e.to_string())
            .and_then(|()| {
                stream::emit_loop(
                    rx,
                    || {
                        Duration::from_millis(stream::batch_window_ms(
                            emit_rate_arc.load(Ordering::Relaxed),
                        ))
                    },
                    |samples, pds, end| emit_device_outgoing(&emit_app, samples, pds, end),
                )
            });
        if let Err(error) = result {
            emit_running.store(false, Ordering::Release);
            let _ = emit_app.emit(
                "stream-error",
                serde_json::json!({ "generation": generation, "last_seq": 0, "error": error,
                    "description": app_error::AppError::new("streamStopped", error.clone()) }),
            );
        }
    });

    // Only the read thread changes segment/rate, always between device reads.
    let ctx = acquire::ReaderCtx {
        generation,
        epoch,
        wall_anchor_ms,
        running: Arc::clone(&running_arc),
        sample_rate: Arc::clone(&state.sample_rate),
        pd_log: Arc::clone(&state.pd_log),
        pd_capture: Arc::clone(&state.pd_capture_enabled),
        device_info: Arc::clone(&state.current_device_info),
        tx,
        controls: control_rx,
        produced: Arc::clone(&produced),
        consumed: Arc::clone(&consumed),
        end: Arc::clone(&end),
    };
    let read_join = thread::spawn(move || acquire::run_reader(source, ctx));

    let mut joins = vec![read_join, emit_join];
    joins.extend(extra_joins);
    task_slot.replace(BackgroundTask {
        running: running_arc,
        joins,
        session: Some(DeviceSession {
            generation,
            controls,
            produced,
            consumed,
            end,
        }),
    });

    stream::Open {
        generation,
        wall_anchor_ms,
    }
}

#[tauri::command(async)]
fn disconnect_device(
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    drain_device_stream(generation, state)
}

#[tauri::command(async)]
fn drain_device_stream(
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    let result: Result<Option<stream::End>, String> = (|| {
        let mut slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        // A stale drain from an old connection must never stop the newer session.
        let stale = slot
            .as_ref()
            .and_then(|task| task.session.as_ref())
            .is_some_and(|session| generation.is_some_and(|g| session.generation != g));
        if stale {
            return Ok(None);
        }
        let result = slot.as_mut().map(drain_device_task).transpose()?.flatten();
        *state
            .current_device_info
            .lock()
            .map_err(|_| "设备信息状态已损坏")? = None;
        Ok(result)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// 退休一个终态会话：让已经死掉的连接不再把「断开 / 重连 / 退出」全部锁死。
///
/// 只接受已经停止且已有末包回执的会话，并且不改写 `consumed`，所以空洞依旧算未消费。
/// `shutdown` 的校验保持原样——放宽只发生在这条显式路径上。
#[tauri::command(async)]
fn abandon_device_stream(
    generation: u64,
    state: State<'_, AppState>,
) -> Result<Option<stream::End>, crate::app_error::AppError> {
    let result: Result<Option<stream::End>, String> = (|| {
        let mut slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        let Some(task) = slot.as_mut() else {
            return Ok(None);
        };
        let end = abandon_device_task(task, generation)?;
        slot.take();
        Ok(end)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
fn set_recording_segment(
    generation: u64,
    segment: u64,
    pd_enabled: bool,
    state: State<'_, AppState>,
) -> Result<stream::Boundary, crate::app_error::AppError> {
    let result: Result<stream::Boundary, String> = (|| {
        let (reply, rx) = mpsc::channel();
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            let task = slot.as_ref().ok_or("device is not connected")?;
            let session = task.session.as_ref().ok_or("no stream session")?;
            if session.generation != generation || !task.running.load(Ordering::Acquire) {
                return Err("stale or stopped stream generation".into());
            }
            session
                .controls
                .try_send(stream::Control::Segment {
                    segment,
                    pd_enabled,
                    reply,
                })
                .map_err(|e| format!("recording control unavailable: {e}"))?;
        }
        // No timeout: an indeterminate timed-out start must never silently activate later.
        rx.recv()
            .map_err(|_| "device stopped before recording boundary".to_string())?
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
fn ack_device_stream(
    generation: u64,
    seq: u64,
    state: State<'_, AppState>,
) -> Result<(), crate::app_error::AppError> {
    let result: Result<(), String> = (|| {
        let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
        let session = slot
            .as_ref()
            .and_then(|task| task.session.as_ref())
            .ok_or("no stream session")?;
        if session.generation != generation {
            return Err("stale stream acknowledgment".into());
        }
        if seq > session.produced.load(Ordering::Acquire) {
            return Err("ack beyond selected seq".into());
        }
        session.consumed.fetch_max(seq, Ordering::Release);
        Ok(())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command]
fn set_pd_capture_enabled(enabled: bool, state: State<'_, AppState>) {
    state.pd_capture_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn pd_log_clear(state: State<'_, AppState>) -> Result<u64, crate::app_error::AppError> {
    let result: Result<u64, String> = (|| {
        Ok(state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?
            .clear())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command]
fn decode_pd_at(
    index: u64,
    state: State<'_, AppState>,
) -> Result<witrn_hid::Metadata, crate::app_error::AppError> {
    let result: Result<witrn_hid::Metadata, String> = (|| {
        let log = state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?;
        log.meta_at(index as usize)
            .cloned()
            .ok_or_else(|| "没有这条报文的解码树".to_string())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("decodeFailed", detail))
}

#[tauri::command(async)]
fn pd_log_replace(
    entries: Vec<PdLoadEntry>,
    state: State<'_, AppState>,
) -> Result<Vec<PdEvent>, crate::app_error::AppError> {
    let result: Result<Vec<PdEvent>, String> = (|| {
        let (next, events) = PdLog::build(entries)?;
        let mut log = state
            .pd_log
            .lock()
            .map_err(|_| "PD 日志状态已损坏".to_string())?;
        Ok(log.install(next, events))
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command(async)]
fn set_sample_rate(
    rate: u64,
    generation: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Option<stream::Boundary>, crate::app_error::AppError> {
    let result: Result<Option<stream::Boundary>, String> = (|| {
        if !(1..=60_000).contains(&rate) {
            return Err("采样间隔必须在 1 到 60000 毫秒之间".to_string());
        }
        let minimum = state
            .current_device_info
            .lock()
            .map_err(|_| "设备信息状态已损坏")?
            .as_ref()
            .map_or(1, |info| {
                if info.family == DeviceFamily::Witrn {
                    10
                } else {
                    1
                }
            });
        if rate < minimum {
            return Err(format!("当前设备的采样间隔不能低于 {minimum} 毫秒"));
        }
        let (reply, rx) = mpsc::channel();
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            let live = slot
                .as_ref()
                .filter(|task| task.running.load(Ordering::Acquire))
                .filter(|task| {
                    // 仅对匹配代次下速率命令；旧连接的迟到命令不得改新代。
                    task.session
                        .as_ref()
                        .is_some_and(|s| generation.is_none_or(|g| s.generation == g))
                });
            if let Some(task) = live {
                let session = task.session.as_ref().ok_or("no stream session")?;
                session
                    .controls
                    .try_send(stream::Control::Rate { rate, reply })
                    .map_err(|e| format!("sample rate control unavailable: {e}"))?;
            } else {
                state.sample_rate.store(rate, Ordering::Release);
                return Ok(None);
            }
        }
        rx.recv()
            .map_err(|_| "device stopped before rate boundary".to_string())?
            .map(Some)
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

#[tauri::command]
fn pd_log_after(
    after_seq: Option<u64>,
    state: State<'_, AppState>,
) -> Result<Vec<PdEvent>, crate::app_error::AppError> {
    let result: Result<Vec<PdEvent>, String> = state
        .pd_log
        .lock()
        .map_err(|_| "PD 日志状态已损坏".to_string())
        .map(|log| log.events_after(after_seq));
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// 退出流程的唯一入口：先停后台任务，再强制销毁主窗口。
///
/// 必须用 `destroy` 而不是 `close`——`close` 会重新派发 close-requested 事件，
/// 与前端的退出确认监听器构成回环，窗口反而关不掉（Tauri v2 起的行为变更）。
///
/// 标为 `async` 交由 Tauri 的工作线程调度：`stop_task` 会 join 后台线程，
/// 而这些线程退出前可能仍在 `emit`（需要主线程处理），在主线程上阻塞等待会死锁。
#[tauri::command(async)]
fn shutdown(
    generation: Option<u64>,
    last_seq: Option<u64>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), crate::app_error::AppError> {
    let result: Result<(), String> = (|| {
        {
            let slot = state.device_task.lock().map_err(|_| "设备任务状态已损坏")?;
            if let Some(task) = slot.as_ref() {
                let session = task.session.as_ref().ok_or("no stream session")?;
                let end = session
                    .end
                    .lock()
                    .map_err(|_| "stream end state poisoned")?;
                let end = end
                    .as_ref()
                    .ok_or("drain_device_stream must complete before shutdown")?;
                if task.running.load(Ordering::Acquire)
                    || !task.joins.is_empty()
                    || generation != Some(end.generation)
                    || last_seq != Some(end.last_seq)
                    || session.consumed.load(Ordering::Acquire) != end.last_seq
                {
                    return Err("final stream seq has not been consumed and acknowledged".into());
                }
            }
            // Publish the teardown intent while still holding the device lock so a
            // concurrent connect either sees the old session or is rejected outright.
            state.shutting_down.store(true, Ordering::Release);
        }
        if let Ok(mut task) = state.temp_task.lock() {
            stop_task(&mut task);
        }
        // 前端已写完落盘尾部；这里只兜底把缓冲写进磁盘。
        if let Ok(mut files) = state.files.lock() {
            files.close_all();
        }
        match app.get_webview_window("main") {
            Some(window) => window.destroy().map_err(|e| e.to_string())?,
            None => app.exit(0),
        }
        Ok(())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("backendFailure", detail))
}

/// 连接温度服务
#[tauri::command(async)]
fn connect_temp_service(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, crate::app_error::AppError> {
    let result: Result<String, String> = (|| {
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
            session: None,
        });

        Ok(format!("已连接到温度服务 {}", addr))
    })();
    result.map_err(|detail| crate::app_error::AppError::new("tempConnectFailed", detail))
}

/// 断开温度服务
#[tauri::command(async)]
fn disconnect_temp_service(
    state: State<'_, AppState>,
) -> Result<String, crate::app_error::AppError> {
    let result: Result<String, String> = (|| {
        let mut task_slot = state
            .temp_task
            .lock()
            .map_err(|_| "温度任务状态已损坏".to_string())?;
        stop_task(&mut task_slot);
        Ok("已断开温度服务连接".to_string())
    })();
    result.map_err(|detail| crate::app_error::AppError::new("tempDisconnectFailed", detail))
}

/// 连续超时超过此时长且曾经读到过报告，视为拔线。
const UNPLUG_IDLE: Duration = Duration::from_secs(2);

/// 维简 HID 仪表：阻塞读 64 字节报告，每个报告最多一个到达物。
struct HidSource {
    device: hidapi::HidDevice,
    epoch: Instant,
    buf: [u8; 64],
    last_report_at: Instant,
    saw_report: bool,
}

impl HidSource {
    fn new(device: hidapi::HidDevice, epoch: Instant) -> Self {
        Self {
            device,
            epoch,
            buf: [0u8; 64],
            last_report_at: Instant::now(),
            saw_report: false,
        }
    }
}

impl acquire::Source for HidSource {
    fn min_rate_ms(&self) -> u64 {
        10
    }

    fn read(&mut self, rate_ms: u64, out: &mut Vec<acquire::Arrival>) -> Result<(), acquire::Stop> {
        let read = self
            .device
            .read_timeout(&mut self.buf, rate_ms.min(20) as i32);
        // Stamp immediately after host reception, before parsing or peak selection.
        let received_at = Instant::now();
        let received_us = received_at.duration_since(self.epoch).as_micros() as u64;
        match read {
            Ok(0) => {
                if self.saw_report && self.last_report_at.elapsed() >= UNPLUG_IDLE {
                    return Err(acquire::Stop::Unplugged);
                }
            }
            Ok(read_len) => {
                self.last_report_at = received_at;
                self.saw_report = true;
                let report = &self.buf[..read_len.min(self.buf.len())];
                let payload = match ReportKind::of(report) {
                    Some(ReportKind::General) => {
                        parse_device_data(report).map(acquire::Payload::Sample)
                    }
                    Some(ReportKind::Pd) => Some(acquire::Payload::Pd(report.to_vec())),
                    _ => None,
                };
                if let Some(payload) = payload {
                    out.push(acquire::Arrival {
                        received_us,
                        payload,
                    });
                }
            }
            // A failed HID read is how Windows reports a pulled cable.
            Err(_) => return Err(acquire::Stop::Unplugged),
        }
        Ok(())
    }
}

#[cfg(test)]
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
        ah: Some(sample.ah),
        wh: Some(sample.wh),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    boot_timing::mark("run_enter");
    #[cfg_attr(target_os = "macos", allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build());
    boot_timing::mark("plugins_registered");

    // decorum injects a native traffic-light positioner on macOS even though
    // this app uses its own HTML window controls there. That positioner can
    // dereference a missing Cocoa superview during window creation, so keep
    // the plugin on the platforms where its overlay titlebar is supported.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_decorum::init());
    }

    let app = builder
        .manage(AppState::default())
        .setup(|app| {
            boot_timing::mark("setup_enter");
            file_io::start_spool_checkpoints(app.handle().clone());
            // 自定义标题栏：Windows 由 decorum 注入带贴靠布局浮窗的窗口控制按钮
            // （前端按设计令牌重绘，并用内置 Fluent SVG 替换 Segoe 字形以免 Win10 缺字）；
            // Linux 无此支持，改由前端 windowcontrols.js 自绘按钮与边缘调整大小热区。
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                let main_window = app
                    .get_webview_window("main")
                    .expect("main window must exist");
                main_window
                    .create_overlay_titlebar()
                    .expect("failed to create overlay titlebar");
                boot_timing::mark("titlebar_created");
                windows_icon::configure(&main_window);
            }
            boot_timing::mark("setup_exit");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot_timing::get_boot_timing,
            boot_timing::report_boot_timing,
            get_runtime_platform,
            get_system_locale,
            connect_device_by_path,
            disconnect_device,
            drain_device_stream,
            abandon_device_stream,
            set_recording_segment,
            ack_device_stream,
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
            km003c_session::km003c_trigger,
            km003c_session::km003c_cancel_trigger,
            file_io::csv_export_pick,
            file_io::pd_export_pick,
            file_io::csv_import_pick,
            file_io::csv_read_chunk,
            file_io::csv_read_close,
            file_io::csv_write_chunk,
            file_io::csv_write_patch,
            file_io::csv_write_sync,
            file_io::csv_write_close,
            file_io::spool_open,
            file_io::spool_recovery_list,
            file_io::spool_recovery_open,
            file_io::spool_recovery_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 原生退出（macOS 菜单 / ⌘Q、末窗口销毁）不会经过前端 onCloseRequested。首次
    // ExitRequested 拦下并交给前端，走与关闭按钮一致的确认 + 排空 + ACK 流程；
    // shutdown 校验通过、置位 shutting_down 后再次派发的 ExitRequested 才真正放行。
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let state = handle.state::<AppState>();
            if state.shutting_down.load(Ordering::Acquire) || code.is_some() {
                return;
            }
            api.prevent_exit();
            let _ = handle.emit("app-exit-requested", ());
        }
    });
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
            model_description: None,
            interface_description: None,
            interface_number,
            usage_page,
            family: DeviceFamily::Witrn,
            controls: false,
            max_rate_hz: 100,
        }
    }

    #[test]
    fn decode_to_transport_pipeline_is_lossless_and_bit_exact() {
        // Exercises the real HID decode -> peak selection -> channel -> batch emitter chain
        // at volume: every decoded frame must survive in order, gapless, with bit-exact f32
        // channels. Timing is informational (debug profile); WebView/HID latency not covered.
        let decoded = parse_device_data(&valid_frame()).expect("valid frame decodes");
        const N: u64 = 50_000;
        let (tx, rx) = mpsc::sync_channel::<stream::Outgoing>(N as usize + stream::CHANNEL_CAP);
        let produced = Arc::new(AtomicU64::new(0));
        let mut selection = stream::Selection::new(stream::SELECTED_CAP, Arc::clone(&produced));
        let consumer = thread::spawn(move || {
            let mut out = Vec::new();
            stream::emit_loop(
                rx,
                || Duration::from_millis(stream::BATCH_MS_FLOOR),
                |samples, _, _| {
                    out.extend_from_slice(samples);
                    Ok(())
                },
            )
            .unwrap();
            out
        });
        let started = Instant::now();
        for i in 0..N {
            selection.offer(stream::Sample {
                data: decoded.clone(),
                generation: 1,
                seq: 0,
                segment: 1,
                received_us: i * 10_000,
                wall_anchor_ms: 0,
                segment_start_us: 0,
                rate_ms: 10,
            });
            selection
                .select()
                .expect("backlog stays bounded with a live consumer");
            selection.drain(&tx).expect("emitter attached");
        }
        selection.select().expect("final select");
        selection.finish(&tx).expect("finish drains to consumer");
        drop(tx);
        let points = consumer.join().unwrap();
        let secs = started.elapsed().as_secs_f64();
        assert_eq!(
            points.len() as u64,
            N,
            "decode->transport must drop or duplicate nothing"
        );
        assert_eq!(produced.load(Ordering::Acquire), N);
        assert!(
            points.iter().all(|p| p.data == decoded),
            "f32 channels must survive the transport bit-for-bit"
        );
        for (i, p) in points.iter().enumerate() {
            assert_eq!(p.seq, i as u64 + 1, "sequence stays gapless and monotonic");
            assert_eq!(
                p.received_us,
                (i as u64) * 10_000,
                "peak keeps its own receive time"
            );
        }
        eprintln!(
            "native decode->transport: {N} frames in {:.1} ms = {:.0} pts/s (real HID decode + peak + channel + batch emitter)",
            secs * 1000.0,
            N as f64 / secs
        );
    }

    #[test]
    fn drain_joins_final_delivery_and_keeps_the_unacknowledged_session() {
        let (tx, rx) = mpsc::sync_channel(1);
        let (controls, _control_rx) = mpsc::sync_channel(1);
        let produced = Arc::new(AtomicU64::new(0));
        let consumed = Arc::new(AtomicU64::new(0));
        let end = Arc::new(Mutex::new(None));
        let reader_end = Arc::clone(&end);
        let mut selection = stream::Selection::new(2, Arc::clone(&produced));
        for received_us in [10, 20, 30] {
            selection.offer(stream::Sample {
                data: parse_device_data(&valid_frame()).unwrap(),
                generation: 7,
                seq: 0,
                segment: 1,
                received_us,
                wall_anchor_ms: 1000,
                segment_start_us: 0,
                rate_ms: 10,
            });
            if received_us != 30 {
                selection.select().unwrap();
                selection.drain(&tx).unwrap();
            }
        }
        let read_join = thread::spawn(move || {
            selection.finish(&tx).unwrap();
            let receipt = stream::End {
                generation: 7,
                last_seq: selection.seq,
                error: None,
            };
            *reader_end.lock().unwrap() = Some(receipt.clone());
            tx.send(DeviceOutgoing::End(receipt)).unwrap();
        });
        let delivered = Arc::new(Mutex::new((Vec::new(), None)));
        let emitted = Arc::clone(&delivered);
        let emit_join = thread::spawn(move || {
            stream::emit_loop(
                rx,
                || Duration::from_millis(stream::BATCH_MS_FLOOR),
                |samples, _, end| {
                    let mut output = emitted.lock().unwrap();
                    assert!(output.1.is_none(), "no samples may follow End");
                    output.0.extend_from_slice(samples);
                    output.1 = end.cloned();
                    Ok(())
                },
            )
            .unwrap();
        });
        let mut task = BackgroundTask {
            running: Arc::new(AtomicBool::new(true)),
            joins: vec![read_join, emit_join],
            session: Some(DeviceSession {
                generation: 7,
                controls,
                produced,
                consumed,
                end,
            }),
        };
        let receipt = drain_device_task(&mut task).unwrap().unwrap();
        assert!(!task.running.load(Ordering::Acquire));
        assert!(task.joins.is_empty());
        assert_eq!((receipt.generation, receipt.last_seq), (7, 3));
        assert!(receipt.error.is_none());
        let session = task.session.as_ref().unwrap();
        assert_eq!(session.produced.load(Ordering::Acquire), receipt.last_seq);
        assert_eq!(
            session.consumed.load(Ordering::Acquire),
            0,
            "delivery is not a frontend ack"
        );
        let output = delivered.lock().unwrap();
        assert_eq!(
            output
                .0
                .iter()
                .map(|s| (s.seq, s.received_us))
                .collect::<Vec<_>>(),
            [(1, 10), (2, 20), (3, 30)]
        );
        assert_eq!(output.1.as_ref().unwrap().last_seq, receipt.last_seq);
        assert_eq!(
            drain_device_task(&mut task).unwrap().unwrap().last_seq,
            receipt.last_seq
        );
    }

    /// 终态逃生口只能退休「已停止 + 已有末包回执 + 同代」的会话，且不得冒充 ACK。
    #[test]
    fn abandon_only_retires_a_stopped_session_with_a_receipt() {
        let (controls, _control_rx) = mpsc::sync_channel(1);
        let end = Arc::new(Mutex::new(None));
        let consumed = Arc::new(AtomicU64::new(1));
        let mut task = BackgroundTask {
            running: Arc::new(AtomicBool::new(true)),
            joins: vec![],
            session: Some(DeviceSession {
                generation: 7,
                controls,
                produced: Arc::new(AtomicU64::new(3)),
                consumed: Arc::clone(&consumed),
                end: Arc::clone(&end),
            }),
        };

        assert!(
            abandon_device_task(&mut task, 7).is_err(),
            "a running producer must not be abandoned"
        );
        task.running.store(false, Ordering::Release);
        assert!(
            abandon_device_task(&mut task, 7).is_err(),
            "no receipt yet: the drain must complete first"
        );

        *end.lock().unwrap() = Some(stream::End {
            generation: 7,
            last_seq: 3,
            error: None,
        });
        assert!(
            abandon_device_task(&mut task, 8).is_err(),
            "a stale generation must not retire the newer session"
        );

        let receipt = abandon_device_task(&mut task, 7).unwrap().unwrap();
        assert_eq!((receipt.generation, receipt.last_seq), (7, 3));
        assert_eq!(
            consumed.load(Ordering::Acquire),
            1,
            "abandoning is not an acknowledgment of the hole"
        );
        assert!(
            task.session.is_some(),
            "the helper validates; only the command retires the slot"
        );
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
            "Unknown WITRN device (0716:50FF)"
        );
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
            ah: Some(0.0),
            wh: Some(0.0),
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
            "WITRN K2 (USB 4-4) [Interface 0 / Usage 0xFF00]"
        );
        assert_eq!(
            devices[1].display_name,
            "WITRN K2 (USB 4-4) [Interface 1 / Usage 0xFF01]"
        );
    }
}
