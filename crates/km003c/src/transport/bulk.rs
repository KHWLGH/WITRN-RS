//! KM003C Interface 0 Vendor Bulk：EP 0x01 OUT / 0x81 IN。

use std::cmp::Reverse;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use nusb::transfer::{Buffer, Bulk, In, Out, TransferError};
use nusb::{DeviceInfo, Endpoint, Interface, MaybeFuture};

use crate::protocol::{
    auth, encode_ctrl, parse_response, Attribute, Command, DataResponse, ParsedResponse,
};

use super::{is_powerz_pid, model_name, VID};

pub const INTERFACE_VENDOR: u8 = 0;
pub const ENDPOINT_OUT: u8 = 0x01;
pub const ENDPOINT_IN: u8 = 0x81;
pub const IN_TRANSFER_SIZE: usize = 4096;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct BulkDeviceInfo {
    pub vid: u16,
    pub pid: u16,
    pub bus_id: String,
    pub address: u8,
    pub product: Option<String>,
    pub serial: Option<String>,
    /// Physical port path such as `4-4`, or `None` when the platform does not report one.
    pub usb_port: Option<String>,
    pub driver: Option<String>,
    pub interfaces: Vec<InterfaceSummary>,
    pub score: i32,
}

#[derive(Debug, Clone)]
pub struct InterfaceSummary {
    pub number: u8,
    pub class: u8,
}

pub fn list_devices() -> Result<Vec<BulkDeviceInfo>> {
    let mut devices: Vec<BulkDeviceInfo> = nusb::list_devices()
        .wait()
        .context("failed to enumerate USB devices")?
        .filter(|d| d.vendor_id() == VID && is_powerz_pid(d.product_id()))
        .map(summarize)
        .collect();
    devices.sort_by_key(|a| Reverse(a.score));
    Ok(devices)
}

fn summarize(d: DeviceInfo) -> BulkDeviceInfo {
    summarize_ref(&d)
}

fn summarize_ref(d: &DeviceInfo) -> BulkDeviceInfo {
    let interfaces: Vec<InterfaceSummary> = d
        .interfaces()
        .map(|i| InterfaceSummary {
            number: i.interface_number(),
            class: i.class(),
        })
        .collect();
    let mut score = 0;
    #[cfg(target_os = "windows")]
    if d.driver()
        .is_some_and(|name| name.eq_ignore_ascii_case("WinUSB"))
    {
        score += 10;
    }
    if interfaces.iter().any(|i| i.number == 0 && i.class == 0xFF) {
        score += 5;
    }
    if interfaces.iter().any(|i| i.number == INTERFACE_VENDOR) {
        score += 1;
    }
    BulkDeviceInfo {
        vid: d.vendor_id(),
        pid: d.product_id(),
        bus_id: d.bus_id().to_string(),
        address: d.device_address(),
        product: d.product_string().map(str::to_string),
        serial: d.serial_number().map(str::to_string),
        usb_port: format_port_chain(d.port_chain()),
        driver: {
            #[cfg(target_os = "windows")]
            {
                d.driver().map(str::to_string)
            }
            #[cfg(not(target_os = "windows"))]
            {
                None
            }
        },
        interfaces,
        score,
    }
}

/// Join a port chain the way WITRN names its HID ports (`[4, 4]` becomes `4-4`).
fn format_port_chain(chain: &[u8]) -> Option<String> {
    (!chain.is_empty()).then(|| {
        chain
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join("-")
    })
}

pub fn open_by_identity(bus_id: &str, address: u8, timeout: Duration) -> Result<BulkDevice> {
    let infos: Vec<DeviceInfo> = nusb::list_devices()
        .wait()
        .context("failed to enumerate USB devices")?
        .filter(|d| {
            d.vendor_id() == VID
                && is_powerz_pid(d.product_id())
                && d.bus_id() == bus_id
                && d.device_address() == address
        })
        .collect();

    if infos.is_empty() {
        return Err(anyhow!(
            "未找到指定的 POWER-Z 设备（bus={bus_id} addr={address}）"
        ));
    }

    open_first(infos, timeout, "无法打开指定的 KM003C Bulk 接口")
}

