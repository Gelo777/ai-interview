use crate::audio;
use crate::capture_protection;
use crate::install_control;
use crate::license;
use crate::ocr;
use crate::secret_store;
use crate::stt::{SttConfig, SttDiagnostic, SttStatus};
use crate::stt_runtime as vosk_stt_runtime;
use crate::system_audio;
use crate::vosk_installer;
use crate::vosk_runtime;
use crate::whisper_stt_runtime as stt_runtime;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::WebviewUrl;
use tauri::{Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[cfg(target_os = "windows")]
use std::process::Command;

const APP_STATE_DIR_NAME: &str = "state";
const NETWORK_CONNECT_TIMEOUT_SECS: u64 = 10;
const MODEL_INDEX_REQUEST_TIMEOUT_SECS: u64 = 4;
const MODEL_DOWNLOAD_REQUEST_TIMEOUT_SECS: u64 = 7_200;
const STT_STARTUP_COMMAND_TIMEOUT_SECS: u64 = 90;
const VOSK_STT_STARTUP_COMMAND_TIMEOUT_SECS: u64 = 360;
const STT_STOP_COMMAND_TIMEOUT_SECS: u64 = 70;
const WHISPER_CHUNK_SILENCE_PEAK_THRESHOLD: f32 = 0.010;
const WHISPER_CHUNK_SILENCE_RMS_THRESHOLD: f32 = 0.0035;
const WHISPER_CHUNK_TARGET_PEAK: f32 = 0.060;
const WHISPER_CHUNK_MAX_GAIN: f32 = 6.0;
const PROXY_LICENSE_TIMEOUT_SECS: u64 = 20;
const PROXY_STT_CONNECT_TIMEOUT_SECS: u64 = 5;
const PROXY_STT_TIMEOUT_SECS: u64 = 20;
const SERVER_STT_CAPTURE_TIMEOUT_GRACE_SECS: u64 = 10;
const SERVER_STT_LIVE_RING_BUFFER_SECONDS: usize = 30;
const SERVER_STT_MIC_FRAME_MS: usize = 20;
const SERVER_STT_MIC_PREROLL_MS: usize = 80;
const SERVER_STT_MIC_HANGOVER_MS: usize = 500;
const SERVER_STT_MIC_KEEPALIVE_MS: usize = 120;
const SERVER_STT_MIC_NOISE_EMA_ALPHA: f32 = 0.02;
const SERVER_STT_MIC_ADAPTIVE_MULTIPLIER: f32 = 3.0;
const SERVER_STT_MIC_ADAPTIVE_MIN_FLOOR: f32 = 20.0;
const SERVER_STT_MIC_TARGET_RMS: f64 = 4200.0;
const SERVER_STT_MIC_MIN_RMS_FOR_GAIN: f64 = 45.0;
const SERVER_STT_MIC_MAX_GAIN: f64 = 10.0;
const AUDIO_PROBE_MIN_RMS: f64 = 70.0;
const AUDIO_PROBE_MIN_PEAK_ABS: i16 = 700;
const SETTINGS_STATE_KEY: &str = "ai-interview-settings";
static SERVER_STT_PREFERRED_ENDPOINT: AtomicUsize = AtomicUsize::new(usize::MAX);
static SERVER_STT_LIVE_CAPTURE_RUNTIME: OnceLock<Mutex<Option<ServerSttLiveCaptureRuntime>>> =
    OnceLock::new();

fn app_window_url(_app: &tauri::AppHandle) -> WebviewUrl {
    #[cfg(debug_assertions)]
    {
        if let Some(dev_url) = &_app.config().build.dev_url {
            return WebviewUrl::External(dev_url.clone());
        }
    }

    WebviewUrl::App("index.html".into())
}

fn overlay_window_url(app: &tauri::AppHandle) -> WebviewUrl {
    match app_window_url(app) {
        WebviewUrl::External(mut url) => {
            url.set_query(Some("aiWindow=overlay"));
            WebviewUrl::External(url)
        }
        WebviewUrl::App(_) => WebviewUrl::App("index.html?aiWindow=overlay".into()),
        other => other,
    }
}

#[derive(Default)]
pub struct InterviewWindowLock {
    active: AtomicBool,
}

impl InterviewWindowLock {
    pub fn set_active(&self, active: bool) {
        self.active.store(active, AtomicOrdering::Relaxed);
    }

    pub fn is_active(&self) -> bool {
        self.active.load(AtomicOrdering::Relaxed)
    }
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
    pub capture_protection: String,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    let capture_protection = match os.as_str() {
        "macos" => "supported".to_string(),
        "windows" => "supported".to_string(),
        _ => "unknown".to_string(),
    };

    PlatformInfo {
        os,
        arch,
        capture_protection,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HardwareGpuInfo {
    pub name: String,
    pub vendor: Option<String>,
    pub vram_mb: Option<u64>,
    pub integrated: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HardwareProfile {
    pub os: String,
    pub arch: String,
    pub logical_cpu_cores: u32,
    pub physical_cpu_cores: Option<u32>,
    pub total_memory_mb: Option<u64>,
    pub gpus: Vec<HardwareGpuInfo>,
    pub detected_at_unix_ms: u64,
}

#[tauri::command]
pub fn get_hardware_profile() -> HardwareProfile {
    HardwareProfile {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        logical_cpu_cores: std::thread::available_parallelism()
            .map(|v| v.get() as u32)
            .unwrap_or(1),
        physical_cpu_cores: detect_physical_cpu_cores(),
        total_memory_mb: detect_total_memory_mb(),
        gpus: detect_gpu_info(),
        detected_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }
}

fn parse_u64_from_text(raw: &str) -> Option<u64> {
    let cleaned = raw.trim().replace(',', "");
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<u64>().ok()
}

#[cfg(target_os = "windows")]
fn run_powershell_script(script: &str) -> Option<String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        None
    } else {
        Some(stdout)
    }
}

#[cfg(not(target_os = "windows"))]
fn run_powershell_script(_script: &str) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn detect_physical_cpu_cores() -> Option<u32> {
    let output = run_powershell_script(
        "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
    )?;
    parse_u64_from_text(&output)
        .map(|value| value as u32)
        .filter(|v| *v > 0)
}

#[cfg(target_os = "macos")]
fn detect_physical_cpu_cores() -> Option<u32> {
    let output = std::process::Command::new("sysctl")
        .args(["-n", "hw.physicalcpu"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_u64_from_text(&stdout)
        .map(|value| value as u32)
        .filter(|v| *v > 0)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn detect_physical_cpu_cores() -> Option<u32> {
    None
}

#[cfg(target_os = "windows")]
fn detect_total_memory_mb() -> Option<u64> {
    let output =
        run_powershell_script("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")?;
    parse_u64_from_text(&output).map(|bytes| bytes / (1024 * 1024))
}

#[cfg(target_os = "macos")]
fn detect_total_memory_mb() -> Option<u64> {
    let output = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_u64_from_text(&stdout).map(|bytes| bytes / (1024 * 1024))
}

#[cfg(target_os = "linux")]
fn detect_total_memory_mb() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = content
        .lines()
        .find(|entry| entry.to_ascii_lowercase().starts_with("memtotal:"))?;
    let kb_value = line
        .split_whitespace()
        .nth(1)
        .and_then(parse_u64_from_text)?;
    Some(kb_value / 1024)
}

#[cfg(all(
    not(target_os = "windows"),
    not(target_os = "macos"),
    not(target_os = "linux")
))]
fn detect_total_memory_mb() -> Option<u64> {
    None
}

#[cfg(target_os = "windows")]
fn parse_gpu_entries(value: &serde_json::Value) -> Vec<HardwareGpuInfo> {
    let values = if value.is_array() {
        value.as_array().cloned().unwrap_or_default()
    } else {
        vec![value.clone()]
    };

    values
        .into_iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let name = object
                .get("Name")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())?;
            let vendor = object
                .get("AdapterCompatibility")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
            let vram_bytes = object.get("AdapterRAM").and_then(|v| match v {
                serde_json::Value::Number(number) => number.as_u64(),
                serde_json::Value::String(text) => parse_u64_from_text(text),
                _ => None,
            });
            let vram_mb = vram_bytes.map(|bytes| bytes / (1024 * 1024));
            let integrated = guess_integrated_gpu(&name, vendor.as_deref(), vram_mb);

            Some(HardwareGpuInfo {
                name,
                vendor,
                vram_mb,
                integrated,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn guess_integrated_gpu(name: &str, vendor: Option<&str>, vram_mb: Option<u64>) -> Option<bool> {
    let lowered_name = name.to_ascii_lowercase();
    let lowered_vendor = vendor.unwrap_or("").to_ascii_lowercase();

    if lowered_name.contains("intel")
        || lowered_name.contains("uhd")
        || lowered_name.contains("iris")
        || lowered_name.contains("integrated")
        || lowered_name.contains("radeon graphics")
        || lowered_name.contains("vega")
    {
        return Some(true);
    }

    if lowered_name.contains("nvidia")
        || lowered_name.contains("geforce")
        || lowered_name.contains("rtx")
        || lowered_name.contains("quadro")
        || lowered_name.contains("radeon rx")
        || lowered_name.contains("arc a")
    {
        return Some(false);
    }

    if lowered_vendor.contains("nvidia") {
        return Some(false);
    }
    if lowered_vendor.contains("intel") {
        return Some(true);
    }

    if let Some(vram) = vram_mb {
        if vram <= 2048 {
            return Some(true);
        }
        if vram >= 4096 {
            return Some(false);
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn detect_gpu_info() -> Vec<HardwareGpuInfo> {
    let raw = run_powershell_script(
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM | ConvertTo-Json -Compress",
    );
    let Some(raw) = raw else {
        return Vec::new();
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    parse_gpu_entries(&parsed)
}

#[cfg(not(target_os = "windows"))]
fn detect_gpu_info() -> Vec<HardwareGpuInfo> {
    Vec::new()
}

#[derive(Serialize)]
pub struct PermissionCheck {
    pub microphone: String,
    pub system_audio: String,
    pub screen_capture: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AudioDeviceSelectionRequest {
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StartSttSessionRequest {
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CaptureAudioSampleRequest {
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
    pub duration_seconds: Option<u32>,
    pub open_output_dir: Option<bool>,
}

fn normalize_optional_device_id(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[tauri::command]
pub fn check_permissions(request: Option<AudioDeviceSelectionRequest>) -> PermissionCheck {
    let request = request.unwrap_or_default();
    let has_mic =
        audio::resolve_input_device_with_fallback(request.microphone_device_id.as_deref()).is_ok();
    let has_output =
        audio::resolve_output_device_with_fallback(request.system_audio_device_id.as_deref())
            .is_ok();

    PermissionCheck {
        microphone: if has_mic {
            "granted".to_string()
        } else {
            "denied".to_string()
        },
        system_audio: if has_output {
            "granted".to_string()
        } else {
            "denied".to_string()
        },
        screen_capture: "granted".to_string(),
    }
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<audio::AudioDeviceInfo> {
    let mut devices = audio::list_input_devices();
    devices.extend(audio::list_output_devices());
    devices
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioDebugEndpoint {
    pub selected_device_id: Option<String>,
    pub selected_device: Option<audio::AudioDeviceInfo>,
    pub default_device: Option<audio::AudioDeviceInfo>,
    pub effective_device: Option<audio::AudioDeviceInfo>,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioDebugSnapshot {
    pub microphone: AudioDebugEndpoint,
    pub system_audio: AudioDebugEndpoint,
    pub system_audio_status: system_audio::SystemAudioStatus,
    pub input_devices: Vec<audio::AudioDeviceInfo>,
    pub output_devices: Vec<audio::AudioDeviceInfo>,
    pub notes: Vec<String>,
}

fn find_audio_device_info(
    devices: &[audio::AudioDeviceInfo],
    device_selector: Option<&str>,
) -> Option<audio::AudioDeviceInfo> {
    let selector = device_selector?.trim();
    if selector.is_empty() {
        return None;
    }

    devices
        .iter()
        .find(|device| device.id == selector || device.name == selector)
        .cloned()
}

fn find_default_audio_device_info(
    devices: &[audio::AudioDeviceInfo],
) -> Option<audio::AudioDeviceInfo> {
    devices.iter().find(|device| device.is_default).cloned()
}

fn build_audio_debug_endpoint(
    role: &str,
    selected_device_id: Option<String>,
    devices: &[audio::AudioDeviceInfo],
) -> AudioDebugEndpoint {
    let selected_device = find_audio_device_info(devices, selected_device_id.as_deref());
    let default_device = find_default_audio_device_info(devices);
    let effective_device = if selected_device_id.is_some() {
        selected_device.clone()
    } else {
        default_device.clone()
    };
    let available = effective_device.is_some();

    let detail = match (
        selected_device_id.as_deref(),
        selected_device.as_ref(),
        default_device.as_ref(),
    ) {
        (Some(_), Some(selected), _) => {
            format!("Using selected {}: {}", role, selected.name)
        }
        (Some(requested), None, _) => format!("Selected {} was not found: {}", role, requested),
        (None, _, Some(default_device)) => {
            format!("Using default {}: {}", role, default_device.name)
        }
        (None, _, None) => format!("No {} device is currently available", role),
    };

    AudioDebugEndpoint {
        selected_device_id,
        selected_device,
        default_device,
        effective_device,
        available,
        detail,
    }
}

#[tauri::command]
pub fn get_audio_debug_snapshot(
    request: Option<AudioDeviceSelectionRequest>,
) -> AudioDebugSnapshot {
    let request = request.unwrap_or_default();
    let selected_microphone_id = normalize_optional_device_id(request.microphone_device_id);
    let selected_system_audio_id = normalize_optional_device_id(request.system_audio_device_id);
    let input_devices = audio::list_input_devices();
    let output_devices = audio::list_output_devices();

    let microphone =
        build_audio_debug_endpoint("microphone", selected_microphone_id, &input_devices);
    let system_audio = build_audio_debug_endpoint(
        "system audio output",
        selected_system_audio_id.clone(),
        &output_devices,
    );
    let system_audio_status =
        system_audio::get_system_audio_status(selected_system_audio_id.as_deref());

    let mut notes = Vec::new();

    if input_devices.is_empty() {
        notes.push("No microphone-capable input devices were detected.".to_string());
    }

    if output_devices.is_empty() {
        notes.push("No output devices were detected for system audio capture.".to_string());
    }

    if microphone.selected_device_id.is_some() && microphone.selected_device.is_none() {
        notes.push("The selected microphone is missing.".to_string());
    }

    if system_audio.selected_device_id.is_some() && system_audio.selected_device.is_none() {
        notes.push("The selected output device is missing.".to_string());
    }

    if !system_audio_status.available {
        notes.push(format!(
            "System audio loopback is not currently available: {}",
            system_audio_status.detail
        ));
    }

    AudioDebugSnapshot {
        microphone,
        system_audio,
        system_audio_status,
        input_devices,
        output_devices,
        notes,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CapturedAudioTrack {
    pub source: String,
    pub requested_device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub sample_count: usize,
    pub duration_ms: u64,
    pub peak_abs: i16,
    pub rms: f64,
    pub file_path: Option<String>,
    #[serde(skip)]
    pub wav_bytes: Option<Vec<u8>>,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureAudioSampleResult {
    pub output_dir: String,
    pub duration_seconds: u32,
    pub microphone: CapturedAudioTrack,
    pub system_audio: CapturedAudioTrack,
    pub captured_at_unix_ms: u64,
}

struct CaptureStreamHandle {
    source: &'static str,
    stream: cpal::Stream,
    samples: Arc<Mutex<Vec<i16>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
    device_name: String,
}

struct ServerSttLiveCaptureShared {
    samples: VecDeque<i16>,
    total_samples: u64,
    stream_error: Option<String>,
}

struct ServerSttLiveCaptureTrack {
    source: &'static str,
    requested_device_id: Option<String>,
    device_name: String,
    sample_rate: u32,
    stream: cpal::Stream,
    shared: Arc<Mutex<ServerSttLiveCaptureShared>>,
    max_samples: usize,
    last_read_sample: u64,
}

struct ServerSttLiveCaptureRuntime {
    microphone_device_id: Option<String>,
    system_audio_device_id: Option<String>,
    microphone: Option<ServerSttLiveCaptureTrack>,
    microphone_detail: String,
    system_audio: Option<ServerSttLiveCaptureTrack>,
    system_audio_detail: String,
}

fn downmix_f32_to_i16_mono(data: &[f32], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            let dominant = frame
                .iter()
                .copied()
                .max_by(|left, right| {
                    left.abs()
                        .partial_cmp(&right.abs())
                        .unwrap_or(Ordering::Equal)
                })
                .unwrap_or(0.0)
                .clamp(-1.0, 1.0);
            (dominant * i16::MAX as f32) as i16
        })
        .collect()
}

fn downmix_i16_to_i16_mono(data: &[i16], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            frame
                .iter()
                .copied()
                .max_by_key(|sample| sample.unsigned_abs())
                .unwrap_or(0)
        })
        .collect()
}

fn downmix_u16_to_i16_mono(data: &[u16], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            frame
                .iter()
                .map(|sample| (*sample as i32) - 32768)
                .max_by_key(|sample| sample.unsigned_abs())
                .unwrap_or(0) as i16
        })
        .collect()
}

fn build_capture_stream_handle(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    source: &'static str,
    label: &str,
) -> Result<CaptureStreamHandle, String> {
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate;
    let samples = Arc::new(Mutex::new(Vec::<i16>::new()));
    let stream_error = Arc::new(Mutex::new(None::<String>));

    let stream = match sample_format {
        SampleFormat::F32 => {
            let callback_samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&stream_error);
            let label_owned = label.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32_to_i16_mono(data, channels);
                        if let Ok(mut guard) = callback_samples.lock() {
                            guard.extend_from_slice(&mono);
                        }
                    },
                    move |err| {
                        if let Ok(mut guard) = callback_error.lock() {
                            *guard = Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", label, err))?
        }
        SampleFormat::I16 => {
            let callback_samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&stream_error);
            let label_owned = label.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        let mono = downmix_i16_to_i16_mono(data, channels);
                        if let Ok(mut guard) = callback_samples.lock() {
                            guard.extend_from_slice(&mono);
                        }
                    },
                    move |err| {
                        if let Ok(mut guard) = callback_error.lock() {
                            *guard = Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", label, err))?
        }
        SampleFormat::U16 => {
            let callback_samples = Arc::clone(&samples);
            let callback_error = Arc::clone(&stream_error);
            let label_owned = label.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        let mono = downmix_u16_to_i16_mono(data, channels);
                        if let Ok(mut guard) = callback_samples.lock() {
                            guard.extend_from_slice(&mono);
                        }
                    },
                    move |err| {
                        if let Ok(mut guard) = callback_error.lock() {
                            *guard = Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", label, err))?
        }
        other => {
            return Err(format!(
                "Unsupported sample format for {} stream: {:?}",
                label, other
            ));
        }
    };

    Ok(CaptureStreamHandle {
        source,
        stream,
        samples,
        stream_error,
        sample_rate,
        device_name: label.to_string(),
    })
}

fn server_stt_live_capture_runtime_cell() -> &'static Mutex<Option<ServerSttLiveCaptureRuntime>> {
    SERVER_STT_LIVE_CAPTURE_RUNTIME.get_or_init(|| Mutex::new(None))
}

fn push_server_stt_live_samples(
    shared: &Arc<Mutex<ServerSttLiveCaptureShared>>,
    max_samples: usize,
    mono_samples: &[i16],
) {
    if mono_samples.is_empty() {
        return;
    }

    if let Ok(mut guard) = shared.lock() {
        if mono_samples.len() >= max_samples {
            guard.samples.clear();
            guard.samples.extend(
                mono_samples[mono_samples.len() - max_samples..]
                    .iter()
                    .copied(),
            );
        } else {
            let overflow = guard
                .samples
                .len()
                .saturating_add(mono_samples.len())
                .saturating_sub(max_samples);
            for _ in 0..overflow {
                guard.samples.pop_front();
            }
            guard.samples.extend(mono_samples.iter().copied());
        }
        guard.total_samples = guard
            .total_samples
            .saturating_add(mono_samples.len() as u64);
    }
}

fn build_server_stt_live_capture_track(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    source: &'static str,
    requested_device_id: Option<String>,
    device_name: String,
    detail_prefix: String,
) -> Result<ServerSttLiveCaptureTrack, String> {
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate;
    let max_samples = (sample_rate as usize)
        .saturating_mul(SERVER_STT_LIVE_RING_BUFFER_SECONDS)
        .max(sample_rate as usize);
    let shared = Arc::new(Mutex::new(ServerSttLiveCaptureShared {
        samples: VecDeque::with_capacity(max_samples.min(sample_rate as usize * 4)),
        total_samples: 0,
        stream_error: None,
    }));

    let stream = match sample_format {
        SampleFormat::F32 => {
            let callback_shared = Arc::clone(&shared);
            let error_shared = Arc::clone(&shared);
            let label_owned = detail_prefix.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32_to_i16_mono(data, channels);
                        push_server_stt_live_samples(&callback_shared, max_samples, &mono);
                    },
                    move |err| {
                        if let Ok(mut guard) = error_shared.lock() {
                            guard.stream_error =
                                Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", detail_prefix, err))?
        }
        SampleFormat::I16 => {
            let callback_shared = Arc::clone(&shared);
            let error_shared = Arc::clone(&shared);
            let label_owned = detail_prefix.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        let mono = downmix_i16_to_i16_mono(data, channels);
                        push_server_stt_live_samples(&callback_shared, max_samples, &mono);
                    },
                    move |err| {
                        if let Ok(mut guard) = error_shared.lock() {
                            guard.stream_error =
                                Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", detail_prefix, err))?
        }
        SampleFormat::U16 => {
            let callback_shared = Arc::clone(&shared);
            let error_shared = Arc::clone(&shared);
            let label_owned = detail_prefix.clone();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        let mono = downmix_u16_to_i16_mono(data, channels);
                        push_server_stt_live_samples(&callback_shared, max_samples, &mono);
                    },
                    move |err| {
                        if let Ok(mut guard) = error_shared.lock() {
                            guard.stream_error =
                                Some(format!("{} stream error: {}", label_owned, err));
                        }
                    },
                    None,
                )
                .map_err(|err| format!("Failed to build {} stream: {}", detail_prefix, err))?
        }
        other => {
            return Err(format!(
                "Unsupported sample format for {} stream: {:?}",
                detail_prefix, other
            ));
        }
    };

    Ok(ServerSttLiveCaptureTrack {
        source,
        requested_device_id,
        device_name,
        sample_rate,
        stream,
        shared,
        max_samples,
        last_read_sample: 0,
    })
}

fn start_server_stt_live_capture_runtime(
    microphone_device_id: Option<String>,
    system_audio_device_id: Option<String>,
) -> Result<ServerSttLiveCaptureRuntime, String> {
    let mut microphone: Option<ServerSttLiveCaptureTrack> = None;
    let microphone_detail: String;
    let mut system_audio: Option<ServerSttLiveCaptureTrack> = None;
    let system_audio_detail: String;

    match audio::resolve_input_device_with_fallback(microphone_device_id.as_deref()) {
        Ok((device, warning)) => {
            let device_name = audio::resolve_device_name(&device);
            match device.default_input_config() {
                Ok(supported) => {
                    let detail_prefix = format!("microphone '{}'", device_name);
                    match build_server_stt_live_capture_track(
                        &device,
                        &supported.config(),
                        supported.sample_format(),
                        "mic",
                        microphone_device_id.clone(),
                        device_name.clone(),
                        detail_prefix,
                    ) {
                        Ok(track) => {
                            track.stream.play().map_err(|err| {
                                format!("Failed to start live microphone stream: {}", err)
                            })?;
                            microphone_detail = match warning {
                                Some(warn) => {
                                    format!("{} Live microphone buffer '{}'.", warn, device_name)
                                }
                                None => format!("Live microphone buffer '{}'.", device_name),
                            };
                            microphone = Some(track);
                        }
                        Err(err) => {
                            microphone_detail = err;
                        }
                    }
                }
                Err(err) => {
                    microphone_detail = format!(
                        "Failed to read microphone format '{}': {}",
                        device_name, err
                    );
                }
            }
        }
        Err(err) => {
            microphone_detail = err;
        }
    }

    #[cfg(target_os = "windows")]
    {
        match audio::resolve_output_device_with_fallback(system_audio_device_id.as_deref()) {
            Ok((device, warning)) => {
                let device_name = audio::resolve_device_name(&device);
                match device.default_output_config() {
                    Ok(supported) => {
                        let detail_prefix = format!("system audio '{}'", device_name);
                        match build_server_stt_live_capture_track(
                            &device,
                            &supported.config(),
                            supported.sample_format(),
                            "system",
                            system_audio_device_id.clone(),
                            device_name.clone(),
                            detail_prefix,
                        ) {
                            Ok(track) => {
                                track.stream.play().map_err(|err| {
                                    format!("Failed to start live system-audio stream: {}", err)
                                })?;
                                system_audio_detail = match warning {
                                    Some(warn) => {
                                        format!(
                                            "{} Live system-audio buffer '{}'.",
                                            warn, device_name
                                        )
                                    }
                                    None => format!("Live system-audio buffer '{}'.", device_name),
                                };
                                system_audio = Some(track);
                            }
                            Err(err) => {
                                system_audio_detail = err;
                            }
                        }
                    }
                    Err(err) => {
                        system_audio_detail = format!(
                            "Failed to read output format '{}' for loopback capture: {}",
                            device_name, err
                        );
                    }
                }
            }
            Err(err) => {
                system_audio_detail = err;
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = system_audio_device_id;
        system_audio_detail =
            "Live system-audio capture is currently available only on Windows.".to_string();
    }

    if microphone.is_none() && system_audio.is_none() {
        return Err(format!(
            "No audio source is available for live capture. Mic: {} | System: {}",
            microphone_detail, system_audio_detail
        ));
    }

    Ok(ServerSttLiveCaptureRuntime {
        microphone_device_id,
        system_audio_device_id,
        microphone,
        microphone_detail,
        system_audio,
        system_audio_detail,
    })
}

fn read_server_stt_live_capture_track(
    track: &mut ServerSttLiveCaptureTrack,
    apply_server_stt_mic_conditioning: bool,
) -> CapturedAudioTrack {
    let (mut sample_data, stream_error_text, first_sample_index, total_samples) =
        match track.shared.lock() {
            Ok(guard) => {
                let first_sample_index = guard
                    .total_samples
                    .saturating_sub(guard.samples.len() as u64);
                let start_sample = track.last_read_sample.max(first_sample_index);
                let offset = start_sample
                    .saturating_sub(first_sample_index)
                    .min(guard.samples.len() as u64) as usize;
                let sample_data = guard
                    .samples
                    .iter()
                    .skip(offset)
                    .copied()
                    .collect::<Vec<_>>();
                (
                    sample_data,
                    guard.stream_error.clone(),
                    first_sample_index,
                    guard.total_samples,
                )
            }
            Err(_) => {
                return unavailable_captured_track(
                    track.source,
                    track.requested_device_id.clone(),
                    format!("Failed to read live '{}' ring buffer.", track.source),
                );
            }
        };

    track.last_read_sample = total_samples;

    if apply_server_stt_mic_conditioning && track.source == "mic" {
        let (conditioned, _voiced_detected) =
            condition_server_stt_mic_chunk(&sample_data, track.sample_rate);
        sample_data = conditioned;
    }

    let duration_ms = if track.sample_rate == 0 {
        0
    } else {
        ((sample_data.len() as f64 / track.sample_rate as f64) * 1000.0) as u64
    };
    let peak_abs = audio_peak_abs_i16(&sample_data);
    let rms = audio_rms_i16(&sample_data);
    let wav_bytes = if sample_data.is_empty() {
        None
    } else {
        Some(build_pcm16_mono_wav_bytes(track.sample_rate, &sample_data))
    };

    let detail = if let Some(err) = stream_error_text {
        format!("Live ring buffer captured with stream warnings: {}", err)
    } else if sample_data.is_empty() {
        format!(
            "No new samples in live ring buffer for '{}'. firstSample={} totalSamples={} maxSamples={}",
            track.device_name, first_sample_index, total_samples, track.max_samples
        )
    } else {
        format!("Live ring buffer '{}'.", track.device_name)
    };

    CapturedAudioTrack {
        source: track.source.to_string(),
        requested_device_id: track.requested_device_id.clone(),
        device_name: Some(track.device_name.clone()),
        sample_rate: Some(track.sample_rate),
        sample_count: sample_data.len(),
        duration_ms,
        peak_abs,
        rms,
        file_path: None,
        wav_bytes,
        available: !sample_data.is_empty(),
        detail,
    }
}

fn capture_server_stt_chunk_blocking(
    app: &tauri::AppHandle,
    microphone_device_id: Option<String>,
    system_audio_device_id: Option<String>,
    duration_ms: u32,
) -> Result<CaptureAudioSampleResult, String> {
    let captured_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let output_dir = app
        .path()
        .app_data_dir()
        .map(|dir| {
            dir.join("diagnostics")
                .join("audio-capture")
                .join(format!("live-{}", captured_at_unix_ms))
        })
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();

    {
        let cell = server_stt_live_capture_runtime_cell();
        let mut guard = cell
            .lock()
            .map_err(|_| "Failed to lock live server STT audio runtime.".to_string())?;
        let rebuild = guard
            .as_ref()
            .map(|runtime| {
                runtime.microphone_device_id != microphone_device_id
                    || runtime.system_audio_device_id != system_audio_device_id
            })
            .unwrap_or(true);
        if rebuild {
            *guard = Some(start_server_stt_live_capture_runtime(
                microphone_device_id.clone(),
                system_audio_device_id.clone(),
            )?);
        }
    }

    // The capture runtime keeps recording between calls, so this only decides how
    // much audio has piled up before we drain it. Dictation drains far more often
    // than the background stream so words reach the input field quickly.
    std::thread::sleep(Duration::from_millis(duration_ms as u64));

    let cell = server_stt_live_capture_runtime_cell();
    let mut guard = cell
        .lock()
        .map_err(|_| "Failed to lock live server STT audio runtime.".to_string())?;
    let runtime = guard
        .as_mut()
        .ok_or_else(|| "Live server STT audio runtime is not started.".to_string())?;

    let microphone = if let Some(track) = runtime.microphone.as_mut() {
        read_server_stt_live_capture_track(track, true)
    } else {
        unavailable_captured_track(
            "mic",
            microphone_device_id,
            runtime.microphone_detail.clone(),
        )
    };
    let system_audio = if let Some(track) = runtime.system_audio.as_mut() {
        read_server_stt_live_capture_track(track, false)
    } else {
        unavailable_captured_track(
            "system",
            system_audio_device_id,
            runtime.system_audio_detail.clone(),
        )
    };

    Ok(CaptureAudioSampleResult {
        output_dir,
        duration_seconds: duration_ms / 1000,
        microphone,
        system_audio,
        captured_at_unix_ms,
    })
}

fn stop_server_stt_live_capture_runtime() -> Result<(), String> {
    let cell = server_stt_live_capture_runtime_cell();
    let mut guard = cell
        .lock()
        .map_err(|_| "Failed to lock live server STT audio runtime.".to_string())?;
    *guard = None;
    Ok(())
}

fn build_pcm16_mono_wav_bytes(sample_rate: u32, samples: &[i16]) -> Vec<u8> {
    let channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let block_align: u16 = channels * (bits_per_sample / 8);
    let byte_rate: u32 = sample_rate * block_align as u32;
    let data_len = (samples.len() as u32).saturating_mul(2);
    let riff_chunk_len = 36u32.saturating_add(data_len);

    let mut bytes = Vec::with_capacity(44usize.saturating_add(samples.len().saturating_mul(2)));
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_chunk_len.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod audio_recording_tests {
    use super::{
        audio_has_productive_signal, audio_peak_abs_i16, audio_rms_i16, build_pcm16_mono_wav_bytes,
        condition_server_stt_mic_chunk,
    };

    const DRIVE_VIDEO_AUDIO_FIXTURES: &[(&str, &[u8])] = &[
        (
            "drive-clip-0000-0012.wav",
            include_bytes!("../../tests/fixtures/audio/drive-clip-0000-0012.wav"),
        ),
        (
            "drive-clip-0060-0072.wav",
            include_bytes!("../../tests/fixtures/audio/drive-clip-0060-0072.wav"),
        ),
    ];

    #[derive(Debug)]
    struct FixtureWav {
        sample_rate: u32,
        samples: Vec<i16>,
    }

    fn read_u16_le(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }

    fn read_i16_le(bytes: &[u8], offset: usize) -> i16 {
        i16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    fn parse_pcm16_mono_wav(bytes: &[u8]) -> FixtureWav {
        assert!(bytes.len() >= 44, "fixture is too short to be a wav file");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");

        let mut offset = 12usize;
        let mut sample_rate = None;
        let mut data_offset = None;
        let mut data_len = None;

        while offset + 8 <= bytes.len() {
            let chunk_id = &bytes[offset..offset + 4];
            let chunk_len = read_u32_le(bytes, offset + 4) as usize;
            let payload_offset = offset + 8;
            let payload_end = payload_offset.saturating_add(chunk_len);
            assert!(
                payload_end <= bytes.len(),
                "wav chunk extends past fixture bytes"
            );

            match chunk_id {
                b"fmt " => {
                    assert!(chunk_len >= 16, "fmt chunk is too short");
                    assert_eq!(read_u16_le(bytes, payload_offset), 1, "expected PCM wav");
                    assert_eq!(
                        read_u16_le(bytes, payload_offset + 2),
                        1,
                        "expected mono wav"
                    );
                    sample_rate = Some(read_u32_le(bytes, payload_offset + 4));
                    assert_eq!(
                        read_u16_le(bytes, payload_offset + 14),
                        16,
                        "expected 16-bit wav"
                    );
                }
                b"data" => {
                    data_offset = Some(payload_offset);
                    data_len = Some(chunk_len);
                }
                _ => {}
            }

            offset = payload_end + (chunk_len % 2);
        }

        let sample_rate = sample_rate.expect("fixture wav has no fmt chunk");
        let data_offset = data_offset.expect("fixture wav has no data chunk");
        let data_len = data_len.expect("fixture wav has no data length");
        assert_eq!(data_len % 2, 0, "pcm16 payload must be sample-aligned");

        let samples = (data_offset..data_offset + data_len)
            .step_by(2)
            .map(|index| read_i16_le(bytes, index))
            .collect::<Vec<_>>();

        FixtureWav {
            sample_rate,
            samples,
        }
    }

    #[test]
    fn in_memory_recording_wav_has_valid_pcm16_mono_header_and_samples() {
        let wav = build_pcm16_mono_wav_bytes(48_000, &[0, 1024, -1024]);

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(read_u32_le(&wav, 4), 42);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(read_u32_le(&wav, 16), 16);
        assert_eq!(read_u16_le(&wav, 20), 1);
        assert_eq!(read_u16_le(&wav, 22), 1);
        assert_eq!(read_u32_le(&wav, 24), 48_000);
        assert_eq!(read_u32_le(&wav, 28), 96_000);
        assert_eq!(read_u16_le(&wav, 32), 2);
        assert_eq!(read_u16_le(&wav, 34), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(read_u32_le(&wav, 40), 6);
        assert_eq!(read_u16_le(&wav, 44), 0);
        assert_eq!(read_u16_le(&wav, 46), 1024);
        assert_eq!(read_u16_le(&wav, 48), (-1024i16) as u16);
    }

    #[test]
    fn in_memory_recording_wav_supports_empty_audio_payload() {
        let wav = build_pcm16_mono_wav_bytes(16_000, &[]);

        assert_eq!(wav.len(), 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(read_u32_le(&wav, 4), 36);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(read_u32_le(&wav, 40), 0);
    }

    #[test]
    fn drive_video_audio_fixtures_are_valid_recording_input() {
        for (fixture_name, bytes) in DRIVE_VIDEO_AUDIO_FIXTURES {
            let wav = parse_pcm16_mono_wav(bytes);
            let peak_abs = audio_peak_abs_i16(&wav.samples);
            let rms = audio_rms_i16(&wav.samples);
            let rebuilt = build_pcm16_mono_wav_bytes(wav.sample_rate, &wav.samples);
            let rebuilt_wav = parse_pcm16_mono_wav(&rebuilt);

            assert_eq!(wav.sample_rate, 16_000, "{fixture_name}");
            assert_eq!(wav.samples.len(), 192_000, "{fixture_name}");
            assert_eq!(rebuilt_wav.sample_rate, wav.sample_rate, "{fixture_name}");
            assert_eq!(rebuilt_wav.samples, wav.samples, "{fixture_name}");
            assert!(
                audio_has_productive_signal(peak_abs, rms),
                "{fixture_name}: expected productive signal, peak_abs={peak_abs}, rms={rms:.2}"
            );
            assert!(
                peak_abs >= 8_000,
                "{fixture_name}: expected real speech-level peaks, peak_abs={peak_abs}"
            );
            assert!(
                rms >= 1_500.0,
                "{fixture_name}: expected non-silent RMS, rms={rms:.2}"
            );
        }
    }

    #[test]
    fn drive_video_audio_windows_do_not_trip_silence_detection() {
        let eight_seconds = 8 * 16_000;

        for (fixture_name, bytes) in DRIVE_VIDEO_AUDIO_FIXTURES {
            let wav = parse_pcm16_mono_wav(bytes);
            let windows = [
                ("first-8s", &wav.samples[..eight_seconds]),
                ("last-8s", &wav.samples[wav.samples.len() - eight_seconds..]),
            ];

            for (window_name, samples) in windows {
                let peak_abs = audio_peak_abs_i16(samples);
                let rms = audio_rms_i16(samples);

                assert!(
                    audio_has_productive_signal(peak_abs, rms),
                    "{fixture_name}/{window_name}: should not be treated as silence, peak_abs={peak_abs}, rms={rms:.2}"
                );
            }
        }
    }

    #[test]
    fn drive_video_microphone_conditioning_preserves_real_speech() {
        for (fixture_name, bytes) in DRIVE_VIDEO_AUDIO_FIXTURES {
            let wav = parse_pcm16_mono_wav(bytes);
            let (conditioned, voiced_detected) =
                condition_server_stt_mic_chunk(&wav.samples, wav.sample_rate);
            let conditioned_peak = audio_peak_abs_i16(&conditioned);
            let conditioned_rms = audio_rms_i16(&conditioned);

            assert!(voiced_detected, "{fixture_name}: expected voiced speech");
            assert!(
                conditioned.len() >= wav.sample_rate as usize,
                "{fixture_name}: conditioning should keep at least 1s of speech"
            );
            assert!(
                audio_has_productive_signal(conditioned_peak, conditioned_rms),
                "{fixture_name}: conditioned speech should remain productive, peak_abs={conditioned_peak}, rms={conditioned_rms:.2}"
            );
        }
    }
}

fn audio_rms_i16(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let squared_sum = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum::<f64>();
    (squared_sum / samples.len() as f64).sqrt()
}

fn audio_peak_abs_i16(samples: &[i16]) -> i16 {
    samples
        .iter()
        .copied()
        .map(|sample| sample.saturating_abs())
        .max()
        .unwrap_or(0)
}

fn audio_signal_score(peak_abs: i16, rms: f64) -> f64 {
    rms + (peak_abs as f64 / 20.0)
}

fn audio_has_productive_signal(peak_abs: i16, rms: f64) -> bool {
    rms >= AUDIO_PROBE_MIN_RMS || peak_abs >= AUDIO_PROBE_MIN_PEAK_ABS
}

fn resolve_probe_device(
    source: &str,
    device_selector: Option<&str>,
    allow_fallback: bool,
) -> Result<(cpal::Device, Option<String>), String> {
    match source {
        "mic" => {
            if allow_fallback {
                return audio::resolve_input_device_with_fallback(device_selector);
            }
            match normalize_optional_device_id(device_selector.map(String::from)) {
                Some(selector) => audio::find_input_device(Some(&selector))
                    .map(|device| (device, None))
                    .ok_or_else(|| {
                        format!("Selected microphone device is not available: {}", selector)
                    }),
                None => audio::find_input_device(None)
                    .map(|device| (device, None))
                    .ok_or_else(|| "Microphone input device is not available".to_string()),
            }
        }
        "system" => {
            if allow_fallback {
                return audio::resolve_output_device_with_fallback(device_selector);
            }
            match normalize_optional_device_id(device_selector.map(String::from)) {
                Some(selector) => audio::find_output_device(Some(&selector))
                    .map(|device| (device, None))
                    .ok_or_else(|| {
                        format!("Selected output device is not available: {}", selector)
                    }),
                None => audio::find_output_device(None)
                    .map(|device| (device, None))
                    .ok_or_else(|| {
                        "Default output device is not available for loopback".to_string()
                    }),
            }
        }
        other => Err(format!("Unknown audio probe source: {}", other)),
    }
}

fn unavailable_captured_track(
    source: &str,
    requested_device_id: Option<String>,
    detail: String,
) -> CapturedAudioTrack {
    CapturedAudioTrack {
        source: source.to_string(),
        requested_device_id,
        device_name: None,
        sample_rate: None,
        sample_count: 0,
        duration_ms: 0,
        peak_abs: 0,
        rms: 0.0,
        file_path: None,
        wav_bytes: None,
        available: false,
        detail,
    }
}

fn capture_audio_track_signal_blocking(
    source: &'static str,
    device_selector: Option<String>,
    duration_seconds: u32,
    allow_fallback: bool,
    apply_server_stt_mic_conditioning: bool,
) -> CapturedAudioTrack {
    let requested_device_id = normalize_optional_device_id(device_selector);
    let (device, warning) =
        match resolve_probe_device(source, requested_device_id.as_deref(), allow_fallback) {
            Ok(resolved) => resolved,
            Err(err) => {
                return unavailable_captured_track(source, requested_device_id, err);
            }
        };
    let device_name = audio::resolve_device_name(&device);
    let config_result = if source == "mic" {
        device
            .default_input_config()
            .map(|supported| (supported.config(), supported.sample_format()))
            .map_err(|err| {
                format!(
                    "Failed to read microphone format '{}': {}",
                    device_name, err
                )
            })
    } else {
        device
            .default_output_config()
            .map(|supported| (supported.config(), supported.sample_format()))
            .map_err(|err| {
                format!(
                    "Failed to read output format '{}' for loopback capture: {}",
                    device_name, err
                )
            })
    };
    let (stream_config, sample_format) = match config_result {
        Ok(config) => config,
        Err(err) => {
            return unavailable_captured_track(source, requested_device_id, err);
        }
    };
    let label = if source == "mic" {
        format!("microphone '{}'", device_name)
    } else {
        format!("system audio '{}'", device_name)
    };
    let handle =
        match build_capture_stream_handle(&device, &stream_config, sample_format, source, &label) {
            Ok(handle) => handle,
            Err(err) => {
                return unavailable_captured_track(source, requested_device_id, err);
            }
        };

    if let Err(err) = handle.stream.play() {
        return unavailable_captured_track(
            source,
            requested_device_id,
            format!("Failed to start '{}' capture stream: {}", source, err),
        );
    }

    std::thread::sleep(Duration::from_secs(duration_seconds as u64));

    let sample_rate = handle.sample_rate;
    let CaptureStreamHandle {
        stream,
        samples,
        stream_error,
        ..
    } = handle;
    drop(stream);

    let mut sample_data = samples
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if apply_server_stt_mic_conditioning && source == "mic" {
        let (conditioned, _voiced_detected) =
            condition_server_stt_mic_chunk(&sample_data, sample_rate);
        sample_data = conditioned;
    }
    let stream_error_text = stream_error.lock().ok().and_then(|guard| (*guard).clone());
    let duration_ms = if sample_rate == 0 {
        0
    } else {
        ((sample_data.len() as f64 / sample_rate as f64) * 1000.0) as u64
    };
    let peak_abs = audio_peak_abs_i16(&sample_data);
    let rms = audio_rms_i16(&sample_data);
    let detail = match (warning, stream_error_text) {
        (_, Some(err)) => format!("Captured with stream warnings: {}", err),
        (Some(warn), None) => format!("{} Captured from '{}'.", warn, device_name),
        (None, None) => format!("Captured from '{}'.", device_name),
    };

    CapturedAudioTrack {
        source: source.to_string(),
        requested_device_id,
        device_name: Some(device_name),
        sample_rate: Some(sample_rate),
        sample_count: sample_data.len(),
        duration_ms,
        peak_abs,
        rms,
        file_path: None,
        wav_bytes: None,
        available: true,
        detail,
    }
}

fn ceil_ms_to_samples(sample_rate: u32, duration_ms: usize) -> usize {
    (((sample_rate as usize).saturating_mul(duration_ms)).saturating_add(999) / 1000).max(1)
}

fn ceil_ms_to_frames(duration_ms: usize, frame_ms: usize) -> usize {
    if frame_ms == 0 {
        return 0;
    }
    (duration_ms.saturating_add(frame_ms).saturating_sub(1) / frame_ms).max(1)
}

fn condition_server_stt_mic_chunk(samples: &[i16], sample_rate: u32) -> (Vec<i16>, bool) {
    if samples.is_empty() || sample_rate == 0 {
        return (samples.to_vec(), false);
    }

    let frame_len = ceil_ms_to_samples(sample_rate, SERVER_STT_MIC_FRAME_MS);
    let preroll_frames = ceil_ms_to_frames(SERVER_STT_MIC_PREROLL_MS, SERVER_STT_MIC_FRAME_MS);
    let hangover_frames = ceil_ms_to_frames(SERVER_STT_MIC_HANGOVER_MS, SERVER_STT_MIC_FRAME_MS);
    let keepalive_samples = ceil_ms_to_samples(sample_rate, SERVER_STT_MIC_KEEPALIVE_MS);

    let frame_rms: Vec<f64> = samples.chunks(frame_len).map(audio_rms_i16).collect();
    if frame_rms.is_empty() {
        return (vec![0; keepalive_samples], false);
    }

    let mut voiced_frames = vec![false; frame_rms.len()];
    let mut noise_floor = SERVER_STT_MIC_ADAPTIVE_MIN_FLOOR as f64;
    let alpha = SERVER_STT_MIC_NOISE_EMA_ALPHA as f64;
    let min_floor = SERVER_STT_MIC_ADAPTIVE_MIN_FLOOR as f64;
    let adaptive_multiplier = SERVER_STT_MIC_ADAPTIVE_MULTIPLIER as f64;
    let mut hangover_left = 0usize;

    for (index, rms) in frame_rms.iter().copied().enumerate() {
        let threshold = (noise_floor * adaptive_multiplier).max(min_floor);
        let raw_voiced = rms >= threshold;
        let voiced = if raw_voiced {
            hangover_left = hangover_frames;
            true
        } else if hangover_left > 0 {
            hangover_left = hangover_left.saturating_sub(1);
            true
        } else {
            false
        };
        voiced_frames[index] = voiced;

        if !raw_voiced {
            noise_floor = ((1.0 - alpha) * noise_floor) + (alpha * rms.max(1.0));
        } else {
            let capped = rms.min(noise_floor * 2.0 + min_floor);
            noise_floor = ((1.0 - alpha * 0.25) * noise_floor) + ((alpha * 0.25) * capped);
        }
        noise_floor = noise_floor.max(1.0);
    }

    if preroll_frames > 0 {
        let mut expanded = voiced_frames.clone();
        for index in 0..voiced_frames.len() {
            if !voiced_frames[index] {
                continue;
            }
            let start = index.saturating_sub(preroll_frames);
            for item in expanded.iter_mut().take(index).skip(start) {
                *item = true;
            }
        }
        voiced_frames = expanded;
    }

    let mut voiced_samples: Vec<i16> = Vec::with_capacity(samples.len());
    for (frame_index, frame_samples) in samples.chunks(frame_len).enumerate() {
        if voiced_frames.get(frame_index).copied().unwrap_or(false) {
            voiced_samples.extend_from_slice(frame_samples);
        }
    }

    let voiced_detected = !voiced_samples.is_empty();
    let mut conditioned = if voiced_detected {
        voiced_samples
    } else {
        samples.to_vec()
    };

    if conditioned.len() < keepalive_samples {
        conditioned.resize(keepalive_samples, 0);
    }

    let rms = audio_rms_i16(&conditioned);
    if rms > 0.0 {
        let stabilized_rms = rms.max(SERVER_STT_MIC_MIN_RMS_FOR_GAIN);
        let gain = (SERVER_STT_MIC_TARGET_RMS / stabilized_rms).clamp(1.0, SERVER_STT_MIC_MAX_GAIN);
        apply_gain_i16_in_place(&mut conditioned, gain as f32);
    }

    (conditioned, voiced_detected)
}

fn capture_audio_sample_blocking(
    app: &tauri::AppHandle,
    microphone_device_id: Option<String>,
    system_audio_device_id: Option<String>,
    duration_seconds: u32,
    save_to_disk: bool,
    open_output_dir: bool,
    apply_server_stt_mic_conditioning: bool,
) -> Result<CaptureAudioSampleResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let base_output_dir = app_data_dir.join("diagnostics").join("audio-capture");
    if save_to_disk {
        std::fs::create_dir_all(&base_output_dir)
            .map_err(|err| format!("Не удалось создать папку для аудио-теста: {}", err))?;
    }
    let captured_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let output_dir = base_output_dir.join(format!("capture-{}", captured_at_unix_ms));
    if save_to_disk {
        std::fs::create_dir_all(&output_dir)
            .map_err(|err| format!("Failed to create audio capture folder: {}", err))?;
    }

    let mut microphone_track = CapturedAudioTrack {
        source: "mic".to_string(),
        requested_device_id: microphone_device_id.clone(),
        device_name: None,
        sample_rate: None,
        sample_count: 0,
        duration_ms: 0,
        peak_abs: 0,
        rms: 0.0,
        file_path: None,
        wav_bytes: None,
        available: false,
        detail: "Microphone capture was not started.".to_string(),
    };
    let mut system_audio_track = CapturedAudioTrack {
        source: "system".to_string(),
        requested_device_id: system_audio_device_id.clone(),
        device_name: None,
        sample_rate: None,
        sample_count: 0,
        duration_ms: 0,
        peak_abs: 0,
        rms: 0.0,
        file_path: None,
        wav_bytes: None,
        available: false,
        detail: "System audio capture was not started.".to_string(),
    };

    let mut stream_handles: Vec<CaptureStreamHandle> = Vec::new();

    match audio::resolve_input_device_with_fallback(microphone_device_id.as_deref()) {
        Ok((device, warning)) => {
            let device_name = audio::resolve_device_name(&device);
            match device.default_input_config() {
                Ok(supported) => {
                    let stream_config = supported.config();
                    match build_capture_stream_handle(
                        &device,
                        &stream_config,
                        supported.sample_format(),
                        "mic",
                        &format!("microphone '{}'", device_name),
                    ) {
                        Ok(handle) => {
                            microphone_track.available = true;
                            microphone_track.device_name = Some(device_name.clone());
                            microphone_track.sample_rate = Some(handle.sample_rate);
                            microphone_track.detail = match warning {
                                Some(warn) => {
                                    format!("{} Capturing microphone '{}'.", warn, device_name)
                                }
                                None => format!("Capturing microphone '{}'.", device_name),
                            };
                            stream_handles.push(handle);
                        }
                        Err(err) => {
                            microphone_track.detail = err;
                        }
                    }
                }
                Err(err) => {
                    microphone_track.detail = format!(
                        "Failed to read microphone format '{}': {}",
                        device_name, err
                    );
                }
            }
        }
        Err(err) => {
            microphone_track.detail = err;
        }
    }

    #[cfg(target_os = "windows")]
    {
        match audio::resolve_output_device_with_fallback(system_audio_device_id.as_deref()) {
            Ok((device, warning)) => {
                let device_name = audio::resolve_device_name(&device);
                match device.default_output_config() {
                    Ok(supported) => {
                        let stream_config = supported.config();
                        match build_capture_stream_handle(
                            &device,
                            &stream_config,
                            supported.sample_format(),
                            "system",
                            &format!("system audio '{}'", device_name),
                        ) {
                            Ok(handle) => {
                                system_audio_track.available = true;
                                system_audio_track.device_name = Some(device_name.clone());
                                system_audio_track.sample_rate = Some(handle.sample_rate);
                                system_audio_track.detail = match warning {
                                    Some(warn) => format!(
                                        "{} Capturing system audio '{}'.",
                                        warn, device_name
                                    ),
                                    None => format!("Capturing system audio '{}'.", device_name),
                                };
                                stream_handles.push(handle);
                            }
                            Err(err) => {
                                system_audio_track.detail = err;
                            }
                        }
                    }
                    Err(err) => {
                        system_audio_track.detail = format!(
                            "Failed to read output format '{}' for loopback capture: {}",
                            device_name, err
                        );
                    }
                }
            }
            Err(err) => {
                system_audio_track.detail = err;
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = system_audio_device_id;
        system_audio_track.detail =
            "Тест системного звука сейчас доступен только на Windows.".to_string();
    }

    if stream_handles.is_empty() {
        return Err(format!(
            "No audio source is available for capture. Mic: {} | System: {}",
            microphone_track.detail, system_audio_track.detail
        ));
    }

    for handle in &stream_handles {
        handle.stream.play().map_err(|err| {
            format!(
                "Failed to start '{}' capture stream: {}",
                handle.source, err
            )
        })?;
    }

    std::thread::sleep(Duration::from_secs(duration_seconds as u64));

    for handle in stream_handles {
        let source = handle.source;
        let sample_rate = handle.sample_rate;
        let device_name = handle.device_name;
        let CaptureStreamHandle {
            stream,
            samples,
            stream_error,
            ..
        } = handle;

        drop(stream);

        let mut sample_data = samples
            .lock()
            .map_err(|_| format!("Failed to finalize '{}' capture buffer", source))?
            .clone();
        if apply_server_stt_mic_conditioning && source == "mic" {
            let (conditioned, _voiced_detected) =
                condition_server_stt_mic_chunk(&sample_data, sample_rate);
            sample_data = conditioned;
        }
        let stream_error_text = stream_error.lock().ok().and_then(|guard| (*guard).clone());
        let duration_ms = if sample_rate == 0 {
            0
        } else {
            ((sample_data.len() as f64 / sample_rate as f64) * 1000.0) as u64
        };
        let peak_abs = audio_peak_abs_i16(&sample_data);
        let rms = audio_rms_i16(&sample_data);
        let wav_bytes = build_pcm16_mono_wav_bytes(sample_rate, &sample_data);
        let file_path_string = if save_to_disk {
            let file_name = format!("{}.wav", source);
            let file_path = output_dir.join(file_name);
            std::fs::write(&file_path, &wav_bytes).map_err(|err| {
                format!(
                    "Failed to write WAV file '{}': {}",
                    file_path.display(),
                    err
                )
            })?;
            Some(file_path.to_string_lossy().to_string())
        } else {
            None
        };

        let detail = if let Some(err) = stream_error_text {
            format!("Captured with stream warnings: {}", err)
        } else {
            format!("Captured from '{}'.", device_name)
        };

        if source == "mic" {
            microphone_track.available = true;
            microphone_track.device_name = Some(device_name);
            microphone_track.sample_rate = Some(sample_rate);
            microphone_track.sample_count = sample_data.len();
            microphone_track.duration_ms = duration_ms;
            microphone_track.peak_abs = peak_abs;
            microphone_track.rms = rms;
            microphone_track.file_path = file_path_string;
            microphone_track.wav_bytes = Some(wav_bytes);
            microphone_track.detail = detail;
        } else if source == "system" {
            system_audio_track.available = true;
            system_audio_track.device_name = Some(device_name);
            system_audio_track.sample_rate = Some(sample_rate);
            system_audio_track.sample_count = sample_data.len();
            system_audio_track.duration_ms = duration_ms;
            system_audio_track.peak_abs = peak_abs;
            system_audio_track.rms = rms;
            system_audio_track.file_path = file_path_string;
            system_audio_track.wav_bytes = Some(wav_bytes);
            system_audio_track.detail = detail;
        }
    }

    #[cfg(target_os = "windows")]
    if open_output_dir {
        let _ = Command::new("explorer").arg(&output_dir).spawn();
    }

    Ok(CaptureAudioSampleResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        duration_seconds,
        microphone: microphone_track,
        system_audio: system_audio_track,
        captured_at_unix_ms,
    })
}

#[tauri::command]
pub async fn capture_audio_sample(
    app: tauri::AppHandle,
    request: Option<CaptureAudioSampleRequest>,
) -> Result<CaptureAudioSampleResult, String> {
    if stt_runtime::is_global_session_running() {
        return Err("Сначала завершите активное интервью, затем запустите тест аудио.".to_string());
    }

    let request = request.unwrap_or_default();
    let duration_seconds = request.duration_seconds.unwrap_or(10).clamp(3, 30);
    let open_output_dir = request.open_output_dir.unwrap_or(true);
    let microphone_device_id = normalize_optional_device_id(request.microphone_device_id);
    let system_audio_device_id = normalize_optional_device_id(request.system_audio_device_id);

    let app_handle = app.clone();
    let capture_task = tauri::async_runtime::spawn_blocking(move || {
        capture_audio_sample_blocking(
            &app_handle,
            microphone_device_id,
            system_audio_device_id,
            duration_seconds,
            true,
            open_output_dir,
            false,
        )
    });

    let command_timeout = Duration::from_secs(duration_seconds as u64 + 20);
    match tokio::time::timeout(command_timeout, capture_task).await {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join audio capture task: {}", join_err))?,
        Err(_) => Err(
            "Audio capture timed out. Try a shorter duration and check audio device availability."
                .to_string(),
        ),
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TranscribeCapturedAudioRequest {
    pub capture_dir: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscribedAudioTrack {
    pub source: String,
    pub file_path: Option<String>,
    pub sample_rate: Option<u32>,
    pub sample_count: usize,
    pub duration_ms: u64,
    pub text: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscribeCapturedAudioResult {
    pub capture_dir: String,
    pub model_path: String,
    pub language: String,
    pub microphone: TranscribedAudioTrack,
    pub system_audio: TranscribedAudioTrack,
    pub transcribed_at_unix_ms: u64,
}

fn normalize_whisper_language_code(language: &str) -> String {
    match language.trim().to_ascii_lowercase().as_str() {
        "en" | "en-us" => "en".to_string(),
        "ru" | "ru-ru" => "ru".to_string(),
        "es" | "es-es" => "es".to_string(),
        "de" | "de-de" => "de".to_string(),
        "fr" | "fr-fr" => "fr".to_string(),
        "it" | "it-it" => "it".to_string(),
        "pt" | "pt-br" => "pt".to_string(),
        "zh" | "zh-cn" => "zh".to_string(),
        "ja" | "ja-jp" => "ja".to_string(),
        "ko" | "ko-kr" => "ko".to_string(),
        other if !other.is_empty() => other.to_string(),
        _ => "en".to_string(),
    }
}

fn read_wav_pcm16_mono(path: &Path) -> Result<(u32, Vec<i16>), String> {
    let bytes = std::fs::read(path)
        .map_err(|err| format!("Failed to read WAV file '{}': {}", path.display(), err))?;
    if bytes.len() < 44 {
        return Err(format!(
            "Invalid WAV file '{}': header is too short",
            path.display()
        ));
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!(
            "Invalid WAV file '{}': missing RIFF/WAVE header",
            path.display()
        ));
    }

    let mut cursor = 12usize;
    let mut sample_rate: Option<u32> = None;
    let mut channels: Option<u16> = None;
    let mut bits_per_sample: Option<u16> = None;
    let mut audio_format: Option<u16> = None;
    let mut data_chunk: Option<&[u8]> = None;

    while cursor + 8 <= bytes.len() {
        let chunk_id = &bytes[cursor..cursor + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        let chunk_data_start = cursor + 8;
        let chunk_data_end = chunk_data_start.saturating_add(chunk_size);
        if chunk_data_end > bytes.len() {
            break;
        }

        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err(format!(
                    "Invalid WAV file '{}': fmt chunk is too short",
                    path.display()
                ));
            }
            audio_format = Some(u16::from_le_bytes([
                bytes[chunk_data_start],
                bytes[chunk_data_start + 1],
            ]));
            channels = Some(u16::from_le_bytes([
                bytes[chunk_data_start + 2],
                bytes[chunk_data_start + 3],
            ]));
            sample_rate = Some(u32::from_le_bytes([
                bytes[chunk_data_start + 4],
                bytes[chunk_data_start + 5],
                bytes[chunk_data_start + 6],
                bytes[chunk_data_start + 7],
            ]));
            bits_per_sample = Some(u16::from_le_bytes([
                bytes[chunk_data_start + 14],
                bytes[chunk_data_start + 15],
            ]));
        } else if chunk_id == b"data" {
            data_chunk = Some(&bytes[chunk_data_start..chunk_data_end]);
        }

        let padded_size = if chunk_size % 2 == 0 {
            chunk_size
        } else {
            chunk_size + 1
        };
        cursor = chunk_data_start.saturating_add(padded_size);
    }

    let sample_rate = sample_rate.ok_or_else(|| {
        format!(
            "Invalid WAV file '{}': missing fmt chunk with sample rate",
            path.display()
        )
    })?;
    let channels = channels.ok_or_else(|| {
        format!(
            "Invalid WAV file '{}': missing fmt chunk with channels",
            path.display()
        )
    })?;
    let bits_per_sample = bits_per_sample.ok_or_else(|| {
        format!(
            "Invalid WAV file '{}': missing fmt chunk with bit depth",
            path.display()
        )
    })?;
    let audio_format = audio_format.ok_or_else(|| {
        format!(
            "Invalid WAV file '{}': missing fmt chunk with audio format",
            path.display()
        )
    })?;
    let data_chunk = data_chunk
        .ok_or_else(|| format!("Invalid WAV file '{}': missing data chunk", path.display()))?;

    if audio_format != 1 {
        return Err(format!(
            "Unsupported WAV audio format in '{}': {} (only PCM is supported)",
            path.display(),
            audio_format
        ));
    }
    if bits_per_sample != 16 {
        return Err(format!(
            "Unsupported WAV bit depth in '{}': {} (only 16-bit PCM is supported)",
            path.display(),
            bits_per_sample
        ));
    }
    if data_chunk.len() % 2 != 0 {
        return Err(format!(
            "Invalid WAV data chunk size in '{}': {}",
            path.display(),
            data_chunk.len()
        ));
    }

    let raw_samples = data_chunk
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();

    let mono_samples = if channels <= 1 {
        raw_samples
    } else {
        raw_samples
            .chunks(channels as usize)
            .map(|frame| {
                let sum = frame.iter().map(|sample| *sample as i32).sum::<i32>();
                (sum / channels as i32) as i16
            })
            .collect()
    };

    Ok((sample_rate, mono_samples))
}

fn resample_mono_i16_linear(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
    if samples.is_empty() || input_rate == 0 || output_rate == 0 || input_rate == output_rate {
        return samples.to_vec();
    }

    let ratio = output_rate as f64 / input_rate as f64;
    let output_len = ((samples.len() as f64) * ratio).round() as usize;
    if output_len == 0 {
        return Vec::new();
    }

    let mut output = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let source_pos = output_index as f64 / ratio;
        let left_index = source_pos.floor() as usize;
        let right_index = left_index.saturating_add(1);
        let frac = (source_pos - left_index as f64) as f32;
        let left = *samples
            .get(left_index)
            .unwrap_or_else(|| samples.last().unwrap_or(&0)) as f32;
        let right = *samples
            .get(right_index)
            .unwrap_or_else(|| samples.last().unwrap_or(&0)) as f32;
        output.push((left + (right - left) * frac).round() as i16);
    }
    output
}

fn audio_peak_and_rms_f32(samples: &[i16]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }

    let mut peak = 0.0_f32;
    let mut squared_sum = 0.0_f64;
    for sample in samples {
        let value = (*sample as f32) / (i16::MAX as f32);
        let abs_value = value.abs();
        if abs_value > peak {
            peak = abs_value;
        }
        squared_sum += (value as f64) * (value as f64);
    }

    let rms = (squared_sum / samples.len() as f64).sqrt() as f32;
    (peak, rms)
}

fn apply_gain_i16_in_place(samples: &mut [i16], gain: f32) {
    if gain <= 1.0 {
        return;
    }
    for sample in samples {
        let scaled = (*sample as f32) * gain;
        let clamped = scaled.clamp(i16::MIN as f32, i16::MAX as f32);
        *sample = clamped.round() as i16;
    }
}

fn looks_like_subtitle_credit_hallucination(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("редактор субтитр")
        || (lower.contains("субтитр") && lower.contains("корректор"))
        || (lower.contains("subtitles") && lower.contains("editor"))
}

fn transcribe_wav_with_whisper(
    context: &WhisperContext,
    file_path: &Path,
    language: &str,
) -> Result<TranscribedAudioTrack, String> {
    let (input_sample_rate, mono_samples) = read_wav_pcm16_mono(file_path)?;
    let mut mono_samples_16k = resample_mono_i16_linear(&mono_samples, input_sample_rate, 16000);
    let source = if file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("system")
    {
        "system".to_string()
    } else {
        "mic".to_string()
    };

    let (raw_peak, _raw_rms) = audio_peak_and_rms_f32(&mono_samples_16k);
    if raw_peak > 0.0 && raw_peak < WHISPER_CHUNK_TARGET_PEAK {
        let gain = (WHISPER_CHUNK_TARGET_PEAK / raw_peak).min(WHISPER_CHUNK_MAX_GAIN);
        apply_gain_i16_in_place(&mut mono_samples_16k, gain);
    }

    let (peak, rms) = audio_peak_and_rms_f32(&mono_samples_16k);
    if peak < WHISPER_CHUNK_SILENCE_PEAK_THRESHOLD && rms < WHISPER_CHUNK_SILENCE_RMS_THRESHOLD {
        let duration_ms = if input_sample_rate == 0 {
            0
        } else {
            ((mono_samples.len() as f64 / input_sample_rate as f64) * 1000.0) as u64
        };
        return Ok(TranscribedAudioTrack {
            source,
            file_path: Some(file_path.to_string_lossy().to_string()),
            sample_rate: Some(input_sample_rate),
            sample_count: mono_samples.len(),
            duration_ms,
            text: String::new(),
            available: true,
            detail: format!(
                "Skipped near-silence chunk (peak={:.4}, rms={:.4}).",
                peak, rms
            ),
        });
    }

    let mut audio_f32 = Vec::with_capacity(mono_samples_16k.len());
    for sample in &mono_samples_16k {
        audio_f32.push((*sample as f32) / (i16::MAX as f32));
    }

    let mut state = context
        .create_state()
        .map_err(|err| format!("Failed to create Whisper state: {}", err))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_no_timestamps(true);
    params.set_single_segment(false);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.50);
    params.set_n_threads(4);

    state
        .full(params, &audio_f32)
        .map_err(|err| format!("Whisper failed for '{}': {}", file_path.display(), err))?;

    let mut text = state
        .as_iter()
        .map(|segment| segment.to_string())
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut detail = "Transcription completed.".to_string();
    if looks_like_subtitle_credit_hallucination(&text) {
        text.clear();
        detail = "Filtered probable Whisper subtitle-credit hallucination.".to_string();
    }

    let duration_ms = if input_sample_rate == 0 {
        0
    } else {
        ((mono_samples.len() as f64 / input_sample_rate as f64) * 1000.0) as u64
    };

    Ok(TranscribedAudioTrack {
        source,
        file_path: Some(file_path.to_string_lossy().to_string()),
        sample_rate: Some(input_sample_rate),
        sample_count: mono_samples.len(),
        duration_ms,
        text,
        available: true,
        detail,
    })
}

fn find_latest_capture_dir(base_dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(base_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((path, modified))
        })
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path)
}

fn transcribe_captured_audio_blocking(
    app: tauri::AppHandle,
    request: Option<TranscribeCapturedAudioRequest>,
) -> Result<TranscribeCapturedAudioResult, String> {
    if stt_runtime::is_global_session_running() {
        return Err(
            "Сначала завершите активное интервью, затем запустите проверку WAV.".to_string(),
        );
    }

    let request = request.unwrap_or_default();
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let capture_root = app_data_dir.join("diagnostics").join("audio-capture");
    let capture_dir = if let Some(raw_dir) = request.capture_dir {
        PathBuf::from(raw_dir)
    } else {
        find_latest_capture_dir(&capture_root).ok_or_else(|| {
            format!(
                "Папка с тестовой записью не найдена: '{}'. Сначала запишите тест аудио.",
                capture_root.display()
            )
        })?
    };

    if !capture_dir.is_dir() {
        return Err(format!(
            "Capture folder '{}' does not exist.",
            capture_dir.display()
        ));
    }

    let model_path = resolve_stt_model_path(&app).ok_or_else(|| {
        "Whisper model is not installed. Install a model in Speech settings first.".to_string()
    })?;
    let model_path_str = model_path.to_string_lossy().to_string();
    let requested_language = request
        .language
        .as_deref()
        .map(normalize_primary_language)
        .unwrap_or_else(|| "ru-RU".to_string());
    let whisper_language = normalize_whisper_language_code(&requested_language);

    let context = WhisperContext::new_with_params(
        model_path
            .to_str()
            .ok_or_else(|| "Model path contains invalid UTF-8".to_string())?,
        WhisperContextParameters::default(),
    )
    .map_err(|err| {
        format!(
            "Failed to load Whisper model '{}': {}",
            model_path.display(),
            err
        )
    })?;

    let mic_path = capture_dir.join("mic.wav");
    let mut microphone = if mic_path.is_file() {
        transcribe_wav_with_whisper(&context, &mic_path, &whisper_language)?
    } else {
        TranscribedAudioTrack {
            source: "mic".to_string(),
            file_path: Some(mic_path.to_string_lossy().to_string()),
            sample_rate: None,
            sample_count: 0,
            duration_ms: 0,
            text: String::new(),
            available: false,
            detail: "mic.wav not found in capture folder.".to_string(),
        }
    };

    let system_path = capture_dir.join("system.wav");
    let mut system_audio = if system_path.is_file() {
        transcribe_wav_with_whisper(&context, &system_path, &whisper_language)?
    } else {
        TranscribedAudioTrack {
            source: "system".to_string(),
            file_path: Some(system_path.to_string_lossy().to_string()),
            sample_rate: None,
            sample_count: 0,
            duration_ms: 0,
            text: String::new(),
            available: false,
            detail: "system.wav not found in capture folder.".to_string(),
        }
    };

    if microphone.text.is_empty() && microphone.available {
        microphone.detail = "Transcription produced empty text.".to_string();
    }
    if system_audio.text.is_empty() && system_audio.available {
        system_audio.detail = "Transcription produced empty text.".to_string();
    }

    Ok(TranscribeCapturedAudioResult {
        capture_dir: capture_dir.to_string_lossy().to_string(),
        model_path: model_path_str,
        language: whisper_language,
        microphone,
        system_audio,
        transcribed_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[tauri::command]
pub async fn transcribe_captured_audio(
    app: tauri::AppHandle,
    request: Option<TranscribeCapturedAudioRequest>,
) -> Result<TranscribeCapturedAudioResult, String> {
    let app_handle = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        transcribe_captured_audio_blocking(app_handle, request)
    });

    match tokio::time::timeout(Duration::from_secs(180), task).await {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join WAV transcription task: {}", join_err))?,
        Err(_) => Err("WAV transcription timed out. Try a shorter capture.".to_string()),
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AudioAutoProbeRequest {
    pub duration_seconds: Option<u32>,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
    pub probe_all_input_devices: Option<bool>,
    pub probe_all_output_devices: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioSignalProbeTrack {
    pub source: String,
    pub device: Option<audio::AudioDeviceInfo>,
    pub requested_device_id: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub duration_ms: u64,
    pub peak_abs: i16,
    pub rms: f64,
    pub signal_score: f64,
    pub has_signal: bool,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioAutoProbeResult {
    pub duration_seconds: u32,
    pub microphone_candidates: Vec<AudioSignalProbeTrack>,
    pub system_audio_candidates: Vec<AudioSignalProbeTrack>,
    pub recommended_microphone: Option<AudioSignalProbeTrack>,
    pub recommended_system_audio: Option<AudioSignalProbeTrack>,
    pub notes: Vec<String>,
    pub probed_at_unix_ms: u64,
}

fn push_unique_audio_candidate(
    candidates: &mut Vec<audio::AudioDeviceInfo>,
    seen: &mut HashSet<String>,
    device: Option<audio::AudioDeviceInfo>,
) {
    let Some(device) = device else {
        return;
    };
    if seen.insert(device.id.clone()) {
        candidates.push(device);
    }
}

fn build_probe_candidates(
    devices: &[audio::AudioDeviceInfo],
    selected_device_id: Option<&str>,
    probe_all: bool,
) -> Vec<audio::AudioDeviceInfo> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    let selected = selected_device_id.and_then(|selector| {
        devices
            .iter()
            .find(|device| device.id == selector || device.name == selector)
            .cloned()
    });
    let default = devices.iter().find(|device| device.is_default).cloned();

    push_unique_audio_candidate(&mut candidates, &mut seen, selected);
    push_unique_audio_candidate(&mut candidates, &mut seen, default);

    if probe_all {
        for device in devices {
            push_unique_audio_candidate(&mut candidates, &mut seen, Some(device.clone()));
        }
    }

    candidates
}

fn to_audio_signal_probe_track(
    source: &str,
    device: Option<audio::AudioDeviceInfo>,
    captured: CapturedAudioTrack,
) -> AudioSignalProbeTrack {
    let peak_abs = captured.peak_abs;
    let rms = captured.rms;
    AudioSignalProbeTrack {
        source: source.to_string(),
        requested_device_id: captured.requested_device_id,
        device_id: device
            .as_ref()
            .map(|candidate| candidate.id.clone())
            .or_else(|| captured.device_name.clone()),
        device_name: captured
            .device_name
            .clone()
            .or_else(|| device.as_ref().map(|candidate| candidate.name.clone())),
        device,
        sample_rate: captured.sample_rate,
        duration_ms: captured.duration_ms,
        peak_abs,
        rms,
        signal_score: audio_signal_score(peak_abs, rms),
        has_signal: captured.available && audio_has_productive_signal(peak_abs, rms),
        available: captured.available,
        detail: captured.detail,
    }
}

fn choose_best_signal_candidate(
    candidates: &[AudioSignalProbeTrack],
) -> Option<AudioSignalProbeTrack> {
    candidates
        .iter()
        .filter(|candidate| candidate.available && candidate.has_signal)
        .max_by(|left, right| {
            left.signal_score
                .partial_cmp(&right.signal_score)
                .unwrap_or(Ordering::Equal)
        })
        .cloned()
}

fn choose_available_candidate(
    candidates: &[AudioSignalProbeTrack],
    selected_device_id: Option<&str>,
) -> Option<AudioSignalProbeTrack> {
    if let Some(selected) = selected_device_id {
        if let Some(candidate) = candidates.iter().find(|candidate| {
            candidate.available
                && candidate
                    .device
                    .as_ref()
                    .map(|device| device.id == selected || device.name == selected)
                    .unwrap_or(false)
        }) {
            return Some(candidate.clone());
        }
    }

    candidates
        .iter()
        .find(|candidate| {
            candidate.available
                && candidate
                    .device
                    .as_ref()
                    .map(|device| device.is_default)
                    .unwrap_or(false)
        })
        .cloned()
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| candidate.available)
                .cloned()
        })
}

#[tauri::command]
pub async fn probe_audio_devices(
    request: Option<AudioAutoProbeRequest>,
) -> Result<AudioAutoProbeResult, String> {
    let request = request.unwrap_or_default();
    let duration_seconds = request.duration_seconds.unwrap_or(1).clamp(1, 3);
    let selected_microphone_id = normalize_optional_device_id(request.microphone_device_id);
    let selected_system_audio_id = normalize_optional_device_id(request.system_audio_device_id);
    let probe_all_input_devices = request.probe_all_input_devices.unwrap_or(false);
    let probe_all_output_devices = request.probe_all_output_devices.unwrap_or(false);

    let probe_task = tauri::async_runtime::spawn_blocking(move || {
        let input_devices = audio::list_input_devices();
        let output_devices = audio::list_output_devices();
        let microphone_candidates = build_probe_candidates(
            &input_devices,
            selected_microphone_id.as_deref(),
            probe_all_input_devices,
        );
        let system_audio_candidates = build_probe_candidates(
            &output_devices,
            selected_system_audio_id.as_deref(),
            probe_all_output_devices,
        );

        let mut microphone_results = Vec::new();
        for device in microphone_candidates {
            let captured = capture_audio_track_signal_blocking(
                "mic",
                Some(device.id.clone()),
                duration_seconds,
                false,
                false,
            );
            microphone_results.push(to_audio_signal_probe_track("mic", Some(device), captured));
        }

        let mut system_audio_results = Vec::new();
        for device in system_audio_candidates {
            let captured = capture_audio_track_signal_blocking(
                "system",
                Some(device.id.clone()),
                duration_seconds,
                false,
                false,
            );
            system_audio_results.push(to_audio_signal_probe_track(
                "system",
                Some(device),
                captured,
            ));
        }

        let recommended_microphone = choose_best_signal_candidate(&microphone_results);
        let recommended_system_audio =
            choose_best_signal_candidate(&system_audio_results).or_else(|| {
                choose_available_candidate(
                    &system_audio_results,
                    selected_system_audio_id.as_deref(),
                )
            });
        let mut notes = Vec::new();

        if input_devices.is_empty() {
            notes.push("No microphone-capable input devices were detected.".to_string());
        } else if recommended_microphone.is_none() {
            notes
                .push("No microphone produced a clear signal during the probe window.".to_string());
        }

        if output_devices.is_empty() {
            notes.push("No output devices were detected for system audio capture.".to_string());
        } else if !system_audio_results
            .iter()
            .any(|candidate| candidate.has_signal)
        {
            notes.push(
                "No output device produced measurable loopback audio during the probe window."
                    .to_string(),
            );
        }

        Ok(AudioAutoProbeResult {
            duration_seconds,
            microphone_candidates: microphone_results,
            system_audio_candidates: system_audio_results,
            recommended_microphone,
            recommended_system_audio,
            notes,
            probed_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        })
    });

    match tokio::time::timeout(Duration::from_secs(40), probe_task).await {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join audio probe task: {}", join_err))?,
        Err(_) => Err("Audio device probe timed out.".to_string()),
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ServerSttChunkCaptureRequest {
    pub duration_seconds: Option<u32>,
    /// Sub-second drain interval, used by dictation. Takes precedence over
    /// `duration_seconds` when both are present.
    pub duration_ms: Option<u32>,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerSttChunkTrack {
    pub source: String,
    pub requested_device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub duration_ms: u64,
    pub peak_abs: i16,
    pub rms: f64,
    pub wav_base64: Option<String>,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerSttChunkCaptureResult {
    pub duration_seconds: u32,
    pub duration_ms: u32,
    pub microphone: ServerSttChunkTrack,
    pub system_audio: ServerSttChunkTrack,
    pub captured_at_unix_ms: u64,
}

fn to_server_stt_chunk_track(
    source: &str,
    requested_device_id: Option<String>,
    device_name: Option<String>,
    sample_rate: Option<u32>,
    duration_ms: u64,
    peak_abs: i16,
    rms: f64,
    wav_base64: Option<String>,
    available: bool,
    detail: String,
) -> ServerSttChunkTrack {
    ServerSttChunkTrack {
        source: source.to_string(),
        requested_device_id,
        device_name,
        sample_rate,
        duration_ms,
        peak_abs,
        rms,
        wav_base64,
        available,
        detail,
    }
}

#[tauri::command]
pub async fn capture_server_stt_chunk(
    app: tauri::AppHandle,
    request: Option<ServerSttChunkCaptureRequest>,
) -> Result<ServerSttChunkCaptureResult, String> {
    if stt_runtime::is_global_session_running() || vosk_stt_runtime::is_global_session_running() {
        return Err(
            "Stop active local speech session before server audio streaming capture.".to_string(),
        );
    }

    let request = request.unwrap_or_default();
    let duration_ms = match request.duration_ms {
        Some(ms) => ms.clamp(100, 6000),
        None => request.duration_seconds.unwrap_or(2).clamp(1, 6) * 1000,
    };
    let microphone_device_id = normalize_optional_device_id(request.microphone_device_id);
    let system_audio_device_id = normalize_optional_device_id(request.system_audio_device_id);
    let app_handle = app.clone();

    let capture_task = tauri::async_runtime::spawn_blocking(move || {
        capture_server_stt_chunk_blocking(
            &app_handle,
            microphone_device_id,
            system_audio_device_id,
            duration_ms,
        )
    });

    let capture_result = match tokio::time::timeout(
        Duration::from_millis(duration_ms as u64)
            + Duration::from_secs(SERVER_STT_CAPTURE_TIMEOUT_GRACE_SECS),
        capture_task,
    )
    .await
    {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join live STT capture task: {}", join_err))??,
        Err(_) => {
            return Err("Live STT chunk capture timed out. Try a shorter duration.".to_string());
        }
    };

    let mic_has_audio = capture_result.microphone.available
        && capture_result.microphone.sample_count > 0
        && capture_result.microphone.duration_ms > 0;
    let system_has_audio = capture_result.system_audio.available
        && capture_result.system_audio.sample_count > 0
        && capture_result.system_audio.duration_ms > 0;

    let mut mic_base64: Option<String> = None;
    let mut system_base64: Option<String> = None;

    if mic_has_audio {
        if let Some(bytes) = capture_result.microphone.wav_bytes.as_deref() {
            mic_base64 = Some(BASE64_STANDARD.encode(bytes));
        } else {
            return Err("Captured microphone track has no in-memory WAV payload.".to_string());
        }
    }

    if system_has_audio {
        if let Some(bytes) = capture_result.system_audio.wav_bytes.as_deref() {
            system_base64 = Some(BASE64_STANDARD.encode(bytes));
        } else {
            return Err("Captured system-audio track has no in-memory WAV payload.".to_string());
        }
    }

    Ok(ServerSttChunkCaptureResult {
        duration_seconds: duration_ms / 1000,
        duration_ms,
        microphone: to_server_stt_chunk_track(
            "mic",
            capture_result.microphone.requested_device_id,
            capture_result.microphone.device_name,
            capture_result.microphone.sample_rate,
            capture_result.microphone.duration_ms,
            capture_result.microphone.peak_abs,
            capture_result.microphone.rms,
            mic_base64,
            mic_has_audio,
            if mic_has_audio && capture_result.microphone.detail.trim().is_empty() {
                "ok".to_string()
            } else {
                capture_result.microphone.detail
            },
        ),
        system_audio: to_server_stt_chunk_track(
            "system",
            capture_result.system_audio.requested_device_id,
            capture_result.system_audio.device_name,
            capture_result.system_audio.sample_rate,
            capture_result.system_audio.duration_ms,
            capture_result.system_audio.peak_abs,
            capture_result.system_audio.rms,
            system_base64,
            system_has_audio,
            if system_has_audio && capture_result.system_audio.detail.trim().is_empty() {
                "ok".to_string()
            } else {
                capture_result.system_audio.detail
            },
        ),
        captured_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[tauri::command]
pub fn stop_server_stt_live_capture() -> Result<(), String> {
    stop_server_stt_live_capture_runtime()
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ServerSttCaptureRequest {
    pub license_key: String,
    pub base_url: String,
    pub language: Option<String>,
    pub duration_seconds: Option<u32>,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerSttTrack {
    pub source: String,
    pub file_path: Option<String>,
    pub text: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerSttCaptureResult {
    pub capture_dir: String,
    pub duration_seconds: u32,
    pub language: String,
    pub microphone: ServerSttTrack,
    pub system_audio: ServerSttTrack,
    pub transcribed_at_unix_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct ProxySttTrackResponse {
    source: Option<String>,
    available: Option<bool>,
    text: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProxySttTranscribeResponse {
    lang: Option<String>,
    microphone: Option<ProxySttTrackResponse>,
    #[serde(rename = "systemAudio")]
    system_audio: Option<ProxySttTrackResponse>,
}

fn to_server_stt_track(
    fallback_source: &str,
    file_path: Option<String>,
    track: Option<ProxySttTrackResponse>,
) -> ServerSttTrack {
    match track {
        Some(value) => ServerSttTrack {
            source: value.source.unwrap_or_else(|| fallback_source.to_string()),
            file_path,
            text: value.text.unwrap_or_default().trim().to_string(),
            available: value.available.unwrap_or(false),
            detail: value.detail.unwrap_or_default(),
        },
        None => ServerSttTrack {
            source: fallback_source.to_string(),
            file_path,
            text: String::new(),
            available: false,
            detail: "Track is missing in server response.".to_string(),
        },
    }
}

#[tauri::command]
pub async fn capture_and_transcribe_server_stt(
    app: tauri::AppHandle,
    request: Option<ServerSttCaptureRequest>,
) -> Result<ServerSttCaptureResult, String> {
    if stt_runtime::is_global_session_running() || vosk_stt_runtime::is_global_session_running() {
        return Err(
            "Stop active local speech session before server transcription capture.".to_string(),
        );
    }

    let request = request.unwrap_or_default();
    let license_key = request.license_key.trim().to_string();
    if license_key.is_empty() {
        return Err("License key is required.".to_string());
    }

    let base_url = request.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Proxy base URL is required.".to_string());
    }

    let language = request
        .language
        .unwrap_or_else(|| "ru".to_string())
        .trim()
        .to_lowercase();
    let duration_seconds = request.duration_seconds.unwrap_or(4).clamp(1, 12);
    let microphone_device_id = normalize_optional_device_id(request.microphone_device_id);
    let system_audio_device_id = normalize_optional_device_id(request.system_audio_device_id);
    let app_handle = app.clone();

    let capture_task = tauri::async_runtime::spawn_blocking(move || {
        capture_audio_sample_blocking(
            &app_handle,
            microphone_device_id,
            system_audio_device_id,
            duration_seconds,
            false,
            false,
            true,
        )
    });

    let capture_result = match tokio::time::timeout(
        Duration::from_secs(duration_seconds as u64 + SERVER_STT_CAPTURE_TIMEOUT_GRACE_SECS),
        capture_task,
    )
    .await
    {
        Ok(join_result) => join_result.map_err(|join_err| {
            format!("Failed to join server STT capture task: {}", join_err)
        })??,
        Err(_) => {
            return Err("Server STT capture timed out. Try a shorter duration.".to_string());
        }
    };

    let mic_path = capture_result.microphone.file_path.clone();
    let system_path = capture_result.system_audio.file_path.clone();
    let capture_dir = capture_result.output_dir.clone();

    let mic_has_audio = capture_result.microphone.available
        && capture_result.microphone.sample_count > 0
        && capture_result.microphone.duration_ms > 0;
    let system_has_audio = capture_result.system_audio.available
        && capture_result.system_audio.sample_count > 0
        && capture_result.system_audio.duration_ms > 0;
    let mut attached_parts = 0usize;
    let mut mic_bytes: Option<Vec<u8>> = None;
    let mut system_bytes: Option<Vec<u8>> = None;

    if mic_has_audio {
        let bytes = if let Some(bytes) = capture_result.microphone.wav_bytes.clone() {
            bytes
        } else if let Some(path) = mic_path.as_deref() {
            std::fs::read(path)
                .map_err(|err| format!("Failed to read captured mic audio '{}': {}", path, err))?
        } else {
            return Err("Captured microphone track has no in-memory WAV payload.".to_string());
        };
        mic_bytes = Some(bytes);
        attached_parts += 1;
    }

    if system_has_audio {
        let bytes = if let Some(bytes) = capture_result.system_audio.wav_bytes.clone() {
            bytes
        } else if let Some(path) = system_path.as_deref() {
            std::fs::read(path).map_err(|err| {
                format!("Failed to read captured system audio '{}': {}", path, err)
            })?
        } else {
            return Err("Captured system audio track has no in-memory WAV payload.".to_string());
        };
        system_bytes = Some(bytes);
        attached_parts += 1;
    }

    if attached_parts == 0 {
        let _ = std::fs::remove_dir_all(&capture_dir);
        return Ok(ServerSttCaptureResult {
            capture_dir,
            duration_seconds,
            language,
            microphone: ServerSttTrack {
                source: "mic".to_string(),
                file_path: mic_path,
                text: String::new(),
                available: false,
                detail: format!(
                    "No usable microphone samples were captured. {}",
                    capture_result.microphone.detail
                ),
            },
            system_audio: ServerSttTrack {
                source: "system".to_string(),
                file_path: system_path,
                text: String::new(),
                available: false,
                detail: format!(
                    "No usable system-audio samples were captured. {}",
                    capture_result.system_audio.detail
                ),
            },
            transcribed_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0),
        });
    }

    let mut url_candidates = vec![
        format!("{}/api/v2/stt/transcribe", base_url),
        format!("{}/api/v1/stt/transcribe", base_url),
    ];
    url_candidates.dedup();

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(
            PROXY_STT_CONNECT_TIMEOUT_SECS,
        ))
        .timeout(std::time::Duration::from_secs(PROXY_STT_TIMEOUT_SECS))
        .build()
        .map_err(|err| format!("Failed to build HTTP client for server STT: {}", err))?;

    let device_identity = crate::device_identity::resolve();
    if url_candidates.is_empty() {
        let _ = std::fs::remove_dir_all(&capture_dir);
        return Err("No server STT endpoint candidates are configured.".to_string());
    }

    let mut endpoint_order: Vec<usize> = Vec::with_capacity(url_candidates.len());
    let preferred = SERVER_STT_PREFERRED_ENDPOINT.load(AtomicOrdering::Relaxed);
    if preferred < url_candidates.len() {
        endpoint_order.push(preferred);
    }
    for idx in 0..url_candidates.len() {
        if !endpoint_order.contains(&idx) {
            endpoint_order.push(idx);
        }
    }

    let mut response: Option<reqwest::Response> = None;
    let mut selected_url: Option<String> = None;
    let mut selected_index: Option<usize> = None;
    let mut last_transport_error: Option<String> = None;

    for endpoint_index in endpoint_order {
        let endpoint_url = url_candidates[endpoint_index].clone();
        let mut form = reqwest::multipart::Form::new().text("lang", language.clone());

        if let Some(bytes) = mic_bytes.as_ref() {
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name("mic.wav")
                .mime_str("audio/wav")
                .map_err(|err| format!("Failed to prepare mic audio multipart: {}", err))?;
            form = form.part("mic", part);
        }

        if let Some(bytes) = system_bytes.as_ref() {
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name("system.wav")
                .mime_str("audio/wav")
                .map_err(|err| format!("Failed to prepare system audio multipart: {}", err))?;
            form = form.part("system", part);
        }

        match client
            .post(&endpoint_url)
            .header("X-License-Key", &license_key)
            .header("X-Device-Fingerprint", &device_identity.fingerprint)
            .header("X-Device-Name", &device_identity.name)
            .multipart(form)
            .send()
            .await
        {
            Ok(ok_response) => {
                response = Some(ok_response);
                selected_url = Some(endpoint_url);
                selected_index = Some(endpoint_index);
                break;
            }
            Err(err) => {
                last_transport_error = Some(format!("{} (via {})", err, endpoint_url));
            }
        }
    }

    let response = match response {
        Some(value) => value,
        None => {
            let _ = std::fs::remove_dir_all(&capture_dir);
            return Err(format!(
                "Failed to call server STT endpoint: {}.",
                last_transport_error.unwrap_or_else(|| "unknown transport error".to_string())
            ));
        }
    };
    let selected_url = selected_url.unwrap_or_else(|| "unknown endpoint".to_string());
    if let Some(index) = selected_index {
        SERVER_STT_PREFERRED_ENDPOINT.store(index, AtomicOrdering::Relaxed);
    }

    let status = response.status();
    let body = response.text().await.map_err(|err| {
        let _ = std::fs::remove_dir_all(&capture_dir);
        format!(
            "Failed to read server STT response: {} (via {}).",
            err, selected_url
        )
    })?;

    let parsed = if status.is_success() {
        serde_json::from_str::<ProxySttTranscribeResponse>(&body).map_err(|err| {
            let _ = std::fs::remove_dir_all(&capture_dir);
            format!(
                "Server STT returned invalid JSON: {} (via {}).",
                err, selected_url
            )
        })?
    } else {
        let detail = extract_proxy_error_message(&body).unwrap_or_else(|| {
            format!(
                "Server STT failed with HTTP {} (via {}).",
                status.as_u16(),
                selected_url
            )
        });
        let _ = std::fs::remove_dir_all(&capture_dir);
        return Err(detail);
    };

    let _ = std::fs::remove_dir_all(&capture_dir);

    Ok(ServerSttCaptureResult {
        capture_dir,
        duration_seconds,
        language: parsed.lang.unwrap_or(language),
        microphone: to_server_stt_track("mic", mic_path, parsed.microphone),
        system_audio: to_server_stt_track("system", system_path, parsed.system_audio),
        transcribed_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[tauri::command]
pub fn get_capture_protection() -> capture_protection::CaptureProtectionStatus {
    capture_protection::get_capture_protection_status()
}

#[tauri::command]
pub fn get_system_audio_status(
    request: Option<AudioDeviceSelectionRequest>,
) -> system_audio::SystemAudioStatus {
    let request = request.unwrap_or_default();
    system_audio::get_system_audio_status(request.system_audio_device_id.as_deref())
}

/// Runs platform-native OCR on a base64-encoded image (PNG/JPEG). Returns recognized text.
#[tauri::command]
pub fn ocr_image(image_base64: String, language_hint: Option<String>) -> Result<String, String> {
    ocr::ocr_image_base64(image_base64, language_hint)
}

#[tauri::command]
pub fn capture_screen_png_base64() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size);
  $stream = New-Object System.IO.MemoryStream;
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png);
    [Convert]::ToBase64String($stream.ToArray());
  } finally {
    $stream.Dispose();
  }
} finally {
  $graphics.Dispose();
  $bitmap.Dispose();
}
"#;

        let base64 = run_powershell_script(script)
            .ok_or_else(|| "Failed to capture screen using native Windows API.".to_string())?;

        if base64.is_empty() {
            return Err("Native screen capture returned an empty image.".to_string());
        }

        return Ok(base64);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Native screen capture is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub fn get_secure_api_key() -> Result<Option<String>, String> {
    secret_store::get_api_key()
}

#[tauri::command]
pub fn set_secure_api_key(api_key: String) -> Result<(), String> {
    secret_store::set_api_key(&api_key)
}

#[tauri::command]
pub fn get_device_identity() -> crate::device_identity::DeviceIdentity {
    crate::device_identity::resolve()
}

#[tauri::command]
pub fn get_license_status(app: tauri::AppHandle) -> Result<license::LicenseStatus, String> {
    license::get_license_status(&app)
}

#[tauri::command]
pub async fn activate_license(
    app: tauri::AppHandle,
    request: license::ActivateLicenseRequest,
) -> Result<license::LicenseActivationResult, String> {
    license::activate_license(&app, request).await
}

#[tauri::command]
pub fn clear_license(app: tauri::AppHandle) -> Result<license::LicenseStatus, String> {
    license::clear_license(&app)
}

#[tauri::command]
pub fn get_license_access_token() -> Result<Option<String>, String> {
    license::get_license_access_token()
}

#[tauri::command]
pub fn get_license_key() -> Result<Option<String>, String> {
    license::get_license_key()
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProxyLicenseStatusRequest {
    pub license_key: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyLicenseStatusResponse {
    pub status: String,
    pub plan: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<String>,
    pub limits: Option<serde_json::Value>,
    #[serde(rename = "usageToday")]
    pub usage_today: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn get_proxy_license_status(
    request: ProxyLicenseStatusRequest,
) -> Result<ProxyLicenseStatusResponse, String> {
    let license_key = request.license_key.trim();
    if license_key.is_empty() {
        return Err("Введите лицензионный ключ.".to_string());
    }

    let base_url = request.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("Укажите адрес сервиса.".to_string());
    }

    let url = format!("{}/api/v1/license/status", base_url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PROXY_LICENSE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Не удалось подготовить HTTP-клиент: {}", e))?;
    let device_identity = crate::device_identity::resolve();
    let response = client
        .get(url)
        .header("X-License-Key", license_key)
        .header("X-Device-Fingerprint", device_identity.fingerprint)
        .header("X-Device-Name", device_identity.name)
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к сервису: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Не удалось прочитать ответ сервиса: {}", e))?;

    if !status.is_success() {
        let detail = extract_proxy_error_message(&body)
            .unwrap_or_else(|| format!("Сервис вернул HTTP {}", status.as_u16()));
        return Err(detail);
    }

    serde_json::from_str::<ProxyLicenseStatusResponse>(&body)
        .map_err(|e| format!("Сервис вернул некорректный ответ: {}", e))
}

fn extract_proxy_error_message(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    match parsed {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Object(map) => {
            for key in ["message", "error", "detail"] {
                if let Some(value) = map.get(key) {
                    if let Some(text) = value.as_str() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            return Some(trimmed.to_string());
                        }
                    }
                    if let Some(nested) = value.as_object() {
                        if let Some(text) = nested.get("message").and_then(|entry| entry.as_str()) {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                return Some(trimmed.to_string());
                            }
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

#[tauri::command]
pub fn read_app_state(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let path = app_state_file_path(&app, &key)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("Failed to read app state: {}", e))
}

#[tauri::command]
pub fn write_app_state(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let path = app_state_file_path(&app, &key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    }
    std::fs::write(path, value).map_err(|e| format!("Failed to write app state: {}", e))
}

#[tauri::command]
pub fn remove_app_state(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = app_state_file_path(&app, &key)?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("Failed to remove app state: {}", e))
}

fn apply_capture_protection_to_window(
    window: &tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        capture_protection::set_capture_protection_macos(ptr, enabled)?;
    }

    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        capture_protection::set_capture_protection_windows(hwnd.0 as isize, enabled)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = (window, enabled);

    Ok(())
}

pub(crate) fn protect_window_from_capture(window: &tauri::WebviewWindow) {
    if std::env::var("AI_INTERVIEW_DISABLE_CAPTURE_PROTECTION")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
    {
        log::info!(
            "Capture protection skipped for window '{}' by AI_INTERVIEW_DISABLE_CAPTURE_PROTECTION",
            window.label()
        );
        return;
    }

    let enabled = read_capture_protection_preference(&window.app_handle());

    match apply_capture_protection_to_window(window, enabled) {
        Ok(()) => log::info!(
            "Capture protection {} for window '{}'",
            if enabled { "enabled" } else { "disabled" },
            window.label()
        ),
        Err(err) => log::warn!(
            "Failed to apply capture protection for window '{}': {}",
            window.label(),
            err
        ),
    }
}

fn read_capture_protection_preference(app: &tauri::AppHandle) -> bool {
    let Ok(path) = app_state_file_path(app, SETTINGS_STATE_KEY) else {
        return true;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };

    value
        .get("state")
        .and_then(|state| state.get("protectOverlay"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

/// Applies or removes capture protection on a window (by label).
#[tauri::command]
pub fn set_capture_protection_for_window(
    app: tauri::AppHandle,
    window_label: String,
    enabled: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("Window '{}' not found", window_label))?;

    apply_capture_protection_to_window(&window, enabled)?;
    log::info!(
        "Capture protection {} for window '{}' by user preference",
        if enabled { "enabled" } else { "disabled" },
        window.label()
    );
    Ok(())
}

#[tauri::command]
pub fn get_stt_status(app: tauri::AppHandle) -> SttStatus {
    let model_path = resolve_stt_model_path(&app).and_then(|p| p.to_str().map(String::from));
    let active_model_id = read_active_whisper_model_id(&app)
        .or_else(|| resolve_installed_whisper_model_ids(&app).into_iter().next());

    SttStatus {
        available: model_path.is_some(),
        model_loaded: model_path.is_some(),
        model_path,
        language: active_model_id.unwrap_or_else(|| "unknown".to_string()),
        runtime_library_loaded: true,
        runtime_library_path: Some("built-in whisper.cpp (whisper-rs)".to_string()),
        detail: if let Some(active_model_id) = read_active_whisper_model_id(&app) {
            format!("Whisper.cpp is ready. Active model: {}.", active_model_id)
        } else {
            "Whisper model is not installed yet. Open Speech settings and download a profile."
                .to_string()
        },
    }
}

#[tauri::command]
pub async fn start_stt_session(
    app: tauri::AppHandle,
    request: Option<StartSttSessionRequest>,
) -> Result<(), String> {
    let request = request.unwrap_or_default();
    let (config, startup_diagnostic) = resolve_stt_config(&app, &request)?;
    if let Some(diagnostic) = startup_diagnostic {
        let _ = app.emit("stt_diagnostic", diagnostic);
    }
    let startup_config = stt_runtime::SttRuntimeConfig {
        model_path: PathBuf::from(config.model_path),
        language: normalize_primary_language(request.language.as_deref().unwrap_or("en-US")),
        microphone_device_id: normalize_optional_device_id(request.microphone_device_id),
        system_audio_device_id: normalize_optional_device_id(request.system_audio_device_id),
    };

    let app_clone = app.clone();
    let startup_handle = tauri::async_runtime::spawn_blocking(move || {
        stt_runtime::start_global_session(app_clone, startup_config)
    });

    match tokio::time::timeout(
        Duration::from_secs(STT_STARTUP_COMMAND_TIMEOUT_SECS),
        startup_handle,
    )
    .await
    {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join STT startup task: {}", join_err))?,
        Err(_) => Err(
            "Запуск распознавания занял слишком много времени. Проверьте аудиоустройства и перезапустите приложение."
                .to_string(),
        ),
    }
}

#[tauri::command]
pub async fn stop_stt_session() -> Result<(), String> {
    let stop_handle = tauri::async_runtime::spawn_blocking(stt_runtime::stop_global_session);
    match tokio::time::timeout(
        Duration::from_secs(STT_STOP_COMMAND_TIMEOUT_SECS),
        stop_handle,
    )
    .await
    {
        Ok(join_result) => {
            join_result.map_err(|join_err| format!("Failed to join STT stop task: {}", join_err))?
        }
        Err(_) => Err("Остановка распознавания заняла слишком много времени.".to_string()),
    }
}

#[tauri::command]
pub fn is_stt_session_running() -> bool {
    stt_runtime::is_global_session_running()
}

#[tauri::command]
pub fn get_vosk_stt_status(app: tauri::AppHandle) -> SttStatus {
    let runtime = vosk_runtime::probe_runtime(&app);
    let base_dir = models_base_dir(&app).ok();
    let active_model_id = base_dir
        .as_deref()
        .and_then(read_active_release_model_id)
        .or_else(|| {
            base_dir
                .as_deref()
                .and_then(|dir| installed_release_model_ids(dir).into_iter().next())
        });
    let model_path = active_model_id
        .as_ref()
        .and_then(|model_id| base_dir.as_ref().map(|dir| dir.join(model_id)))
        .filter(|path| path.is_dir());
    let model_path_string = model_path
        .as_ref()
        .and_then(|path| path.to_str().map(String::from));
    let model_layout_error = model_path
        .as_ref()
        .and_then(|path| validate_vosk_model_layout(path).err());
    let model_usable = model_path_string.is_some() && model_layout_error.is_none();

    let detail = match (
        &runtime.available,
        &model_path_string,
        &active_model_id,
        &model_layout_error,
    ) {
        (_, Some(_), Some(_), Some(error)) => {
            format!(
                "Русский профиль распознавания поврежден или установлен не полностью. Переустановите его в настройках. {}",
                error
            )
        }
        (true, Some(_), Some(model_id), None) => {
            format!("Распознавание готово. Активный профиль: {}.", model_id)
        }
        (false, _, _, _) => runtime.detail.clone(),
        (_, None, _, _) => {
            "Русский профиль распознавания не установлен. Установите его в настройках.".to_string()
        }
        _ => "Vosk is not ready.".to_string(),
    };

    SttStatus {
        available: runtime.available && model_usable,
        model_loaded: runtime.available && model_usable,
        model_path: model_path_string,
        language: active_model_id.unwrap_or_else(|| "unknown".to_string()),
        runtime_library_loaded: runtime.available,
        runtime_library_path: runtime.library_path,
        detail,
    }
}

fn resolve_vosk_model_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = models_base_dir(app)?;
    let model_id = read_active_release_model_id(&base_dir)
        .or_else(|| installed_release_model_ids(&base_dir).into_iter().next())
        .ok_or_else(|| {
            "Русский профиль распознавания не установлен. Установите его в настройках.".to_string()
        })?;
    let model_path = base_dir.join(&model_id);
    if !model_path.is_dir() {
        return Err(format!(
            "Профиль распознавания '{}' не установлен. Установите его в настройках.",
            model_id
        ));
    }
    Ok(model_path)
}

#[tauri::command]
pub async fn start_vosk_stt_session(
    app: tauri::AppHandle,
    request: Option<StartSttSessionRequest>,
) -> Result<(), String> {
    let request = request.unwrap_or_default();
    let runtime = vosk_runtime::probe_runtime(&app);
    let runtime_library_path = runtime
        .library_path
        .as_ref()
        .filter(|_| runtime.available)
        .map(PathBuf::from)
        .ok_or_else(|| runtime.detail.clone())?;
    let model_path = resolve_vosk_model_path(&app)?;
    let startup_config = vosk_stt_runtime::SttRuntimeConfig {
        model_path,
        runtime_library_path,
        microphone_device_id: normalize_optional_device_id(request.microphone_device_id),
        system_audio_device_id: normalize_optional_device_id(request.system_audio_device_id),
    };

    let app_clone = app.clone();
    let startup_handle = tauri::async_runtime::spawn_blocking(move || {
        vosk_stt_runtime::start_global_session(app_clone, startup_config)
    });

    match tokio::time::timeout(
        Duration::from_secs(VOSK_STT_STARTUP_COMMAND_TIMEOUT_SECS),
        startup_handle,
    )
    .await
    {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join Vosk STT startup task: {}", join_err))?,
        Err(_) => {
            Err("Загрузка точного профиля распознавания заняла слишком много времени.".to_string())
        }
    }
}

#[tauri::command]
pub async fn stop_vosk_stt_session() -> Result<(), String> {
    let stop_handle = tauri::async_runtime::spawn_blocking(vosk_stt_runtime::stop_global_session);
    match tokio::time::timeout(
        Duration::from_secs(STT_STOP_COMMAND_TIMEOUT_SECS),
        stop_handle,
    )
    .await
    {
        Ok(join_result) => join_result
            .map_err(|join_err| format!("Failed to join Vosk STT stop task: {}", join_err))?,
        Err(_) => Err("Остановка распознавания заняла слишком много времени.".to_string()),
    }
}

#[tauri::command]
pub fn is_vosk_stt_session_running() -> bool {
    vosk_stt_runtime::is_global_session_running()
}

#[tauri::command]
pub fn switch_stt_language(language: String) -> Result<(), String> {
    stt_runtime::switch_global_language(normalize_primary_language(&language))
}

#[tauri::command]
pub fn list_whisper_models(app: tauri::AppHandle) -> Result<Vec<WhisperModelOption>, String> {
    let base_dir = whisper_models_base_dir(&app)?;
    let active_model_id = read_active_whisper_model_id(&app);

    Ok(WHISPER_MODEL_CATALOG
        .iter()
        .map(|entry| {
            let installed = whisper_model_path(&base_dir, entry.id).is_file();
            let active = active_model_id.as_deref() == Some(entry.id) && installed;
            WhisperModelOption {
                id: entry.id.to_string(),
                name: entry.name.to_string(),
                profile: entry.profile.to_string(),
                size_mb: entry.size_mb,
                download_url: entry.download_url.to_string(),
                installed,
                active,
            }
        })
        .collect())
}

#[tauri::command]
pub fn set_active_whisper_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = whisper_models_base_dir(&app)?;
    let normalized = validate_model_id(&model_id)?;
    whisper_model_file_name(normalized)?;
    let model_path = whisper_model_path(&base_dir, normalized);
    if !model_path.is_file() {
        return Err(format!(
            "Whisper model '{}' is not installed. Download it first.",
            normalized
        ));
    }

    write_active_whisper_model_id(&app, normalized)?;

    if stt_runtime::is_global_session_running() {
        stt_runtime::switch_global_model(model_path)?;
    }

    Ok(())
}

#[tauri::command]
pub fn remove_whisper_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = whisper_models_base_dir(&app)?;
    let normalized = validate_model_id(&model_id)?;
    whisper_model_file_name(normalized)?;
    let model_path = whisper_model_path(&base_dir, normalized);
    if !model_path.is_file() {
        return Err(format!("Whisper model '{}' is not installed.", normalized));
    }

    std::fs::remove_file(&model_path)
        .map_err(|e| format!("Failed to remove Whisper model: {}", e))?;

    if read_active_whisper_model_id(&app).as_deref() == Some(normalized) {
        let remaining = resolve_installed_whisper_model_ids(&app);
        if let Some(next_model) = remaining.first() {
            write_active_whisper_model_id(&app, next_model)?;
        } else {
            clear_active_whisper_model_id(&app)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn list_vosk_runtime_versions() -> Result<Vec<vosk_installer::VoskRuntimeVersion>, String>
{
    vosk_installer::list_versions().await
}

#[tauri::command]
pub async fn install_vosk_runtime(
    app: tauri::AppHandle,
    version: Option<String>,
) -> Result<vosk_installer::VoskRuntimeInstallResult, String> {
    vosk_installer::install_runtime(&app, version).await
}

#[tauri::command]
pub fn cancel_vosk_install() -> Result<(), String> {
    install_control::request_cancel();
    Ok(())
}

fn resolve_stt_config(
    app: &tauri::AppHandle,
    request: &StartSttSessionRequest,
) -> Result<(SttConfig, Option<SttDiagnostic>), String> {
    let (resolved_model_path, startup_diagnostic) =
        resolve_startup_whisper_model_path(app, request)?;
    let model_path = resolved_model_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| "Whisper model path contains invalid UTF-8.".to_string())?;

    Ok((
        SttConfig {
            model_path,
            runtime_library_path: None,
            ..SttConfig::default()
        },
        startup_diagnostic,
    ))
}

fn app_state_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state_dir = app_data_dir.join(APP_STATE_DIR_NAME);
    std::fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create app state directory: {}", e))?;
    Ok(state_dir)
}

fn sanitize_app_state_key(key: &str) -> String {
    let mut sanitized = String::new();
    for ch in key.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            sanitized.push(ch);
        } else {
            sanitized.push('_');
        }
    }

    let trimmed = sanitized.trim_matches('_');
    let base = if trimmed.is_empty() { "state" } else { trimmed };
    format!("{}.json", base)
}

fn app_state_file_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let state_dir = app_state_dir(app)?;
    Ok(state_dir.join(sanitize_app_state_key(key)))
}

fn friendly_stt_detail(detail: &str) -> String {
    let normalized = detail.replace('\n', " ").replace('\r', " ");
    let lowered = normalized.to_ascii_lowercase();

    if lowered.contains("runtime library and model are missing")
        || (lowered.contains("runtime") && lowered.contains("model") && lowered.contains("missing"))
    {
        return "Компоненты распознавания не установлены. Установите их в настройках распознавания.".to_string();
    }
    if lowered.contains("failed to load") {
        if lowered.contains("model") {
            return "Русский профиль распознавания не загрузился. Переустановите его в настройках."
                .to_string();
        }
        return "Компоненты распознавания найдены, но не загрузились. Переустановите их в настройках.".to_string();
    }
    if (lowered.contains("model") && lowered.contains("missing"))
        || (lowered.contains("model") && lowered.contains("not found"))
        || lowered.contains("download a model")
    {
        return "Русский профиль распознавания недоступен. Установите точный профиль Large в настройках."
            .to_string();
    }
    if (lowered.contains("runtime") || lowered.contains("libvosk"))
        && (lowered.contains("not found")
            || lowered.contains("missing")
            || lowered.contains("unloadable"))
    {
        return "Компоненты распознавания недоступны. Установите их в настройках.".to_string();
    }
    normalized
        .split(';')
        .next()
        .unwrap_or(&normalized)
        .split("Checked:")
        .next()
        .unwrap_or(&normalized)
        .trim()
        .to_string()
}

/// Creates the overlay window (always-on-top with system window controls). Must be async on Windows to avoid deadlock.
#[tauri::command]
pub async fn create_overlay_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    log::info!("create_overlay_window: request received");

    if let Some(existing_overlay) = app.get_webview_window("overlay") {
        lock.set_active(true);
        protect_window_from_capture(&existing_overlay);
        let _ = existing_overlay.unminimize();
        let _ = existing_overlay.show();
        let _ = existing_overlay.set_focus();
        log::info!("create_overlay_window: existing overlay focused");
        return Ok(());
    }

    let url = overlay_window_url(&app);

    let overlay_window = tauri::WebviewWindowBuilder::new(&app, "overlay", url)
        .title("AI Interview — Overlay")
        .inner_size(800.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .transparent(false)
        .decorations(true)
        .always_on_top(true)
        .resizable(true)
        .center()
        .build()
        .map_err(|e: tauri::Error| e.to_string())?;

    protect_window_from_capture(&overlay_window);
    let _ = overlay_window.show();
    let _ = overlay_window.unminimize();
    let _ = overlay_window.set_focus();
    lock.set_active(true);
    log::info!("create_overlay_window: overlay created and activated");

    Ok(())
}

#[tauri::command]
pub async fn close_main_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    lock.set_active(true);
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_skip_taskbar(true);
        let _ = main_window.minimize();
        let _ = main_window.hide();
    }

    Ok(())
}

#[tauri::command]
pub async fn restore_main_window(
    app: tauri::AppHandle,
    lock: tauri::State<'_, InterviewWindowLock>,
) -> Result<(), String> {
    lock.set_active(false);
    if let Some(main_window) = app.get_webview_window("main") {
        protect_window_from_capture(&main_window);
        let _ = main_window.set_skip_taskbar(false);
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
        return Ok(());
    }

    let url = app_window_url(&app);

    let main_window = tauri::WebviewWindowBuilder::new(&app, "main", url)
        .title("AI Interview")
        .inner_size(1100.0, 750.0)
        .min_inner_size(900.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .center()
        .decorations(true)
        .transparent(false)
        .build()
        .map_err(|e: tauri::Error| format!("Failed to create main window: {}", e))?;

    protect_window_from_capture(&main_window);
    let _ = main_window.set_skip_taskbar(false);
    let _ = main_window.show();
    let _ = main_window.unminimize();
    let _ = main_window.set_focus();

    Ok(())
}

const ACTIVE_MODEL_FILE: &str = "active_model.txt";
const MODEL_INDEX_CACHE_FILE: &str = "model-index-cache.json";
const VOSK_MODEL_INDEX_URL: &str = "https://e-rd.ru/downloads/ai-interview/vosk/model-list.json";

#[derive(Copy, Clone, Eq, PartialEq)]
enum VoskModelVariant {
    Small,
    Large,
}

impl VoskModelVariant {
    fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Large => "large",
        }
    }

    fn from_remote_type(model_type: &str, model_id: &str) -> Self {
        if model_type.eq_ignore_ascii_case("small") || model_id.contains("-small-") {
            Self::Small
        } else {
            Self::Large
        }
    }

    fn sort_rank(self) -> u8 {
        match self {
            Self::Small => 0,
            Self::Large => 1,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(untagged)]
enum BoolOrString {
    Bool(bool),
    String(String),
}

impl BoolOrString {
    fn as_bool(&self) -> bool {
        match self {
            Self::Bool(value) => *value,
            Self::String(value) => value.trim().eq_ignore_ascii_case("true"),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct VoskModelIndexEntry {
    lang: String,
    #[serde(default)]
    lang_text: String,
    name: String,
    #[serde(default)]
    obsolete: Option<BoolOrString>,
    size: u64,
    #[serde(rename = "type")]
    model_type: String,
    url: String,
    #[serde(default)]
    version: String,
}

#[derive(Clone)]
struct VoskModelCatalogEntry {
    id: String,
    name: String,
    language: String,
    variant: VoskModelVariant,
    size_mb: u32,
    download_url: String,
    family_key: String,
    default_baseline: bool,
}

const FALLBACK_MODEL_CATALOG: &[(&str, &str, &str, VoskModelVariant, u32, &str)] = &[(
    "vosk-model-ru-0.42",
    "Russian (Large)",
    "ru-RU",
    VoskModelVariant::Large,
    1848,
    "https://e-rd.ru/downloads/ai-interview/vosk/models/vosk-model-ru-0.42.zip",
)];
const RUSSIAN_LARGE_MODEL_ID: &str = "vosk-model-ru-0.42";
const LEGACY_NON_RUSSIAN_MODEL_IDS: &[&str] = &["vosk-model-small-en-us-0.15"];

struct VoskCatalogData {
    latest_by_family: Vec<VoskModelCatalogEntry>,
    id_to_family: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct VoskModelOption {
    pub id: String,
    pub name: String,
    pub language: String,
    pub variant: String,
    pub size_mb: u32,
    pub download_url: String,
    pub installed: bool,
    pub active: bool,
    pub update_available: bool,
    pub installed_versions: Vec<String>,
    pub default_baseline: bool,
}

#[derive(Clone, Serialize)]
pub struct WhisperModelOption {
    pub id: String,
    pub name: String,
    pub profile: String,
    pub size_mb: u32,
    pub download_url: String,
    pub installed: bool,
    pub active: bool,
}

struct WhisperModelCatalogEntry {
    id: &'static str,
    name: &'static str,
    profile: &'static str,
    size_mb: u32,
    download_url: &'static str,
}

const WHISPER_MODEL_CATALOG: &[WhisperModelCatalogEntry] = &[
    WhisperModelCatalogEntry {
        id: "whisper-small",
        name: "Whisper Small",
        profile: "weak",
        size_mb: 466,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    WhisperModelCatalogEntry {
        id: "whisper-medium",
        name: "Whisper Medium",
        profile: "medium",
        size_mb: 1530,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    },
    WhisperModelCatalogEntry {
        id: "whisper-large-v3",
        name: "Whisper Large v3",
        profile: "strong",
        size_mb: 2890,
        download_url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
    },
];

fn installed_model_ids(base_dir: &Path) -> Vec<String> {
    let mut models = std::fs::read_dir(base_dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(String::from)
        })
        .collect::<Vec<_>>();
    models.sort();
    models
}

fn is_release_vosk_model_id(model_id: &str) -> bool {
    !model_id.contains("-small-")
}

fn installed_release_model_ids(base_dir: &Path) -> Vec<String> {
    installed_model_ids(base_dir)
        .into_iter()
        .filter(|model_id| is_release_vosk_model_id(model_id))
        .collect()
}

fn read_active_release_model_id(base_dir: &Path) -> Option<String> {
    read_active_model_id(base_dir).filter(|model_id| is_release_vosk_model_id(model_id))
}

fn cleanup_models_outside_languages(
    base_dir: &Path,
    catalog: &VoskCatalogData,
    target_languages: &[String],
) -> Result<(), String> {
    let allowed_families = catalog
        .latest_by_family
        .iter()
        .filter(|entry| {
            target_languages
                .iter()
                .any(|language| language == &entry.language)
        })
        .map(|entry| entry.family_key.clone())
        .collect::<Vec<_>>();

    for installed_id in installed_model_ids(base_dir) {
        let keep = catalog
            .id_to_family
            .get(&installed_id)
            .is_some_and(|family| allowed_families.iter().any(|allowed| allowed == family));
        if keep {
            continue;
        }

        let model_dir = base_dir.join(&installed_id);
        if model_dir.strip_prefix(base_dir).is_err() {
            continue;
        }
        if model_dir.is_dir() {
            std::fs::remove_dir_all(&model_dir).map_err(|e| {
                format!(
                    "Failed to remove unused Vosk model '{}': {}",
                    model_dir.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn normalize_catalog_language(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "en" | "en-us" => "en-US".to_string(),
        "ru" | "ru-ru" => "ru-RU".to_string(),
        "es" | "es-es" => "es-ES".to_string(),
        "de" | "de-de" => "de-DE".to_string(),
        "fr" | "fr-fr" => "fr-FR".to_string(),
        "it" | "it-it" => "it-IT".to_string(),
        "pt" | "pt-br" => "pt-BR".to_string(),
        "cn" | "zh" | "zh-cn" => "zh-CN".to_string(),
        "ja" | "ja-jp" => "ja-JP".to_string(),
        "ko" | "ko-kr" => "ko-KR".to_string(),
        value if value.contains('-') => {
            let mut parts = value.split('-');
            let head = parts.next().unwrap_or(value);
            let tail = parts.next().unwrap_or_default();
            format!(
                "{}-{}",
                head.to_ascii_lowercase(),
                tail.to_ascii_uppercase()
            )
        }
        value => value.to_string(),
    }
}

fn normalize_primary_language(language: &str) -> String {
    match language.trim() {
        "ru" => "ru-RU".to_string(),
        "en" => "en-US".to_string(),
        "es" => "es-ES".to_string(),
        "de" => "de-DE".to_string(),
        "fr" => "fr-FR".to_string(),
        "it" => "it-IT".to_string(),
        "pt" => "pt-BR".to_string(),
        "zh" => "zh-CN".to_string(),
        "ja" => "ja-JP".to_string(),
        "ko" => "ko-KR".to_string(),
        value if !value.is_empty() => normalize_catalog_language(value),
        _ => "en-US".to_string(),
    }
}

fn is_default_baseline_language(language: &str) -> bool {
    matches!(
        language,
        "en-US"
            | "ru-RU"
            | "es-ES"
            | "de-DE"
            | "fr-FR"
            | "it-IT"
            | "pt-BR"
            | "zh-CN"
            | "ja-JP"
            | "ko-KR"
    )
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let mut i = 0usize;
    let mut j = 0usize;

    while i < left_bytes.len() && j < right_bytes.len() {
        let left_is_digit = left_bytes[i].is_ascii_digit();
        let right_is_digit = right_bytes[j].is_ascii_digit();

        if left_is_digit && right_is_digit {
            let left_start = i;
            while i < left_bytes.len() && left_bytes[i].is_ascii_digit() {
                i += 1;
            }
            let right_start = j;
            while j < right_bytes.len() && right_bytes[j].is_ascii_digit() {
                j += 1;
            }

            let left_chunk = &left[left_start..i];
            let right_chunk = &right[right_start..j];
            let left_trimmed = left_chunk.trim_start_matches('0');
            let right_trimmed = right_chunk.trim_start_matches('0');
            let left_norm = if left_trimmed.is_empty() {
                "0"
            } else {
                left_trimmed
            };
            let right_norm = if right_trimmed.is_empty() {
                "0"
            } else {
                right_trimmed
            };

            match left_norm.len().cmp(&right_norm.len()) {
                Ordering::Equal => match left_norm.cmp(right_norm) {
                    Ordering::Equal => {}
                    non_eq => return non_eq,
                },
                non_eq => return non_eq,
            }
        } else {
            let left_char = (left_bytes[i] as char).to_ascii_lowercase();
            let right_char = (right_bytes[j] as char).to_ascii_lowercase();
            match left_char.cmp(&right_char) {
                Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                non_eq => return non_eq,
            }
        }
    }

    left_bytes.len().cmp(&right_bytes.len())
}

fn should_replace_catalog_candidate(
    current_obsolete: bool,
    current_version: &str,
    current_id: &str,
    next_obsolete: bool,
    next_version: &str,
    next_id: &str,
) -> bool {
    if current_obsolete != next_obsolete {
        return !next_obsolete;
    }
    match natural_cmp(next_version, current_version) {
        Ordering::Greater => true,
        Ordering::Less => false,
        Ordering::Equal => natural_cmp(next_id, current_id).is_gt(),
    }
}

fn model_entry_from_index(
    raw: VoskModelIndexEntry,
) -> Option<(VoskModelCatalogEntry, bool, String)> {
    let id = raw.name.trim().to_string();
    if id.is_empty() || raw.url.trim().is_empty() {
        return None;
    }

    let variant = VoskModelVariant::from_remote_type(&raw.model_type, &id);
    if variant == VoskModelVariant::Small {
        return None;
    }
    let language = normalize_catalog_language(&raw.lang);
    let family_key = format!("{}|{}", language, variant.as_str());
    let size_mb = ((raw.size as f64) / (1024.0 * 1024.0)).ceil() as u32;
    let obsolete = raw.obsolete.as_ref().is_some_and(BoolOrString::as_bool);
    let version = if raw.version.trim().is_empty() {
        id.clone()
    } else {
        raw.version.trim().to_string()
    };
    let name = if raw.lang_text.trim().is_empty() {
        id.clone()
    } else {
        format!(
            "{} ({})",
            raw.lang_text.trim(),
            if variant == VoskModelVariant::Small {
                "Small"
            } else {
                "Large"
            }
        )
    };

    Some((
        VoskModelCatalogEntry {
            id,
            name,
            language: language.clone(),
            variant,
            size_mb,
            download_url: raw.url.trim().to_string(),
            family_key,
            default_baseline: variant == VoskModelVariant::Large
                && is_default_baseline_language(&language),
        },
        obsolete,
        version,
    ))
}

fn build_catalog_from_index(entries: Vec<VoskModelIndexEntry>) -> VoskCatalogData {
    let mut latest_by_family: HashMap<String, (VoskModelCatalogEntry, bool, String)> =
        HashMap::new();
    let mut id_to_family: HashMap<String, String> = HashMap::new();

    for raw in entries {
        let Some((entry, obsolete, version)) = model_entry_from_index(raw) else {
            continue;
        };
        id_to_family.insert(entry.id.clone(), entry.family_key.clone());

        if let Some((current, current_obsolete, current_version)) =
            latest_by_family.get(&entry.family_key)
        {
            if should_replace_catalog_candidate(
                *current_obsolete,
                current_version,
                &current.id,
                obsolete,
                &version,
                &entry.id,
            ) {
                latest_by_family.insert(entry.family_key.clone(), (entry, obsolete, version));
            }
            continue;
        }

        latest_by_family.insert(entry.family_key.clone(), (entry, obsolete, version));
    }

    let mut latest_by_family = latest_by_family
        .into_values()
        .map(|(entry, _, _)| entry)
        .collect::<Vec<_>>();
    latest_by_family.sort_by(|a, b| {
        a.language
            .cmp(&b.language)
            .then_with(|| a.variant.sort_rank().cmp(&b.variant.sort_rank()))
            .then_with(|| a.name.cmp(&b.name))
    });

    VoskCatalogData {
        latest_by_family,
        id_to_family,
    }
}

fn fallback_catalog() -> VoskCatalogData {
    let mut latest_by_family = Vec::new();
    let mut id_to_family = HashMap::new();

    for (id, name, language, variant, size_mb, download_url) in FALLBACK_MODEL_CATALOG {
        let family_key = format!("{}|{}", language, variant.as_str());
        latest_by_family.push(VoskModelCatalogEntry {
            id: (*id).to_string(),
            name: (*name).to_string(),
            language: (*language).to_string(),
            variant: *variant,
            size_mb: *size_mb,
            download_url: (*download_url).to_string(),
            family_key: family_key.clone(),
            default_baseline: *variant == VoskModelVariant::Large
                && is_default_baseline_language(language),
        });
        id_to_family.insert((*id).to_string(), family_key);
    }

    VoskCatalogData {
        latest_by_family,
        id_to_family,
    }
}

fn model_index_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join(MODEL_INDEX_CACHE_FILE)
}

fn read_cached_model_index(base_dir: &Path) -> Result<Vec<VoskModelIndexEntry>, String> {
    let cache_path = model_index_cache_path(base_dir);
    let content = std::fs::read_to_string(&cache_path).map_err(|e| {
        format!(
            "Failed to read cached model index '{}': {}",
            cache_path.display(),
            e
        )
    })?;
    serde_json::from_str::<Vec<VoskModelIndexEntry>>(&content)
        .map_err(|e| format!("Failed to parse cached model index: {}", e))
}

fn write_cached_model_index(
    base_dir: &Path,
    entries: &[VoskModelIndexEntry],
) -> Result<(), String> {
    let cache_path = model_index_cache_path(base_dir);
    let payload = serde_json::to_vec(entries)
        .map_err(|e| format!("Failed to serialize model index cache: {}", e))?;
    std::fs::write(&cache_path, payload).map_err(|e| {
        format!(
            "Failed to write model index cache '{}': {}",
            cache_path.display(),
            e
        )
    })
}

async fn fetch_remote_model_index() -> Result<Vec<VoskModelIndexEntry>, String> {
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(NETWORK_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODEL_INDEX_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client for model index: {}", e))?;
    client
        .get(VOSK_MODEL_INDEX_URL)
        .send()
        .await
        .map_err(|e| format!("Не удалось получить список профилей распознавания: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Не удалось загрузить список профилей распознавания: {}", e))?
        .json::<Vec<VoskModelIndexEntry>>()
        .await
        .map_err(|e| format!("Не удалось прочитать список профилей распознавания: {}", e))
}

async fn load_vosk_catalog(app: &tauri::AppHandle) -> Result<VoskCatalogData, String> {
    let base_dir = models_base_dir(app)?;

    if let Ok(remote) = fetch_remote_model_index().await {
        let _ = write_cached_model_index(&base_dir, &remote);
        let catalog = build_catalog_from_index(remote);
        if !catalog.latest_by_family.is_empty() {
            return Ok(catalog);
        }
    }

    if let Ok(cached) = read_cached_model_index(&base_dir) {
        let catalog = build_catalog_from_index(cached);
        if !catalog.latest_by_family.is_empty() {
            return Ok(catalog);
        }
    }

    Ok(fallback_catalog())
}

fn default_small_model_for_language<'a>(
    catalog: &'a [VoskModelCatalogEntry],
    language: &str,
) -> Option<&'a VoskModelCatalogEntry> {
    catalog
        .iter()
        .find(|entry| entry.language == language && entry.variant == VoskModelVariant::Large)
}

#[tauri::command]
pub async fn list_vosk_models(app: tauri::AppHandle) -> Result<Vec<VoskModelOption>, String> {
    let base_dir = models_base_dir(&app)?;
    let active_model_id = read_active_release_model_id(&base_dir);
    let installed_ids = installed_release_model_ids(&base_dir);
    let catalog = load_vosk_catalog(&app).await?;

    let mut installed_by_family: HashMap<String, Vec<String>> = HashMap::new();
    for installed_id in installed_ids {
        if let Some(family_key) = catalog.id_to_family.get(&installed_id) {
            installed_by_family
                .entry(family_key.clone())
                .or_default()
                .push(installed_id);
        }
    }

    Ok(catalog
        .latest_by_family
        .iter()
        .map(|entry| {
            let mut installed_versions = installed_by_family
                .get(&entry.family_key)
                .cloned()
                .unwrap_or_default();
            installed_versions.sort();

            let installed = installed_versions
                .iter()
                .any(|version| version == &entry.id);
            let active = active_model_id
                .as_ref()
                .is_some_and(|active_id| installed_versions.iter().any(|id| id == active_id));
            let update_available = !installed_versions.is_empty() && !installed;

            VoskModelOption {
                id: entry.id.clone(),
                name: entry.name.clone(),
                language: entry.language.clone(),
                variant: entry.variant.as_str().to_string(),
                size_mb: entry.size_mb,
                download_url: entry.download_url.clone(),
                installed,
                active,
                update_available,
                installed_versions,
                default_baseline: entry.default_baseline,
            }
        })
        .collect())
}

#[tauri::command]
pub fn set_active_vosk_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let normalized_model_id = model_id.trim();
    if !is_release_vosk_model_id(normalized_model_id) {
        return Err(
            "Этот профиль больше не используется. Установите точный русский профиль.".to_string(),
        );
    }
    let model_dir = base_dir.join(normalized_model_id);
    if !model_dir.is_dir() {
        return Err(format!(
            "Профиль '{}' не установлен. Сначала установите его.",
            normalized_model_id
        ));
    }

    write_active_model_id(&base_dir, normalized_model_id)
}

#[tauri::command]
pub fn switch_stt_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let normalized = model_id.trim();
    if !is_release_vosk_model_id(normalized) {
        return Err(
            "Этот профиль больше не используется. Установите точный русский профиль.".to_string(),
        );
    }
    let model_dir = base_dir.join(normalized);
    if !model_dir.is_dir() {
        return Err(format!(
            "Профиль '{}' не установлен. Сначала установите его.",
            normalized
        ));
    }

    write_active_model_id(&base_dir, normalized)?;

    if stt_runtime::is_global_session_running() {
        stt_runtime::switch_global_model(model_dir)?;
    }

    Ok(())
}

#[tauri::command]
pub async fn preload_stt_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let app_clone = app.clone();
    let preload_handle = tauri::async_runtime::spawn_blocking(move || {
        let base_dir = whisper_models_base_dir(&app_clone)?;
        let normalized = validate_model_id(&model_id)?;
        whisper_model_file_name(normalized)?;
        let model_path = whisper_model_path(&base_dir, normalized);
        if !model_path.is_file() {
            return Err(format!(
                "Профиль '{}' не установлен. Сначала установите его.",
                normalized
            ));
        }

        if stt_runtime::is_global_session_running() {
            stt_runtime::preload_global_model(model_path)?;
        } else {
            stt_runtime::warm_model_cache(model_path)?;
        }

        Ok(())
    });

    preload_handle
        .await
        .map_err(|join_err| format!("Failed to join STT preload task: {}", join_err))?
}

#[tauri::command]
pub fn remove_vosk_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let base_dir = models_base_dir(&app)?;
    let normalized = validate_model_id(&model_id)?;
    let target_dir = base_dir.join(normalized);
    if !target_dir.is_dir() {
        return Err(format!("Профиль '{}' не установлен.", normalized));
    }
    let target_dir = canonical_existing_child_dir(&base_dir, &target_dir)?;
    std::fs::remove_dir_all(&target_dir).map_err(|e| format!("Failed to remove model: {}", e))?;

    if read_active_model_id(&base_dir).as_deref() == Some(normalized) {
        let remaining = installed_model_ids(&base_dir);
        if let Some(next_model) = remaining.first() {
            write_active_model_id(&base_dir, next_model)?;
        } else {
            clear_active_model_id(&base_dir)?;
        }
    }

    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct VoskModelDownloadProgress {
    pub bytes_downloaded: u64,
    pub content_length: Option<u64>,
    pub percent: f32,
    pub phase: String, // "downloading" | "extracting"
}

#[derive(Clone, serde::Serialize)]
pub struct WhisperModelDownloadProgress {
    pub bytes_downloaded: u64,
    pub content_length: Option<u64>,
    pub percent: f32,
    pub phase: String, // "downloading"
}

#[tauri::command]
pub async fn download_whisper_model(
    app: tauri::AppHandle,
    url: String,
    model_id: String,
) -> Result<String, String> {
    install_control::reset_cancel();
    let normalized_model_id = validate_model_id(&model_id)?.to_string();
    whisper_model_file_name(&normalized_model_id)?;
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(NETWORK_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODEL_DOWNLOAD_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Не удалось подготовить загрузку: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to download Whisper model: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Whisper model download failed with status {}",
            response.status()
        ));
    }

    let total = response.content_length();
    let base_dir = whisper_models_base_dir(&app)?;
    let temp_path = base_dir.join(format!("{}.download", normalized_model_id));
    let target_path = whisper_model_path(&base_dir, &normalized_model_id);
    let mut file = std::fs::File::create(&temp_path)
        .map_err(|e| format!("Failed to create Whisper model file: {}", e))?;

    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(next_chunk) = stream.next().await {
        if install_control::is_cancelled() {
            let _ = std::fs::remove_file(&temp_path);
            return Err("Whisper installation cancelled by user.".to_string());
        }
        let chunk = next_chunk.map_err(|e| format!("Failed to read Whisper model chunk: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write Whisper model file: {}", e))?;
        downloaded += chunk.len() as u64;
        let percent = total
            .map(|content_length| {
                ((downloaded as f64 / content_length as f64) * 100.0).clamp(0.0, 100.0) as f32
            })
            .unwrap_or(0.0);
        let _ = app.emit(
            "whisper_model_download_progress",
            WhisperModelDownloadProgress {
                bytes_downloaded: downloaded,
                content_length: total,
                percent,
                phase: "downloading".to_string(),
            },
        );
    }

    if target_path.exists() {
        std::fs::remove_file(&target_path)
            .map_err(|e| format!("Failed to replace Whisper model file: {}", e))?;
    }
    std::fs::rename(&temp_path, &target_path)
        .map_err(|e| format!("Failed to finalize Whisper model file: {}", e))?;

    if read_active_whisper_model_id(&app).is_none() {
        let _ = write_active_whisper_model_id(&app, &normalized_model_id);
    }

    target_path
        .to_str()
        .ok_or_else(|| "Invalid Whisper model path".to_string())
        .map(String::from)
}

/// Downloads a Vosk model zip from URL, extracts to app_data/models/vosk/<model_id>, emits progress.
#[tauri::command]
pub async fn download_vosk_model(
    app: tauri::AppHandle,
    url: String,
    model_id: String,
    cleanup_model_ids: Option<Vec<String>>,
) -> Result<String, String> {
    install_control::reset_cancel();
    if !is_release_vosk_model_id(model_id.trim()) {
        return Err(
            "Этот профиль больше не используется. Установите точный русский профиль.".to_string(),
        );
    }
    let cleanup_model_ids = cleanup_model_ids.unwrap_or_default();
    download_vosk_model_internal(&app, &url, &model_id, true, &cleanup_model_ids).await
}

#[tauri::command]
pub async fn install_vosk_model_from_zip(
    app: tauri::AppHandle,
    archive_path: String,
    model_id: String,
    cleanup_model_ids: Option<Vec<String>>,
) -> Result<String, String> {
    install_control::reset_cancel();
    if !is_release_vosk_model_id(model_id.trim()) {
        return Err(
            "Этот профиль больше не используется. Установите точный русский профиль.".to_string(),
        );
    }
    let cleanup_model_ids = cleanup_model_ids.unwrap_or_default();
    let archive_path = PathBuf::from(archive_path.trim());
    if archive_path.as_os_str().is_empty() {
        return Err("Select a Vosk model ZIP archive first.".to_string());
    }
    if !archive_path.is_file() {
        return Err(format!(
            "Selected Vosk model archive does not exist: {}",
            archive_path.display()
        ));
    }
    let is_zip = archive_path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Err("Selected file must be a .zip archive.".to_string());
    }

    let models_dir = models_base_dir(&app)?;
    let archive_size = std::fs::metadata(&archive_path)
        .ok()
        .map(|metadata| metadata.len());
    install_vosk_model_archive(
        &app,
        &archive_path,
        &models_dir,
        model_id.trim(),
        true,
        &cleanup_model_ids,
        archive_size,
        5.0,
    )
}

#[tauri::command]
pub async fn ensure_default_stt_assets(
    app: tauri::AppHandle,
    primary_language: String,
) -> Result<(), String> {
    let normalized_language = normalize_primary_language(&primary_language);
    let catalog = load_vosk_catalog(&app).await?;

    if let Err(err) = vosk_installer::install_runtime(&app, None).await {
        let runtime_probe = vosk_runtime::probe_runtime(&app);
        if !runtime_probe.available {
            return Err(err);
        }
    }

    let baseline = vec![normalized_language.clone()];

    let base_dir = models_base_dir(&app)?;
    cleanup_models_outside_languages(&base_dir, &catalog, &baseline)?;

    for language in baseline {
        if let Some(default_small) =
            default_small_model_for_language(&catalog.latest_by_family, &language)
        {
            let installed_ids = installed_model_ids(&base_dir);
            let installed_versions = installed_ids
                .iter()
                .filter(|id| catalog.id_to_family.get(*id) == Some(&default_small.family_key))
                .cloned()
                .collect::<Vec<_>>();
            let has_latest = installed_versions.iter().any(|id| id == &default_small.id);
            if !has_latest {
                let cleanup_model_ids = installed_versions
                    .into_iter()
                    .filter(|id| id != &default_small.id)
                    .collect::<Vec<_>>();
                download_vosk_model_internal(
                    &app,
                    &default_small.download_url,
                    &default_small.id,
                    false,
                    &cleanup_model_ids,
                )
                .await?;
            }
        }
    }

    if let Some(default_primary) =
        default_small_model_for_language(&catalog.latest_by_family, &normalized_language)
    {
        let _ = set_active_vosk_model(app.clone(), default_primary.id.to_string());
    }

    Ok(())
}

async fn download_vosk_model_internal(
    app: &tauri::AppHandle,
    url: &str,
    model_id: &str,
    emit_progress: bool,
    cleanup_model_ids: &[String],
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("ai-interview-desktop/0.1")
        .connect_timeout(Duration::from_secs(NETWORK_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(MODEL_DOWNLOAD_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Не удалось подготовить загрузку: {}", e))?;
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать профиль распознавания: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Загрузка профиля распознавания не удалась: {}", e))?;

    let models_dir = models_base_dir(app)?;
    let temp_archive_path = models_dir.join(format!(".{}.download.zip", model_id));
    if temp_archive_path.exists() {
        std::fs::remove_file(&temp_archive_path).map_err(|e| e.to_string())?;
    }

    let total_size = res.content_length();
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut archive_file = std::fs::File::create(&temp_archive_path).map_err(|e| {
        format!(
            "Failed to create temp archive '{}': {}",
            temp_archive_path.display(),
            e
        )
    })?;

    while let Some(chunk) = stream.next().await {
        if install_control::is_cancelled() {
            let _ = std::fs::remove_file(&temp_archive_path);
            return Err("Установка отменена.".to_string());
        }
        let chunk = chunk.map_err(|e: reqwest::Error| e.to_string())?;
        downloaded += chunk.len() as u64;
        archive_file
            .write_all(&chunk)
            .map_err(|e| format!("Не удалось сохранить архив профиля: {}", e))?;

        let percent = total_size
            .map(|t| (downloaded as f32 / t as f32) * 100.0)
            .unwrap_or(0.0);
        if emit_progress {
            let _ = app.emit(
                "vosk_model_download_progress",
                VoskModelDownloadProgress {
                    bytes_downloaded: downloaded,
                    content_length: total_size,
                    percent,
                    phase: "downloading".to_string(),
                },
            );
        }
    }

    archive_file
        .flush()
        .map_err(|e| format!("Failed to flush Vosk model archive: {}", e))?;
    drop(archive_file);

    let install_result = install_vosk_model_archive(
        app,
        &temp_archive_path,
        &models_dir,
        model_id,
        emit_progress,
        cleanup_model_ids,
        Some(downloaded),
        90.0,
    );
    let _ = std::fs::remove_file(&temp_archive_path);
    install_result
}

fn emit_vosk_model_progress(
    app: &tauri::AppHandle,
    bytes_downloaded: u64,
    content_length: Option<u64>,
    percent: f32,
    phase: &str,
) {
    let _ = app.emit(
        "vosk_model_download_progress",
        VoskModelDownloadProgress {
            bytes_downloaded,
            content_length,
            percent,
            phase: phase.to_string(),
        },
    );
}

fn install_vosk_model_archive(
    app: &tauri::AppHandle,
    archive_path: &Path,
    models_dir: &Path,
    model_id: &str,
    emit_progress: bool,
    cleanup_model_ids: &[String],
    archive_size: Option<u64>,
    extracting_start_percent: f32,
) -> Result<String, String> {
    let model_id = validate_model_id(model_id)?;
    let progress_bytes = archive_size.unwrap_or(0);
    if emit_progress {
        emit_vosk_model_progress(
            app,
            progress_bytes,
            archive_size,
            extracting_start_percent,
            "extracting",
        );
    }
    let extract_dir = models_dir.join(format!(".{}.partial", model_id));
    if extract_dir.exists() {
        std::fs::remove_dir_all(&extract_dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    let archive_file = std::fs::File::open(archive_path).map_err(|e| {
        format!(
            "Не удалось открыть ZIP-файл '{}': {}",
            archive_path.display(),
            e
        )
    })?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|e| format!("Некорректный ZIP-файл профиля: {}", e))?;
    let archive_len = archive.len().max(1);

    for i in 0..archive.len() {
        if install_control::is_cancelled() {
            let _ = std::fs::remove_dir_all(&extract_dir);
            return Err("Установка отменена.".to_string());
        }
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().replace('\\', "/");
        if name.contains("..") {
            continue;
        }
        let out_path = extract_dir.join(&name);
        if out_path.strip_prefix(&extract_dir).is_err() {
            continue;
        }
        if file.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(p) = out_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
        }
        if emit_progress && (i % 12 == 0 || i + 1 == archive_len) {
            let extracted_ratio = (i + 1) as f32 / archive_len as f32;
            let percent =
                extracting_start_percent + ((100.0 - extracting_start_percent) * extracted_ratio);
            emit_vosk_model_progress(
                app,
                progress_bytes,
                archive_size,
                percent.min(99.0),
                "extracting",
            );
        }
    }

    normalize_extracted_model_layout(&extract_dir)?;
    validate_vosk_model_layout(&extract_dir)?;

    let target_dir = models_dir.join(model_id);
    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&extract_dir, &target_dir).map_err(|e| e.to_string())?;

    if emit_progress {
        emit_vosk_model_progress(app, progress_bytes, archive_size, 100.0, "extracting");
    }

    cleanup_selected_models(&models_dir, cleanup_model_ids, model_id)?;

    if read_active_model_id(&models_dir)
        .as_ref()
        .is_some_and(|active| cleanup_model_ids.iter().any(|id| id == active))
    {
        let _ = write_active_model_id(&models_dir, model_id);
    }

    if read_active_model_id(&models_dir).is_none() {
        let _ = write_active_model_id(&models_dir, model_id);
    }

    target_dir
        .to_str()
        .ok_or_else(|| "Invalid path".to_string())
        .map(String::from)
}

fn validate_vosk_model_layout(model_dir: &Path) -> Result<(), String> {
    let has_model_config = model_dir.join("conf").join("model.conf").is_file();
    let has_acoustic_model =
        model_dir.join("am").join("final.mdl").is_file() || model_dir.join("final.mdl").is_file();
    let has_graph = model_dir.join("graph").join("HCLG.fst").is_file()
        || (model_dir.join("graph").join("HCLr.fst").is_file()
            && model_dir.join("graph").join("Gr.fst").is_file());

    if has_model_config && has_acoustic_model && has_graph {
        return Ok(());
    }

    Err(
        "Выбранный ZIP не похож на пакет распознавания. Скачайте ZIP по ссылке из приложения и выберите его без распаковки.".to_string(),
    )
}

fn models_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data.join("models").join("vosk");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    seed_bundled_models_if_needed(app, &models_dir)?;
    cleanup_legacy_non_russian_models(&models_dir)?;
    Ok(models_dir)
}

fn cleanup_legacy_non_russian_models(models_dir: &Path) -> Result<(), String> {
    for model_id in LEGACY_NON_RUSSIAN_MODEL_IDS {
        let model_dir = models_dir.join(model_id);
        if model_dir.strip_prefix(models_dir).is_err() {
            continue;
        }
        if model_dir.is_dir() {
            std::fs::remove_dir_all(&model_dir).map_err(|e| {
                format!(
                    "Failed to remove legacy Vosk model '{}': {}",
                    model_dir.display(),
                    e
                )
            })?;
        }
    }

    let active_model_is_not_release = read_active_model_id(models_dir)
        .as_deref()
        .is_some_and(|active| !is_release_vosk_model_id(active));
    if active_model_is_not_release && models_dir.join(RUSSIAN_LARGE_MODEL_ID).is_dir() {
        let _ = write_active_model_id(models_dir, RUSSIAN_LARGE_MODEL_ID);
    }

    Ok(())
}

fn seed_bundled_models_if_needed(app: &tauri::AppHandle, models_dir: &Path) -> Result<(), String> {
    let bundled_dir = bundled_models_dir(app);
    let Some(bundled_dir) = bundled_dir else {
        return Ok(());
    };

    copy_dir_contents(&bundled_dir, models_dir)?;

    if read_active_model_id(models_dir).is_none() {
        let bundled_active = bundled_dir.join(ACTIVE_MODEL_FILE);
        if bundled_active.is_file() {
            let active_model = std::fs::read_to_string(&bundled_active)
                .map_err(|e| format!("Failed to read bundled active model marker: {}", e))?;
            let trimmed = active_model.trim();
            if !trimmed.is_empty() && is_release_vosk_model_id(trimmed) {
                let _ = write_active_model_id(models_dir, trimmed);
            }
        }
    }

    Ok(())
}

fn bundled_models_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("models").join("vosk"),
        resource_dir.join("resources").join("models").join("vosk"),
    ];

    candidates.into_iter().find(|path| path.is_dir())
}

fn copy_dir_contents(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create destination directory: {}", e))?;

    for entry in std::fs::read_dir(source)
        .map_err(|e| format!("Failed to read bundled assets directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read bundled asset entry: {}", e))?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
            continue;
        }

        if !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy bundled asset '{}' to '{}': {}",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create bundled asset directory: {}", e))?;

    for entry in std::fs::read_dir(source).map_err(|e| {
        format!(
            "Failed to read bundled asset directory '{}': {}",
            source.display(),
            e
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read bundled asset entry: {}", e))?;
        let source_path = entry.path();
        let target_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to copy bundled file '{}' to '{}': {}",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn active_model_marker_path(base_dir: &Path) -> PathBuf {
    base_dir.join(ACTIVE_MODEL_FILE)
}

fn read_active_model_id(base_dir: &Path) -> Option<String> {
    std::fs::read_to_string(active_model_marker_path(base_dir))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_active_model_id(base_dir: &Path, model_id: &str) -> Result<(), String> {
    std::fs::write(active_model_marker_path(base_dir), model_id)
        .map_err(|e| format!("Не удалось выбрать активный профиль: {}", e))
}

fn clear_active_model_id(base_dir: &Path) -> Result<(), String> {
    let marker = active_model_marker_path(base_dir);
    if marker.exists() {
        std::fs::remove_file(marker)
            .map_err(|e| format!("Не удалось сбросить активный профиль: {}", e))?;
    }
    Ok(())
}

fn whisper_models_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data.join("models").join("whisper");
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    Ok(models_dir)
}

fn validate_model_id(model_id: &str) -> Result<&str, String> {
    let trimmed = model_id.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(format!("Некорректный идентификатор модели: '{}'", model_id));
    }
    Ok(trimmed)
}

fn canonical_existing_child_dir(base_dir: &Path, target_dir: &Path) -> Result<PathBuf, String> {
    let canonical_base = base_dir
        .canonicalize()
        .map_err(|e| format!("Failed to validate models directory: {}", e))?;
    let canonical_target = target_dir
        .canonicalize()
        .map_err(|e| format!("Failed to validate model directory: {}", e))?;
    if !canonical_target.starts_with(&canonical_base) || canonical_target == canonical_base {
        return Err("Путь модели находится вне каталога моделей.".to_string());
    }
    Ok(canonical_target)
}

fn whisper_model_file_name(model_id: &str) -> Result<&'static str, String> {
    match model_id.trim() {
        "whisper-small" => Ok("ggml-small.bin"),
        "whisper-medium" => Ok("ggml-medium.bin"),
        "whisper-large-v3" => Ok("ggml-large-v3.bin"),
        other => Err(format!("Unknown Whisper model '{}'", other)),
    }
}

fn whisper_model_path(base_dir: &Path, model_id: &str) -> PathBuf {
    let file_name = whisper_model_file_name(model_id).unwrap_or("model.bin");
    base_dir.join(file_name)
}

fn active_whisper_model_marker_path(base_dir: &Path) -> PathBuf {
    base_dir.join(ACTIVE_MODEL_FILE)
}

fn read_active_whisper_model_id(app: &tauri::AppHandle) -> Option<String> {
    let base_dir = whisper_models_base_dir(app).ok()?;
    std::fs::read_to_string(active_whisper_model_marker_path(&base_dir))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn write_active_whisper_model_id(app: &tauri::AppHandle, model_id: &str) -> Result<(), String> {
    let base_dir = whisper_models_base_dir(app)?;
    std::fs::write(active_whisper_model_marker_path(&base_dir), model_id)
        .map_err(|e| format!("Failed to set active Whisper model: {}", e))
}

fn clear_active_whisper_model_id(app: &tauri::AppHandle) -> Result<(), String> {
    let base_dir = whisper_models_base_dir(app)?;
    let marker = active_whisper_model_marker_path(&base_dir);
    if marker.exists() {
        std::fs::remove_file(marker)
            .map_err(|e| format!("Failed to clear active Whisper model: {}", e))?;
    }
    Ok(())
}

fn resolve_installed_whisper_model_ids(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(base_dir) = whisper_models_base_dir(app) else {
        return Vec::new();
    };

    WHISPER_MODEL_CATALOG
        .iter()
        .filter(|entry| whisper_model_path(&base_dir, entry.id).is_file())
        .map(|entry| entry.id.to_string())
        .collect()
}

fn resolve_stt_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base_dir = whisper_models_base_dir(app).ok()?;

    if let Some(active_model_id) = read_active_whisper_model_id(app) {
        let active_path = whisper_model_path(&base_dir, active_model_id.trim());
        if active_path.is_file() {
            return Some(active_path);
        }
    }

    resolve_installed_whisper_model_ids(app)
        .into_iter()
        .find_map(|model_id| {
            let path = whisper_model_path(&base_dir, &model_id);
            if path.is_file() {
                Some(path)
            } else {
                None
            }
        })
}

fn infer_whisper_model_id_from_path(path: &Path) -> Option<&'static str> {
    let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if file_name.contains("small") {
        Some("whisper-small")
    } else if file_name.contains("medium") {
        Some("whisper-medium")
    } else if file_name.contains("large") {
        Some("whisper-large-v3")
    } else {
        None
    }
}

fn whisper_model_display_name(model_id: &str) -> &'static str {
    match model_id {
        "whisper-small" => "Whisper Small",
        "whisper-medium" => "Whisper Medium",
        "whisper-large-v3" => "Whisper Large v3",
        _ => "Whisper model",
    }
}

fn resolve_startup_whisper_model_path(
    app: &tauri::AppHandle,
    _request: &StartSttSessionRequest,
) -> Result<(PathBuf, Option<SttDiagnostic>), String> {
    let default_path = resolve_stt_model_path(app)
        .ok_or_else(|| "Whisper model is not installed. Download a profile first.".to_string())?;

    #[cfg(not(target_os = "windows"))]
    {
        return Ok((default_path, None));
    }

    #[cfg(target_os = "windows")]
    {
        let active_model_id = read_active_whisper_model_id(app)
            .or_else(|| infer_whisper_model_id_from_path(&default_path).map(str::to_string));

        if active_model_id.as_deref() != Some("whisper-large-v3") {
            return Ok((default_path, None));
        }

        let base_dir = whisper_models_base_dir(app)?;
        for fallback_id in ["whisper-small", "whisper-medium"] {
            let fallback_path = whisper_model_path(&base_dir, fallback_id);
            if fallback_path.is_file() {
                if fallback_path != default_path {
                    let message = format!(
                        "Enabled {} for stable live transcription. Whisper Large can lag heavily with simultaneous microphone and system-audio capture on CPU.",
                        whisper_model_display_name(fallback_id)
                    );
                    return Ok((
                        fallback_path,
                        Some(SttDiagnostic {
                            code: "model_fallback".to_string(),
                            level: "warn".to_string(),
                            message,
                            source: None,
                        }),
                    ));
                }
                return Ok((default_path, None));
            }
        }

        let warning = SttDiagnostic {
            code: "model_realtime_warning".to_string(),
            level: "warn".to_string(),
            message:
                "The selected speech profile is heavy, so live text can appear with longer delays."
                    .to_string(),
            source: None,
        };
        Ok((default_path, Some(warning)))
    }
}

fn normalize_extracted_model_layout(extract_dir: &Path) -> Result<(), String> {
    let mut root_dirs = Vec::new();
    let mut root_files = 0usize;

    for entry in std::fs::read_dir(extract_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            root_dirs.push(path);
        } else if path.is_file() {
            root_files += 1;
        }
    }

    if root_files == 0 && root_dirs.len() == 1 {
        let nested_root = &root_dirs[0];
        let nested_entries = std::fs::read_dir(nested_root).map_err(|e| e.to_string())?;
        for nested in nested_entries {
            let nested = nested.map_err(|e| e.to_string())?;
            let source = nested.path();
            let target = extract_dir.join(nested.file_name());
            std::fs::rename(source, target).map_err(|e| e.to_string())?;
        }
        std::fs::remove_dir_all(nested_root).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn cleanup_selected_models(
    models_dir: &Path,
    model_ids: &[String],
    keep_model_id: &str,
) -> Result<(), String> {
    let keep_model_id = validate_model_id(keep_model_id)?;
    let validated_model_ids = model_ids
        .iter()
        .map(|model_id| validate_model_id(model_id))
        .collect::<Result<Vec<_>, _>>()?;

    for model_id in validated_model_ids {
        if model_id == keep_model_id {
            continue;
        }
        let target_dir = models_dir.join(model_id);
        if target_dir.is_dir() {
            let target_dir = canonical_existing_child_dir(models_dir, &target_dir)?;
            std::fs::remove_dir_all(&target_dir)
                .map_err(|e| format!("Failed to remove old model '{}': {}", model_id, e))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod model_path_security_tests {
    use super::{cleanup_selected_models, validate_model_id};

    #[test]
    fn rejects_model_id_path_traversal() {
        for model_id in ["../../etc", "../Documents", "nested/model", r"nested\model"] {
            assert!(validate_model_id(model_id).is_err(), "{model_id}");
        }
    }

    #[test]
    fn cleanup_rejects_traversal_before_touching_filesystem() {
        let models_dir = std::env::temp_dir().join(format!(
            "ai-interview-model-security-{}",
            std::process::id()
        ));
        let outside_dir = models_dir.with_extension("outside");
        std::fs::create_dir_all(&models_dir).expect("create models test directory");
        std::fs::create_dir_all(&outside_dir).expect("create outside test directory");
        std::fs::write(outside_dir.join("keep.txt"), b"safe").expect("create sentinel");

        let result = cleanup_selected_models(
            &models_dir,
            &[format!(
                "../{}",
                outside_dir.file_name().unwrap().to_string_lossy()
            )],
            "current-model",
        );

        assert!(result.is_err());
        assert!(outside_dir.join("keep.txt").is_file());

        let _ = std::fs::remove_dir_all(models_dir);
        let _ = std::fs::remove_dir_all(outside_dir);
    }
}
