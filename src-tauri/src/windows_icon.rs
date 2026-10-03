use std::{error::Error, io, ptr};

use tauri::{WebviewWindow, WindowEvent};
use windows_sys::Win32::{
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{
            LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_SHARED, SM_CXICON,
            SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
        },
    },
};

fn set_resource_icons(window: &WebviewWindow) -> Result<(), Box<dyn Error>> {
    let hwnd = window.hwnd()?.0;
    // Tauri's resource compiler assigns the application ICO resource ID 32512.
    let resource = 32512usize as *const u16;
    unsafe {
        let module = GetModuleHandleW(ptr::null());
        if module.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let dpi = match GetDpiForWindow(hwnd) {
            0 => 96,
            value => value,
        };
        let mut icons = Vec::with_capacity(2);
        for (kind, width, height) in [
            (ICON_SMALL, SM_CXSMICON, SM_CYSMICON),
            (ICON_BIG, SM_CXICON, SM_CYICON),
        ] {
            // Native loading selects an ICO frame and handles alpha before Windows scales it.
            // LR_SHARED keeps the handles valid for the process; they must not be destroyed.
            let icon = LoadImageW(
                module,
                resource,
                IMAGE_ICON,
                GetSystemMetricsForDpi(width, dpi),
                GetSystemMetricsForDpi(height, dpi),
                LR_SHARED,
            );
            if icon.is_null() {
                return Err(io::Error::last_os_error().into());
            }
            icons.push((kind, icon));
        }
        for (kind, icon) in icons {
            SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
        }
    }
    Ok(())
}

pub fn configure(window: &WebviewWindow) {
    if let Err(error) = set_resource_icons(window) {
        eprintln!("Failed to load Windows application icons: {error}");
    }
    let window_for_dpi = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
            if let Err(error) = set_resource_icons(&window_for_dpi) {
                eprintln!("Failed to update Windows application icons for DPI: {error}");
            }
        }
    });
}