/// Open by USB serial number so a re-enumerated address still finds the same meter.
pub fn open_by_serial(serial: &str, timeout: Duration) -> Result<BulkDevice> {
    let sn = serial.trim();
    if sn.is_empty() || sn == "-" {
        return Err(anyhow!("无效的设备序列号"));
    }
    let infos: Vec<DeviceInfo> = nusb::list_devices()
        .wait()
        .context("failed to enumerate USB devices")?
        .filter(|d| {
            d.vendor_id() == VID
                && is_powerz_pid(d.product_id())
                && d.serial_number().is_some_and(|s| s == sn)
        })
        .collect();

    if infos.is_empty() {
        return Err(anyhow!("未找到序列号为 {sn} 的 POWER-Z 设备"));
    }

    open_first(infos, timeout, "无法按序列号打开 KM003C Bulk 接口")
}

/// Prefer bus+address, then serial (address may change after protocol scan / USB reset).
pub fn open_preferred(
    bus_id: &str,
    address: u8,
    serial: Option<&str>,
    timeout: Duration,
) -> Result<BulkDevice> {
    match open_by_identity(bus_id, address, timeout) {
        Ok(dev) => Ok(dev),
        Err(identity_err) => {
            if let Some(sn) = serial {
                if let Ok(dev) = open_by_serial(sn, timeout) {
                    return Ok(dev);
                }
            }
            Err(identity_err)
        }
    }
}

fn open_first(infos: Vec<DeviceInfo>, timeout: Duration, fallback: &str) -> Result<BulkDevice> {
    let mut ranked = infos;
    ranked.sort_by_key(|d| std::cmp::Reverse(summarize_ref(d).score));
    let mut last_err = None;
    for info in ranked {
        match BulkDevice::from_info(info, timeout) {
            Ok(dev) => return Ok(dev),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow!("{fallback}")))
}

pub fn open_with_timeout(timeout: Duration) -> Result<BulkDevice> {
    let infos: Vec<DeviceInfo> = nusb::list_devices()
        .wait()
        .context("failed to enumerate USB devices")?
        .filter(|d| d.vendor_id() == VID && is_powerz_pid(d.product_id()))
        .collect();

    if infos.is_empty() {
        return Err(anyhow!(
            "未找到 POWER-Z KM003C（VID=0x{VID:04X} PID=0x{:04X}）。请确认设备已连接，并关闭官方上位机。",
            super::PID_KM003C
        ));
    }

    open_first(infos, timeout, "无法打开 KM003C Bulk 接口")
}

#[derive(Default)]
struct BulkSession {
    disconnected: bool,
}

impl BulkSession {
    fn transfer<T>(
        &mut self,
        submit: impl FnOnce() -> std::result::Result<T, TransferError>,
    ) -> std::result::Result<T, TransferError> {
        if self.disconnected {
            return Err(TransferError::Disconnected);
        }
        let result = submit();
        if matches!(result, Err(TransferError::Disconnected)) {
            self.disconnected = true;
        }
        result
    }
}

pub fn is_disconnected(error: &anyhow::Error) -> bool {
    error.downcast_ref::<TransferError>() == Some(&TransferError::Disconnected)
}

pub struct BulkDevice {
    _interface: Interface,
    ep_out: Endpoint<Bulk, Out>,
    ep_in: Endpoint<Bulk, In>,
    tid: u8,
    timeout: Duration,
    session: BulkSession,
    pub model: &'static str,
}

impl BulkDevice {
    pub fn open() -> Result<Self> {
        open_with_timeout(DEFAULT_TIMEOUT)
    }

    pub fn open_with_timeout(timeout: Duration) -> Result<Self> {
        open_with_timeout(timeout)
    }

    fn from_info(info: DeviceInfo, timeout: Duration) -> Result<Self> {
        let pid = info.product_id();
        let device = info.open().wait().context("failed to open USB device")?;
        let interface = device
            .detach_and_claim_interface(INTERFACE_VENDOR)
            .wait()
            .with_context(|| {
                format!(
                    "无法占用 Interface {INTERFACE_VENDOR}（Vendor Bulk）。Windows 上请确认该接口绑定 WinUSB；Linux 上请先卸载 powerz 驱动。"
                )
            })?;

        let ep_out = interface
            .endpoint::<Bulk, Out>(ENDPOINT_OUT)
            .context("missing bulk OUT endpoint 0x01")?;
        let ep_in = interface
            .endpoint::<Bulk, In>(ENDPOINT_IN)
            .context("missing bulk IN endpoint 0x81")?;

        let mut dev = Self {
            _interface: interface,
            ep_out,
            ep_in,
            tid: 0,
            timeout,
            session: BulkSession::default(),
            model: model_name(pid),
        };
        dev.connect().context("KM003C Bulk 握手失败")?;
        Ok(dev)
    }

