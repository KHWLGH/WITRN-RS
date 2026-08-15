use hidapi::{DeviceInfo, HidApi};

pub(crate) fn format_device_display_name(
    model_name: &str,
    usb_port: Option<&str>,
    interface_label: Option<&str>,
) -> String {
    let mut name = match usb_port.filter(|port| !port.is_empty()) {
        Some(port) => format!("{model_name} (USB {port})"),
        None => model_name.to_string(),
    };

    if let Some(label) = interface_label.filter(|label| !label.is_empty()) {
        name.push_str(&format!(" [{label}]"));
    }

    name
}

fn normalize_ports<'a>(ports: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let ports = ports
        .into_iter()
        .map(|port| port.parse::<u16>().ok().filter(|port| *port > 0))
        .collect::<Option<Vec<_>>>()?;

    if ports.is_empty() {
        return None;
    }

    Some(
        ports
            .into_iter()
            .map(|port| port.to_string())
            .collect::<Vec<_>>()
            .join("-"),
    )
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
pub(crate) fn parse_windows_location_path(location_path: &str) -> Option<String> {
    let mut ports = Vec::new();

    for segment in location_path.split('#') {
        if let Some(value) = segment.strip_prefix("USB(") {
            let value = value.strip_suffix(')')?;
            ports.push(value);
        }
    }

    normalize_ports(ports)
}

#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
pub(crate) fn parse_linux_devpath(devpath: &str) -> Option<String> {
    let devpath = devpath.trim();
    if devpath.is_empty() {
        return None;
    }

    normalize_ports(devpath.split('.'))
}

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) fn parse_macos_location_id(location_id: u32) -> Option<String> {
    let route = location_id & 0x00FF_FFFF;
    let mut ports = Vec::new();
    let mut route_ended = false;

    for shift in [20, 16, 12, 8, 4, 0] {
        let port = ((route >> shift) & 0xF) as u8;
        if port == 0 {
            route_ended = true;
        } else if route_ended {
            return None;
        } else {
            ports.push(port.to_string());
        }
    }

    normalize_ports(ports.iter().map(String::as_str))
}

#[cfg(target_os = "windows")]
pub(crate) fn usb_port_for_device(_api: &HidApi, device_info: &DeviceInfo) -> Option<String> {
    windows::usb_port_for_path(&device_info.path().to_string_lossy())
}

#[cfg(target_os = "linux")]
pub(crate) fn usb_port_for_device(_api: &HidApi, device_info: &DeviceInfo) -> Option<String> {
    use std::path::Path;

    let path = device_info.path().to_string_lossy();
    let hidraw_name = Path::new(path.as_ref()).file_name()?.to_str()?;
    if !hidraw_name.starts_with("hidraw") {
        return None;
    }

    let sysfs_device = std::fs::canonicalize(
        Path::new("/sys/class/hidraw")
            .join(hidraw_name)
            .join("device"),
    )
    .ok()?;

    for ancestor in sysfs_device.ancestors() {
        let Ok(devpath) = std::fs::read_to_string(ancestor.join("devpath")) else {
            continue;
        };
        if let Some(port) = parse_linux_devpath(&devpath) {
            return Some(port);
        }
    }

    None
}

