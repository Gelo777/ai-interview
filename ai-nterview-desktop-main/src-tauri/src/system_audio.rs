//! System audio loopback capture (what is playing on the default output device).
//! - Windows: WASAPI loopback via cpal (build input stream on default output device).
//! - macOS: ScreenCaptureKit runtime capture path via Swift helper.

#[cfg(target_os = "windows")]
use crate::audio;
#[cfg(target_os = "windows")]
use cpal::traits::DeviceTrait;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SystemAudioStatus {
    pub supported: bool,
    pub available: bool,
    pub detail: String,
}

/// Returns whether system audio loopback is supported and currently available.
pub fn get_system_audio_status(selected_output_device_id: Option<&str>) -> SystemAudioStatus {
    #[cfg(target_os = "windows")]
    {
        let device = match audio::resolve_output_device(selected_output_device_id) {
            Ok(device) => device,
            Err(detail) => {
                return SystemAudioStatus {
                    supported: true,
                    available: false,
                    detail,
                };
            }
        };
        let config = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                return SystemAudioStatus {
                    supported: true,
                    available: false,
                    detail: format!("Default output config failed: {}", e),
                };
            }
        };
        // Try to build a loopback input stream; if it succeeds we drop it immediately.
        let stream_config = config.config();
        let result = device.build_input_stream_raw(
            &stream_config,
            config.sample_format(),
            |_data: &cpal::Data, _info: &cpal::InputCallbackInfo| {},
            |err| {
                log::warn!("System audio loopback error: {}", err);
            },
            None,
        );
        match result {
            Ok(_stream) => SystemAudioStatus {
                supported: true,
                available: true,
                detail: "WASAPI loopback available. System audio can be captured.".to_string(),
            },
            Err(e) => SystemAudioStatus {
                supported: true,
                available: false,
                detail: format!("Loopback stream failed: {}", e),
            },
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = selected_output_device_id;
        let swift_available = std::process::Command::new("swift")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        SystemAudioStatus {
            supported: true,
            available: swift_available,
            detail: if swift_available {
                "ScreenCaptureKit runtime path is enabled. macOS may still prompt for Screen Recording permission on first use.".to_string()
            } else {
                "ScreenCaptureKit runtime path is enabled, but `swift` was not found in PATH. Install Xcode Command Line Tools.".to_string()
            },
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = selected_output_device_id;
        SystemAudioStatus {
            supported: false,
            available: false,
            detail: "System audio loopback is not implemented on this platform.".to_string(),
        }
    }
}