    /// Timeout applied to each OUT and IN transfer from now on.
    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    fn next_tid(&mut self) -> u8 {
        let id = self.tid;
        self.tid = self.tid.wrapping_add(1);
        id
    }

    fn send_raw(&mut self, packet: &[u8]) -> Result<()> {
        self.session
            .transfer(|| {
                self.ep_out
                    .transfer_blocking(packet.to_vec().into(), self.timeout)
                    .into_result()
            })
            .context("USB OUT 传输失败")?;
        Ok(())
    }

    fn recv_raw(&mut self) -> Result<Vec<u8>> {
        let buf = self
            .session
            .transfer(|| {
                self.ep_in
                    .transfer_blocking(Buffer::new(IN_TRANSFER_SIZE), self.timeout)
                    .into_result()
            })
            .context("USB IN 传输失败")?;
        Ok(buf[..].to_vec())
    }

    fn transact_raw(&mut self, packet: &[u8]) -> Result<Vec<u8>> {
        self.send_raw(packet)?;
        self.recv_raw()
    }

    fn transact(&mut self, cmd: Command, att: u16) -> Result<Vec<u8>> {
        let tid = self.next_tid();
        let header = encode_ctrl(cmd as u8, tid, att);
        self.transact_raw(&header)
    }

    pub fn connect(&mut self) -> Result<()> {
        let bytes = self.transact(Command::Connect, 0)?;
        match parse_response(&bytes)? {
            ParsedResponse::Reject { .. } => Err(anyhow!("设备拒绝 Bulk Connect")),
            _ => Ok(()),
        }
    }

    pub fn disconnect(&mut self) -> Result<()> {
        if self.session.disconnected {
            return Ok(());
        }
        let result = self.transact(Command::Disconnect, 0).map(|_| ());
        self.session.disconnected = true;
        result
    }

    pub fn get_data(&mut self, attr: Attribute) -> Result<DataResponse> {
        let bytes = self.transact(Command::GetData, attr.bits())?;
        match parse_response(&bytes)? {
            ParsedResponse::Data(data) => Ok(data),
            ParsedResponse::Accept { id } => {
                let _ = id;
                Ok(DataResponse::default())
            }
            ParsedResponse::Reject { id } => {
                let _ = id;
                Err(anyhow!("GetData rejected"))
            }
        }
    }

    /// Read a fixed memory block and decrypt it with the device memory key.
    pub fn memory_read(&mut self, address: u32, size: usize) -> Result<Vec<u8>> {
        let size_u32 = u32::try_from(size).context("MemoryRead 长度过大")?;
        let tid = self.next_tid();
        let request = auth::build_memory_read(tid, address, size_u32);
        self.send_raw(&request)?;
        let confirm = self.recv_raw()?;
        validate_memory_confirmation(&confirm, tid, address, size_u32)?;
        let ciphertext = self.recv_raw()?;
        let blocks = size.div_ceil(16);
        anyhow::ensure!(ciphertext.len() >= blocks * 16, "MemoryRead 数据包过短");
        let mut plain = Vec::with_capacity(blocks * 16);
        for block in ciphertext[..blocks * 16].chunks_exact(16) {
            plain.extend_from_slice(&auth::decrypt_memory_payload((*block).try_into().unwrap()));
        }
        plain.truncate(size);
        Ok(plain)
    }

    /// Authenticate the meter for AdcQueue access. Returns the firmware auth level.
    pub fn stream_auth(&mut self, hardware_id: [u8; 12], timestamp_ms: u64) -> Result<u8> {
        let tid = self.next_tid();
        let packet = auth::build_stream_auth(tid, timestamp_ms, hardware_id);
        let response = self.transact_raw(&packet)?;
        anyhow::ensure!(response.len() >= 4, "StreamingAuth 回复过短");
        anyhow::ensure!(response[0] & 0x7F == 0x4C, "StreamingAuth 回复类型错误");
        let attribute = u16::from_le_bytes([response[2], response[3]]);
        let level = auth::auth_level(attribute);
        anyhow::ensure!(level >= 1, "设备认证失败 (attribute=0x{attribute:04X})");
        Ok(level)
    }

    pub fn start_graph(&mut self, rate_index: u8) -> Result<()> {
        anyhow::ensure!(rate_index <= 3, "无效的 AdcQueue 采样率索引");
        let tid = self.next_tid();
        let response = self.transact_raw(&[0x0E, tid, rate_index << 1, 0])?;
        match parse_response(&response)? {
            ParsedResponse::Reject { .. } => Err(anyhow!("设备拒绝 StartGraph")),
            _ => Ok(()),
        }
    }