#[cfg(target_os = "macos")]
pub(crate) fn usb_port_for_device(api: &HidApi, device_info: &DeviceInfo) -> Option<String> {
    // macOS opens HID devices exclusively by default. A non-exclusive probe lets
    // enumeration keep working while another interface is already connected.
    api.set_open_exclusive(false);
    let device = api.open_path(device_info.path()).ok()?;
    parse_macos_location_id(device.get_location_id().ok()?)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
pub(crate) fn usb_port_for_device(_api: &HidApi, _device_info: &DeviceInfo) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
mod windows {
    use super::parse_windows_location_path;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Get_DevNode_PropertyW, CM_Get_Device_Interface_PropertyW, CM_Get_Parent,
        CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_NORMAL, CR_BUFFER_SMALL, CR_SUCCESS,
    };
    use windows_sys::Win32::Devices::Properties::{
        DEVPKEY_Device_InstanceId, DEVPKEY_Device_LocationPaths,
    };

    pub(super) fn usb_port_for_path(path: &str) -> Option<String> {
        let path = wide_null(path);
        let instance_id = read_interface_instance_id(&path)?;
        let mut devinst = 0;

        if unsafe {
            CM_Locate_DevNodeW(&mut devinst, instance_id.as_ptr(), CM_LOCATE_DEVNODE_NORMAL)
        } != CR_SUCCESS
        {
            return None;
        }

        for _ in 0..32 {
            if let Some(port) = read_location_port(devinst) {
                return Some(port);
            }

            let mut parent = 0;
            if unsafe { CM_Get_Parent(&mut parent, devinst, 0) } != CR_SUCCESS {
                break;
            }
            devinst = parent;
        }

        None
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    fn read_interface_instance_id(path: &[u16]) -> Option<Vec<u16>> {
        let mut property_type = 0;
        let mut byte_len = 0;
        let first_result = unsafe {
            CM_Get_Device_Interface_PropertyW(
                path.as_ptr(),
                &DEVPKEY_Device_InstanceId,
                &mut property_type,
                null_mut(),
                &mut byte_len,
                0,
            )
        };
        if first_result != CR_BUFFER_SMALL && first_result != CR_SUCCESS {
            return None;
        }

        let mut buffer = vec![0u16; (byte_len as usize).div_ceil(2)];
        if buffer.is_empty()
            || unsafe {
                CM_Get_Device_Interface_PropertyW(
                    path.as_ptr(),
                    &DEVPKEY_Device_InstanceId,
                    &mut property_type,
                    buffer.as_mut_ptr().cast(),
                    &mut byte_len,
                    0,
                )
            } != CR_SUCCESS
        {
            return None;
        }

        Some(buffer)
    }

    fn read_location_port(devinst: u32) -> Option<String> {
        let mut property_type = 0;
        let mut byte_len = 0;
        let first_result = unsafe {
            CM_Get_DevNode_PropertyW(
                devinst,
                &DEVPKEY_Device_LocationPaths,
                &mut property_type,
                null_mut(),
                &mut byte_len,
                0,
            )
        };
        if first_result != CR_BUFFER_SMALL && first_result != CR_SUCCESS {
            return None;
        }

        let mut buffer = vec![0u16; (byte_len as usize).div_ceil(2)];
        if buffer.is_empty()
            || unsafe {
                CM_Get_DevNode_PropertyW(
                    devinst,
                    &DEVPKEY_Device_LocationPaths,
                    &mut property_type,
                    buffer.as_mut_ptr().cast(),
                    &mut byte_len,
                    0,
                )
            } != CR_SUCCESS
        {
            return None;
        }

        buffer
            .split(|value| *value == 0)
            .filter(|value| !value.is_empty())
            .filter_map(|value| String::from_utf16(value).ok())
            .find_map(|location_path| parse_windows_location_path(&location_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_windows_usb_location_paths() {
        assert_eq!(
            parse_windows_location_path("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(4)#USB(4)"),
            Some("4-4".to_string())
        );
        assert_eq!(
            parse_windows_location_path("USBROOT(0)#USB(12)"),
            Some("12".to_string())
        );
        assert_eq!(parse_windows_location_path("PCIROOT(0)#USBROOT(0)"), None);
        assert_eq!(parse_windows_location_path("USBROOT(0)#USB(x)"), None);
    }

    #[test]
    fn parses_linux_usb_devpaths() {
        assert_eq!(parse_linux_devpath("4.4\n"), Some("4-4".to_string()));
        assert_eq!(parse_linux_devpath("12"), Some("12".to_string()));
        assert_eq!(parse_linux_devpath(""), None);
        assert_eq!(parse_linux_devpath("4..4"), None);
        assert_eq!(parse_linux_devpath("4.0"), None);
    }

    #[test]
    fn parses_macos_usb_location_ids() {
        assert_eq!(
            parse_macos_location_id(0x1432_0000),
            Some("3-2".to_string())
        );
        assert_eq!(parse_macos_location_id(0x1440_0000), Some("4".to_string()));
        assert_eq!(parse_macos_location_id(0x1400_0000), None);
        assert_eq!(parse_macos_location_id(0x1404_0000), None);
    }

    #[test]
    fn formats_names_with_ports_and_interface_labels() {
        assert_eq!(
            format_device_display_name("WITRN K2", Some("4-4"), None),
            "WITRN K2 (USB 4-4)"
        );
        assert_eq!(
            format_device_display_name("WITRN K2", None, None),
            "WITRN K2"
        );
        assert_eq!(
            format_device_display_name("WITRN K2", Some("4-4"), Some("接口 0 / Usage 0xFF00")),
            "WITRN K2 (USB 4-4) [接口 0 / Usage 0xFF00]"
        );
    }
}
