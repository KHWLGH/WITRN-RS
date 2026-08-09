use hidapi::HidApi;
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// 已知的维简设备型号
#[derive(Clone)]
pub struct KnownDevice {
    pub name: &'static str,
    pub vid: u16,
    pub pid: u16,
}

/// 支持的维简设备列表
pub const KNOWN_DEVICES: &[KnownDevice] = &[
    KnownDevice {
        name: "WITRN K2",
        vid: 0x0716,
        pid: 0x5060,
    },
    KnownDevice {
        name: "WITRN U3",
        vid: 0x0716,
        pid: 0x5063,
    },
    // Some C5 firmware/variants report PID 0x5053 (observed in the field).
    KnownDevice {
        name: "WITRN C5",
        vid: 0x0716,
        pid: 0x5053,
    },
    KnownDevice {
        name: "WITRN C5",
        vid: 0x0716,
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
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub model_name: String,
    pub display_name: String,
    pub interface_number: i32,
    pub usage_page: u16,
}

type PhysicalDeviceKey = (u16, u16, String);

fn physical_device_key(device: &DeviceInfo) -> PhysicalDeviceKey {
    (
        device.vid,
        device.pid,
        device.serial_number.clone().unwrap_or_default(),
    )
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

#[derive(Clone, Serialize, Debug, PartialEq)]
struct DeviceData {
    voltage: f32,
    current: f32,
    power: f32,
    dp: f32,          // D+
    dn: f32,          // D-
    cc1: f32,         // CC1
    cc2: f32,         // CC2
    temperature: f32, // 温度
    ah: f32,          // 累计容量 Ah
    wh: f32,          // 累计能量 Wh
}

struct BackgroundTask {
    running: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

impl BackgroundTask {
    fn stop(self) {
        self.running.store(false, Ordering::Relaxed);
        if self.join.join().is_err() {
            eprintln!("后台任务线程异常退出");
        }
    }
}

fn stop_task(slot: &mut Option<BackgroundTask>) {
    if let Some(task) = slot.take() {
        task.stop();
    }
}

struct AppState {
    device_task: Mutex<Option<BackgroundTask>>,
    sample_rate: Arc<Mutex<u64>>,
    current_device_info: Arc<Mutex<Option<DeviceInfo>>>,
    temp_task: Mutex<Option<BackgroundTask>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device_task: Mutex::new(None),
            sample_rate: Arc::new(Mutex::new(250)),
            current_device_info: Arc::new(Mutex::new(None)),
            temp_task: Mutex::new(None),
        }
    }
}

/// 获取已知设备列表（用于前端显示支持的设备类型）
#[tauri::command]
fn get_known_devices() -> Vec<serde_json::Value> {
    KNOWN_DEVICES
        .iter()
        .map(|d| {
            serde_json::json!({
                "name": d.name,
                "vid": format!("0x{:04X}", d.vid),
                "pid": format!("0x{:04X}", d.pid),
            })
        })
        .collect()
}

/// 枚举所有已连接的维简设备
#[tauri::command(async)]
fn enumerate_devices() -> Result<Vec<DeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| format!("无法初始化HID API: {}", e))?;
    let mut devices = Vec::new();
    let mut seen_paths = HashSet::new();

    for device_info in api.device_list() {
        let vid = device_info.vendor_id();
        let pid = device_info.product_id();

        // 检查是否是已知的维简设备
        let known = KNOWN_DEVICES.iter().find(|d| d.vid == vid && d.pid == pid);

        let model_name = known
            .map(|d| d.name.to_string())
            .unwrap_or_else(|| format!("未知设备 ({:04X}:{:04X})", vid, pid));

        // 枚举列表只展示已知 WITRN 型号；未知 VID/PID 仍可通过手动连接命令使用。
        if known.is_some() {
            let serial = device_info.serial_number().map(|s| s.to_string());
            let manufacturer = device_info.manufacturer_string().map(|s| s.to_string());
            let product = device_info.product_string().map(|s| s.to_string());

            let path = device_info.path().to_string_lossy().to_string();
            if !seen_paths.insert(path.clone()) {
                continue;
            }

            // 生成显示名称
            let display_name = if let Some(ref sn) = serial {
                if !sn.is_empty() {
                    format!("{} (SN: {})", model_name, sn)
                } else {
                    model_name.clone()
                }
            } else {
                model_name.clone()
            };

            devices.push(DeviceInfo {
                path,
                vid,
                pid,
                serial_number: serial,
                manufacturer,
                product,
                model_name,
                display_name,
                interface_number: device_info.interface_number(),
                usage_page: device_info.usage_page(),
            });
        }
    }

    // 同一物理设备可能同时暴露键盘接口和厂商自定义数据接口。
    // 只在确实找到厂商自定义 Usage Page 时过滤通用接口；无法判断时保留全部供用户选择。
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
        if physical_counts.get(&key).copied().unwrap_or(0) > 1 {
            let index = physical_indices.entry(key).or_insert(0usize);
            *index += 1;
            let suffix = if device.interface_number >= 0 {
                format!(
                    "接口 {} / Usage 0x{:04X}",
                    device.interface_number, device.usage_page
                )
            } else {
                format!("接口 {} / Usage 0x{:04X}", index, device.usage_page)
            };
            device.display_name = format!("{} [{}]", device.display_name, suffix);
        }
    }

    Ok(devices)
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
    let api = HidApi::new().map_err(|e| e.to_string())?;

    // 查找设备信息
    let device_info = api
        .device_list()
        .find(|d| d.path().to_string_lossy() == path)
        .ok_or("找不到指定设备")?;

    let vid = device_info.vendor_id();
    let pid = device_info.product_id();
    let serial = device_info.serial_number().map(|s| s.to_string());
    let manufacturer = device_info.manufacturer_string().map(|s| s.to_string());
    let product = device_info.product_string().map(|s| s.to_string());

    let known = KNOWN_DEVICES.iter().find(|d| d.vid == vid && d.pid == pid);
    let model_name = known
        .map(|d| d.name.to_string())
        .unwrap_or_else(|| format!("未知设备 ({:04X}:{:04X})", vid, pid));

    let display_name = if let Some(ref sn) = serial {
        if !sn.is_empty() {
            format!("{} (SN: {})", model_name, sn)
        } else {
            model_name.clone()
        }
    } else {
        model_name.clone()
    };

    let current_info = DeviceInfo {
        path: path.clone(),
        vid,
        pid,
        serial_number: serial,
        manufacturer,
        product,
        model_name,
        display_name: display_name.clone(),
        interface_number: device_info.interface_number(),
        usage_page: device_info.usage_page(),
    };

    // 先停止并等待上一代读取线程，避免旧线程看到新连接重新置 true 后复活。
    let mut task_slot = state
        .device_task
        .lock()
        .map_err(|_| "设备任务状态已损坏".to_string())?;
    stop_task(&mut task_slot);

    // 打开设备
    let path_cstr = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = api
        .open_path(path_cstr.as_c_str())
        .map_err(|e| format!("无法打开设备: {}", e))?;

    // Store device info
    {
        let mut info = state.current_device_info.lock().unwrap();
        *info = Some(current_info);
    }

    // 每个连接拥有自己的停止标志；旧连接即使延迟醒来也不会看到新连接的状态。
    let running_arc = Arc::new(AtomicBool::new(true));
    let running_for_thread = Arc::clone(&running_arc);
    let sample_rate_arc = Arc::clone(&state.sample_rate);

    // Start reading thread
    let join = thread::spawn(move || {
        // device is owned exclusively by this thread; no shared mutex during reads
        let mut buf = [0u8; 64];
        let mut last_emit = Instant::now();
        let mut pending: Option<DeviceData> = None;

        loop {
            // Check if still running
            if !running_for_thread.load(Ordering::Relaxed) {
                break;
            }

            // Get sample rate (ms). This is the desired *emit* interval.
            let rate_ms = {
                let rate = sample_rate_arc.lock().unwrap();
                (*rate).max(1)
            };

            // Read from device. We read frequently and *throttle emits* so the UI sample rate works
            // even if the device reports faster.
            let read_timeout_ms = rate_ms.min(20) as i32;
            let maybe_sample = match device.read_timeout(&mut buf, read_timeout_ms) {
                Ok(_) => parse_device_data(&buf),
                Err(_) => {
                    if running_for_thread.load(Ordering::Relaxed) {
                        let _ = app.emit("device-disconnected", ());
                    }
                    break;
                }
            };

            if !running_for_thread.load(Ordering::Relaxed) {
                break;
            }

            if let Some(sample) = maybe_sample {
                pending = Some(sample);
            }

            let emit_interval = Duration::from_millis(rate_ms);
            if pending.is_some() && last_emit.elapsed() >= emit_interval {
                let sample = pending.take().unwrap();
                let _ = app.emit("device-data", sample);
                last_emit = Instant::now();
            }
        }
        // device dropped here, HID connection closed cleanly
        running_for_thread.store(false, Ordering::Relaxed);
    });

    task_slot.replace(BackgroundTask {
        running: Arc::clone(&running_arc),
        join,
    });

    Ok(format!("已连接: {}", display_name))
}

