use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::net::TcpStream;
use std::io::{BufReader, BufRead};
use tauri::{AppHandle, Emitter, State};

/// 已知的维简设备型号
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct KnownDevice {
    pub name: &'static str,
    pub vid: u16,
    pub pid: u16,
}

/// 支持的维简设备列表
pub const KNOWN_DEVICES: &[KnownDevice] = &[
    KnownDevice { name: "WITRN K2", vid: 0x0716, pid: 0x5060 },
    KnownDevice { name: "WITRN U3", vid: 0x0716, pid: 0x5063 },
    // Some C5 firmware/variants report PID 0x5053 (observed in the field).
    KnownDevice { name: "WITRN C5", vid: 0x0716, pid: 0x5053 },
    KnownDevice { name: "WITRN C5", vid: 0x0716, pid: 0x5064 },
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
}

#[derive(Clone, Serialize)]
struct DeviceData {
    voltage: f32,
    current: f32,
    power: f32,
    dp: f32,           // D+
    dn: f32,           // D-
    cc1: f32,          // CC1
    cc2: f32,          // CC2
    temperature: f32,  // 温度
    ah: f32,           // 累计容量 Ah
    wh: f32,           // 累计能量 Wh
}

struct AppState {
    device: Arc<Mutex<Option<HidDevice>>>,
    running: Arc<Mutex<bool>>,
    sample_rate: Arc<Mutex<u64>>,
    current_device_info: Arc<Mutex<Option<DeviceInfo>>>,
    // Temperature service state
    temp_running: Arc<Mutex<bool>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            device: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
            sample_rate: Arc::new(Mutex::new(250)),
            current_device_info: Arc::new(Mutex::new(None)),
            temp_running: Arc::new(Mutex::new(false)),
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
#[tauri::command]
fn enumerate_devices() -> Result<Vec<DeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| format!("无法初始化HID API: {}", e))?;
    let mut devices = Vec::new();

    for device_info in api.device_list() {
        let vid = device_info.vendor_id();
        let pid = device_info.product_id();

        // 检查是否是已知的维简设备
        let known = KNOWN_DEVICES.iter().find(|d| d.vid == vid && d.pid == pid);
        
        // 也支持用户自定义的设备（通过VID/PID匹配）
        let model_name = known.map(|d| d.name.to_string())
            .unwrap_or_else(|| format!("未知设备 ({:04X}:{:04X})", vid, pid));

        // 只添加已知设备或者VID为0x0716/0x0483的设备
        if known.is_some() || vid == 0x0716 || vid == 0x0483 {
            let serial = device_info.serial_number().map(|s| s.to_string());
            let manufacturer = device_info.manufacturer_string().map(|s| s.to_string());
            let product = device_info.product_string().map(|s| s.to_string());
            
            let path = device_info.path().to_string_lossy().to_string();
            
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
            });
        }
    }

    // 去重（按path去重，因为同一设备可能有多个接口）
    devices.dedup_by(|a, b| a.path == b.path);

    Ok(devices)
}

/// 获取当前连接的设备信息
#[tauri::command]
fn get_current_device_info(state: State<'_, AppState>) -> Option<DeviceInfo> {
    state.current_device_info.lock().unwrap().clone()
}