    pub fn stop_graph(&mut self) -> Result<()> {
        let tid = self.next_tid();
        let response = self.transact_raw(&[0x0F, tid, 0, 0])?;
        match parse_response(&response)? {
            ParsedResponse::Reject { .. } => Err(anyhow!("设备拒绝 StopGraph")),
            _ => Ok(()),
        }
    }
}

fn validate_memory_confirmation(bytes: &[u8], tid: u8, address: u32, size: u32) -> Result<()> {
    anyhow::ensure!(bytes.len() >= 20, "MemoryRead 确认包过短");
    anyhow::ensure!(bytes[0] == 0xC4, "MemoryRead 确认类型错误");
    anyhow::ensure!(bytes[1] == tid, "MemoryRead 确认 TID 不匹配");
    anyhow::ensure!(bytes[2..4] == [0x01, 0x01], "MemoryRead 确认头错误");
    anyhow::ensure!(
        u32::from_le_bytes(bytes[4..8].try_into().unwrap()) == address,
        "MemoryRead 确认地址不匹配"
    );
    anyhow::ensure!(
        u32::from_le_bytes(bytes[8..12].try_into().unwrap()) == size,
        "MemoryRead 确认长度不匹配"
    );
    anyhow::ensure!(
        u32::from_le_bytes(bytes[12..16].try_into().unwrap()) == u32::MAX,
        "MemoryRead 确认魔数错误"
    );
    let expected_crc = auth::crc32(&bytes[4..16]);
    let actual_crc = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    anyhow::ensure!(actual_crc == expected_crc, "MemoryRead 确认 CRC 错误");
    Ok(())
}

impl Drop for BulkDevice {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_confirmation(tid: u8, address: u32, size: u32) -> Vec<u8> {
        let mut bytes = vec![0xC4, tid, 0x01, 0x01];
        bytes.extend_from_slice(&address.to_le_bytes());
        bytes.extend_from_slice(&size.to_le_bytes());
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.extend_from_slice(&auth::crc32(&bytes[4..16]).to_le_bytes());
        bytes
    }

    #[test]
    fn memory_confirmation_checks_echo_fields_and_crc() {
        let bytes = memory_confirmation(7, 0x4001_0450, 12);
        validate_memory_confirmation(&bytes, 7, 0x4001_0450, 12).unwrap();

        let mut bad = bytes.clone();
        bad[8] ^= 1;
        assert!(validate_memory_confirmation(&bad, 7, 0x4001_0450, 12).is_err());

        let mut bad_crc = bytes;
        bad_crc[19] ^= 1;
        assert!(validate_memory_confirmation(&bad_crc, 7, 0x4001_0450, 12).is_err());
    }

    #[test]
    fn disconnected_endpoint_never_submits_again_including_cleanup() {
        for successful_transfers in [0, 1] {
            let mut session = BulkSession::default();
            let mut submitted = 0;
            for _ in 0..successful_transfers {
                session
                    .transfer(|| {
                        submitted += 1;
                        Ok(())
                    })
                    .unwrap();
            }
            let error = session
                .transfer::<()>(|| {
                    submitted += 1;
                    Err(TransferError::Disconnected)
                })
                .context("USB 传输失败")
                .unwrap_err();
            assert!(is_disconnected(&error));
            for _ in 0..3 {
                assert_eq!(
                    session.transfer(|| {
                        submitted += 1;
                        Ok(())
                    }),
                    Err(TransferError::Disconnected)
                );
            }
            assert_eq!(submitted, successful_transfers + 1);
        }
    }

    #[test]
    fn port_chain_matches_witrn_port_names() {
        assert_eq!(format_port_chain(&[4, 4]).as_deref(), Some("4-4"));
        assert_eq!(format_port_chain(&[1]).as_deref(), Some("1"));
        assert_eq!(format_port_chain(&[]), None);
    }

    #[test]
    fn transient_failure_keeps_healthy_session_available() {
        let mut session = BulkSession::default();
        let error = session
            .transfer::<()>(|| Err(TransferError::Cancelled))
            .context("USB IN")
            .unwrap_err();
        assert!(!is_disconnected(&error));
        assert!(!session.disconnected);
        assert_eq!(session.transfer(|| Ok(42)), Ok(42));
    }
}