#[tauri::command(async)]
fn connect_device(
    vid: u16,
    pid: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let api = HidApi::new().map_err(|e| e.to_string())?;

    // 查找匹配的设备
    let device_info = api
        .device_list()
        .find(|d| d.vendor_id() == vid && d.product_id() == pid)
        .ok_or(format!("找不到设备 VID:{:04X} PID:{:04X}", vid, pid))?;

    let path = device_info.path().to_string_lossy().to_string();

    // 使用path连接
    drop(api); // 释放api
    connect_device_by_path(path, state, app)
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
fn set_sample_rate(rate: u64, state: State<'_, AppState>) -> Result<(), String> {
    if !(10..=60_000).contains(&rate) {
        return Err("采样间隔必须在 10 到 60000 毫秒之间".to_string());
    }
    let mut sample_rate = state.sample_rate.lock().unwrap();
    *sample_rate = rate;
    Ok(())
}

#[tauri::command]
fn exit_app(state: State<'_, AppState>, app: AppHandle) {
    if let Ok(mut task) = state.device_task.lock() {
        stop_task(&mut task);
    }
    if let Ok(mut task) = state.temp_task.lock() {
        stop_task(&mut task);
    }

    // Prefer framework-managed exit to avoid abrupt teardown on Windows.
    app.exit(0);
}

#[tauri::command]
fn close_main_window(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Ok(mut task) = state.device_task.lock() {
        stop_task(&mut task);
    }
    if let Ok(mut task) = state.temp_task.lock() {
        stop_task(&mut task);
    }

    if let Some(window) = app.get_webview_window("main") {
        window
            .close()
            .map_err(|e| format!("关闭主窗口失败: {}", e))?;
        return Ok(());
    }

    eprintln!("未找到主窗口，回退为应用退出");
    app.exit(0);
    Ok(())
}

/// 连接温度服务
#[tauri::command(async)]
fn connect_temp_service(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let mut task_slot = state
        .temp_task
        .lock()
        .map_err(|_| "温度任务状态已损坏".to_string())?;
    stop_task(&mut task_slot);

    let addr = format!("{}:{}", ip, port);

    // 尝试连接
    let stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("无效地址: {}", e))?,
        Duration::from_secs(5),
    )
    .map_err(|e| format!("连接失败: {}", e))?;

    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| format!("设置超时失败: {}", e))?;

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
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    if running_for_thread.load(Ordering::Relaxed) {
                        let _ = app.emit("temp-disconnected", ());
                    }
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if let Ok(temp) = trimmed.parse::<f32>() {
                        if temp.is_finite() {
                            let _ = app.emit("temp-data", temp);
                        }
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
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
    task_slot.replace(BackgroundTask { running, join });

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

/// 获取温度服务连接状态
#[tauri::command]
fn get_temp_service_status(state: State<'_, AppState>) -> bool {
    state
        .temp_task
        .lock()
        .ok()
        .and_then(|task| {
            task.as_ref()
                .map(|task| task.running.load(Ordering::Relaxed))
        })
        .unwrap_or(false)
}

fn parse_device_data(buf: &[u8]) -> Option<DeviceData> {
    if buf.len() != 64 || buf[0] != 0xFF {
        return None;
    }

    let f32_at = |offset| -> Option<f32> {
        Some(f32::from_le_bytes(buf[offset..offset + 4].try_into().ok()?))
    };
    let ah = f32_at(14)?;
    let wh = f32_at(18)?;
    let dp = f32_at(30)?;
    let dn = f32_at(34)?;
    let temperature = f32_at(42)?;
    let voltage = f32_at(46)?;
    let current = f32_at(50)?;
    let cc1 = buf[55] as f32 / 10.0;
    let cc2 = buf[56] as f32 / 10.0;
    let power = voltage * current;

    let values = [
        ah,
        wh,
        dp,
        dn,
        temperature,
        voltage,
        current,
        power,
        cc1,
        cc2,
    ];
    if values.iter().any(|value| !value.is_finite())
        || !(0.0..=60.0).contains(&voltage)
        || current.abs() > 10.0
        || !(-40.0..=150.0).contains(&temperature)
    {
        return None;
    }

    Some(DeviceData {
        voltage,
        current,
        power,
        dp,
        dn,
        cc1,
        cc2,
        temperature,
        ah,
        wh,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_device,
            connect_device_by_path,
            disconnect_device,
            set_sample_rate,
            exit_app,
            close_main_window,
            enumerate_devices,
            get_known_devices,
            get_current_device_info,
            connect_temp_service,
            disconnect_temp_service,
            get_temp_service_status
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
            manufacturer: Some("WITRN".to_string()),
            product: Some("K2".to_string()),
            model_name: "WITRN K2".to_string(),
            display_name: "WITRN K2 (SN: test-device)".to_string(),
            interface_number,
            usage_page,
        }
    }

    #[test]
    fn parses_valid_frame_at_protocol_offsets() {
        let data = parse_device_data(&valid_frame()).expect("valid frame should parse");
        assert_eq!(data.voltage, 5.0);
        assert_eq!(data.current, 2.0);
        assert_eq!(data.power, 10.0);
        assert_eq!(data.temperature, 23.5);
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
        assert!(parse_device_data(&frame).is_none());

        let mut frame = valid_frame();
        frame[42..46].copy_from_slice(&150.1f32.to_le_bytes());
        assert!(parse_device_data(&frame).is_none());
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
}