#[tauri::command]
fn connect_device_by_path(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let api = HidApi::new().map_err(|e| e.to_string())?;
    
    // 查找设备信息
    let device_info = api.device_list()
        .find(|d| d.path().to_string_lossy() == path)
        .ok_or("找不到指定设备")?;
    
    let vid = device_info.vendor_id();
    let pid = device_info.product_id();
    let serial = device_info.serial_number().map(|s| s.to_string());
    let manufacturer = device_info.manufacturer_string().map(|s| s.to_string());
    let product = device_info.product_string().map(|s| s.to_string());
    
    let known = KNOWN_DEVICES.iter().find(|d| d.vid == vid && d.pid == pid);
    let model_name = known.map(|d| d.name.to_string())
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
    };
    
    // 打开设备
    let path_cstr = std::ffi::CString::new(path.clone()).map_err(|e| e.to_string())?;
    let device = api.open_path(path_cstr.as_c_str())
        .map_err(|e| format!("无法打开设备: {}", e))?;
    
    // Store device
    {
        let mut dev = state.device.lock().unwrap();
        *dev = Some(device);
    }
    
    // Store device info
    {
        let mut info = state.current_device_info.lock().unwrap();
        *info = Some(current_info);
    }
    
    // Set running flag
    {
        let mut running = state.running.lock().unwrap();
        *running = true;
    }
    
    // Clone state references for the thread
    let device_arc = Arc::clone(&state.device);
    let running_arc = Arc::clone(&state.running);
    let sample_rate_arc = Arc::clone(&state.sample_rate);
    
    // Start reading thread
    thread::spawn(move || {
        let mut buf = [0u8; 64];
        let mut last_emit = Instant::now();
        let mut pending: Option<DeviceData> = None;
        
        loop {
            // Check if still running
            {
                let running = running_arc.lock().unwrap();
                if !*running {
                    break;
                }
            }
            
            // Get sample rate (ms). This is the desired *emit* interval.
            let rate_ms = {
                let rate = sample_rate_arc.lock().unwrap();
                (*rate).max(1)
            };

            // Read from device. We read frequently and *throttle emits* so the UI sample rate works
            // even if the device reports faster.
            let read_timeout_ms = rate_ms.min(20) as i32;
            let mut error_occurred = false;

            let maybe_sample = {
                let dev = device_arc.lock().unwrap();
                if let Some(ref device) = *dev {
                    match device.read_timeout(&mut buf, read_timeout_ms) {
                        Ok(size) if size == 64 && buf[0] == 0xFF => {
                            let ah = f32::from_le_bytes([buf[14], buf[15], buf[16], buf[17]]);
                            let wh = f32::from_le_bytes([buf[18], buf[19], buf[20], buf[21]]);
                            let dp = f32::from_le_bytes([buf[30], buf[31], buf[32], buf[33]]);
                            let dn = f32::from_le_bytes([buf[34], buf[35], buf[36], buf[37]]);
                            let temperature = f32::from_le_bytes([buf[42], buf[43], buf[44], buf[45]]);
                            let voltage = f32::from_le_bytes([buf[46], buf[47], buf[48], buf[49]]);
                            let current = f32::from_le_bytes([buf[50], buf[51], buf[52], buf[53]]);
                            let cc1 = buf[55] as f32 / 10.0;
                            let cc2 = buf[56] as f32 / 10.0;
                            let power = voltage * current;

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
                        Ok(_) => None,
                        Err(_) => {
                            error_occurred = true;
                            None
                        }
                    }
                } else {
                    break;
                }
            };

            if error_occurred {
                let _ = app.emit("device-disconnected", ());
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
    });
    
    Ok(format!("已连接: {}", display_name))
}

#[tauri::command]
fn connect_device(
    vid: u16,
    pid: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let api = HidApi::new().map_err(|e| e.to_string())?;
    
    // 查找匹配的设备
    let device_info = api.device_list()
        .find(|d| d.vendor_id() == vid && d.product_id() == pid)
        .ok_or(format!("找不到设备 VID:{:04X} PID:{:04X}", vid, pid))?;
    
    let path = device_info.path().to_string_lossy().to_string();
    
    // 使用path连接
    drop(api); // 释放api
    connect_device_by_path(path, state, app)
}

#[tauri::command]
fn disconnect_device(state: State<'_, AppState>) -> Result<String, String> {
    // Stop reading thread
    {
        let mut running = state.running.lock().unwrap();
        *running = false;
    }
    
    // Give thread time to finish
    thread::sleep(Duration::from_millis(200));
    
    // Clear device
    {
        let mut dev = state.device.lock().unwrap();
        *dev = None;
    }
    
    // Clear device info
    {
        let mut info = state.current_device_info.lock().unwrap();
        *info = None;
    }
    
    Ok("设备已断开".to_string())
}

#[tauri::command]
fn set_sample_rate(rate: u64, state: State<'_, AppState>) -> Result<(), String> {
    let mut sample_rate = state.sample_rate.lock().unwrap();
    *sample_rate = rate;
    Ok(())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn close_main_window(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?
        .close()
        .map_err(|e| e.to_string())
}

/// 连接温度服务
#[tauri::command]
fn connect_temp_service(
    ip: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    // 如果已经在运行，先停止
    {
        let mut running = state.temp_running.lock().unwrap();
        *running = false;
    }
    thread::sleep(Duration::from_millis(100));

    let addr = format!("{}:{}", ip, port);
    
    // 尝试连接
    let stream = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("无效地址: {}", e))?,
        Duration::from_secs(5)
    ).map_err(|e| format!("连接失败: {}", e))?;
    
    stream.set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| format!("设置超时失败: {}", e))?;

    // 启动接收线程
    let running = Arc::clone(&state.temp_running);
    {
        let mut r = running.lock().unwrap();
        *r = true;
    }

    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            // 检查是否应该停止
            {
                let r = running.lock().unwrap();
                if !*r {
                    break;
                }
            }

            match line {
                Ok(data) => {
                    let trimmed = data.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(temp) = trimmed.parse::<f32>() {
                        let _ = app.emit("temp-data", temp);
                    }
                }
                Err(e) => {
                    eprintln!("温度读取错误: {}", e);
                    // 通知前端连接断开
                    let _ = app.emit("temp-disconnected", ());
                    break;
                }
            }
        }
        
        // 清理
        let mut r = running.lock().unwrap();
        *r = false;
    });

    Ok(format!("已连接到温度服务 {}", addr))
}

/// 断开温度服务
#[tauri::command]
fn disconnect_temp_service(state: State<'_, AppState>) -> Result<String, String> {
    let mut running = state.temp_running.lock().unwrap();
    *running = false;
    Ok("已断开温度服务连接".to_string())
}

/// 获取温度服务连接状态
#[tauri::command]
fn get_temp_service_status(state: State<'_, AppState>) -> bool {
    *state.temp_running.lock().unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
