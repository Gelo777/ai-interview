use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct CaptureProtectionStatus {
    pub supported: bool,
    pub level: String, // "supported", "limited", "unknown"
    pub detail: String,
}

#[cfg(target_os = "macos")]
pub fn get_capture_protection_status() -> CaptureProtectionStatus {
    // macOS: NSWindow.sharingType = .none excludes window from capture.
    // On macOS 15+ some capture pipelines may ignore this flag.
    CaptureProtectionStatus {
        supported: true,
        level: "supported".to_string(),
        detail: "macOS — window sharing type exclusion is available. \
                 On macOS 15+ some browser-based capture may still include the window."
            .to_string(),
    }
}

#[cfg(target_os = "windows")]
pub fn get_capture_protection_status() -> CaptureProtectionStatus {
    CaptureProtectionStatus {
        supported: true,
        level: "supported".to_string(),
        detail: "Windows — WDA_EXCLUDEFROMCAPTURE display affinity available.".to_string(),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn get_capture_protection_status() -> CaptureProtectionStatus {
    CaptureProtectionStatus {
        supported: false,
        level: "unknown".to_string(),
        detail: "Capture protection is not available on this platform.".to_string(),
    }
}

/// Applies or removes capture protection on macOS (NSWindow sharingType).
#[cfg(target_os = "macos")]
pub fn set_capture_protection_macos(
    ns_window_ptr: *mut std::ffi::c_void,
    enabled: bool,
) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::MainThreadMarker;

    if ns_window_ptr.is_null() {
        return Err("NSWindow pointer is null".into());
    }
    let _mtm = MainThreadMarker::new().ok_or("Not on main thread")?;
    let sharing_type = if enabled {
        objc2_app_kit::NSWindowSharingType::None
    } else {
        objc2_app_kit::NSWindowSharingType::ReadOnly
    };
    let window = unsafe { &*(ns_window_ptr as *const NSWindow) };
    window.setSharingType(sharing_type);
    Ok(())
}

/// Applies or removes capture protection on Windows (SetWindowDisplayAffinity).
#[cfg(target_os = "windows")]
pub fn set_capture_protection_windows(hwnd_raw: isize, enabled: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    let affinity = if enabled {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe {
        SetWindowDisplayAffinity(hwnd, affinity).map_err(|e| e.to_string())?;
    }
    Ok(())
}
