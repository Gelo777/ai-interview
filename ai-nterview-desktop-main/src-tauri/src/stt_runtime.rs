use crate::audio;
use crate::stt::{SttDiagnostic, SttResult};
#[cfg(target_os = "windows")]
use crate::system_audio;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use libloading::Library;
use std::ffi::{CStr, CString};
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
use std::os::raw::{c_char, c_float, c_int, c_short, c_void};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const AUDIO_QUEUE_CAPACITY: usize = 12;
const MODEL_SWITCH_MANAGER_TIMEOUT: Duration = Duration::from_secs(50);
const MODEL_SWITCH_WORKER_TIMEOUT: Duration = Duration::from_secs(45);
const MODEL_PRELOAD_MANAGER_TIMEOUT: Duration = Duration::from_secs(75);
const MODEL_PRELOAD_WORKER_TIMEOUT: Duration = Duration::from_secs(70);

#[derive(Debug, Clone)]
pub struct SttRuntimeConfig {
    pub model_path: PathBuf,
    pub runtime_library_path: PathBuf,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

pub fn start_global_session(app: AppHandle, config: SttRuntimeConfig) -> Result<(), String> {
    let mut guard = controller_slot()
        .lock()
        .map_err(|_| "Failed to lock STT controller state".to_string())?;
    cleanup_finished_session_locked(&mut guard);

    if guard.is_some() {
        return Err("STT session is already running".to_string());
    }

    let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
    let handle = thread::Builder::new()
        .name("stt-session-manager".to_string())
        .spawn(move || match SttSession::start(app, config) {
            Ok(mut session) => {
                let _ = startup_tx.send(Ok(()));
                while let Ok(message) = control_rx.recv() {
                    match message {
                        ControlMessage::Stop => {
                            break;
                        }
                        ControlMessage::SwitchModel {
                            model_path,
                            reply_tx,
                        } => {
                            let _ = reply_tx.send(session.switch_model(&model_path));
                        }
                        ControlMessage::PreloadModel {
                            model_path,
                            reply_tx,
                        } => {
                            let _ = reply_tx.send(session.preload_model(&model_path));
                        }
                    }
                }
                session.stop();
            }
            Err(err) => {
                log::error!("Failed to start STT session: {}", err);
                let _ = startup_tx.send(Err(err));
            }
        })
        .map_err(|e| format!("Failed to spawn STT manager thread: {}", e))?;

    match startup_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = handle.join();
            return Err(err);
        }
        Err(_) => {
            let _ = handle.join();
            return Err("STT manager exited before startup confirmation".to_string());
        }
    }

    *guard = Some(SessionController {
        tx: control_tx,
        handle,
    });
    Ok(())
}

pub fn stop_global_session() -> Result<(), String> {
    let mut guard = controller_slot()
        .lock()
        .map_err(|_| "Failed to lock STT controller state".to_string())?;
    cleanup_finished_session_locked(&mut guard);

    if let Some(controller) = guard.take() {
        let _ = controller.tx.send(ControlMessage::Stop);
        let _ = controller.handle.join();
    }

    Ok(())
}

pub fn switch_global_model(model_path: PathBuf) -> Result<(), String> {
    let mut guard = controller_slot()
        .lock()
        .map_err(|_| "Failed to lock STT controller state".to_string())?;
    cleanup_finished_session_locked(&mut guard);

    let controller = guard
        .as_ref()
        .ok_or_else(|| "STT session is not running".to_string())?;

    let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
    controller
        .tx
        .send(ControlMessage::SwitchModel {
            model_path,
            reply_tx,
        })
        .map_err(|_| "Failed to request STT model switch".to_string())?;

    match reply_rx.recv_timeout(MODEL_SWITCH_MANAGER_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Timed out while switching STT model".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("STT model switch channel disconnected".to_string())
        }
    }
}

pub fn preload_global_model(model_path: PathBuf) -> Result<(), String> {
    let mut guard = controller_slot()
        .lock()
        .map_err(|_| "Failed to lock STT controller state".to_string())?;
    cleanup_finished_session_locked(&mut guard);

    let controller = guard
        .as_ref()
        .ok_or_else(|| "STT session is not running".to_string())?;

    let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
    controller
        .tx
        .send(ControlMessage::PreloadModel {
            model_path,
            reply_tx,
        })
        .map_err(|_| "Failed to request STT model preload".to_string())?;

    match reply_rx.recv_timeout(MODEL_PRELOAD_MANAGER_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Timed out while preloading STT model".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("STT model preload channel disconnected".to_string())
        }
    }
}

pub fn is_global_session_running() -> bool {
    let mut guard = match controller_slot().lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    cleanup_finished_session_locked(&mut guard);
    guard.is_some()
}

fn controller_slot() -> &'static Mutex<Option<SessionController>> {
    static CONTROLLER: OnceLock<Mutex<Option<SessionController>>> = OnceLock::new();
    CONTROLLER.get_or_init(|| Mutex::new(None))
}

enum ControlMessage {
    Stop,
    SwitchModel {
        model_path: PathBuf,
        reply_tx: Sender<Result<(), String>>,
    },
    PreloadModel {
        model_path: PathBuf,
        reply_tx: Sender<Result<(), String>>,
    },
}

struct SessionController {
    tx: Sender<ControlMessage>,
    handle: JoinHandle<()>,
}

fn cleanup_finished_session_locked(guard: &mut Option<SessionController>) {
    if guard
        .as_ref()
        .is_some_and(|controller| controller.handle.is_finished())
    {
        if let Some(controller) = guard.take() {
            let _ = controller.handle.join();
        }
    }
}

struct SttSession {
    running: std::sync::Arc<AtomicBool>,
    streams: Vec<Stream>,
    workers: Vec<JoinHandle<()>>,
    worker_controls: Vec<Sender<WorkerControlMessage>>,
    #[cfg(target_os = "macos")]
    system_audio_process: Option<Arc<Mutex<Option<Child>>>>,
}

impl SttSession {
    fn start(app: AppHandle, config: SttRuntimeConfig) -> Result<Self, String> {
        let running = std::sync::Arc::new(AtomicBool::new(true));
        let runtime_library_path = config.runtime_library_path.clone();
        let model_path = config.model_path.clone();
        let microphone_device_id = config.microphone_device_id.clone();
        #[cfg(target_os = "windows")]
        let system_audio_device_id = config.system_audio_device_id.clone();

        let mut streams = Vec::new();
        let mut workers = Vec::new();
        let mut worker_controls = Vec::new();
        let mut started_sources = 0usize;
        let mut source_warnings: Vec<String> = Vec::new();

        match audio::resolve_input_device(microphone_device_id.as_deref()) {
            Ok(mic_device) => {
                let mic_start = (|| -> Result<(Stream, Sender<WorkerControlMessage>, JoinHandle<()>), String> {
                    let mic_supported = mic_device
                        .default_input_config()
                        .map_err(|e| format!("Failed to get microphone config: {}", e))?;
                    let mic_sample_rate = mic_supported.sample_rate();
                    let (mic_audio_tx, mic_control_tx, mic_worker) = spawn_recognition_worker(
                        app.clone(),
                        running.clone(),
                        runtime_library_path.clone(),
                        model_path.clone(),
                        mic_sample_rate,
                        "mic",
                    )?;
                    let mic_stream = build_capture_stream(
                        &mic_device,
                        mic_supported,
                        mic_audio_tx,
                        "microphone",
                    )?;
                    mic_stream
                        .play()
                        .map_err(|e| format!("Failed to start microphone stream: {}", e))?;
                    Ok((mic_stream, mic_control_tx, mic_worker))
                })();

                match mic_start {
                    Ok((mic_stream, mic_control_tx, mic_worker)) => {
                        worker_controls.push(mic_control_tx);
                        streams.push(mic_stream);
                        workers.push(mic_worker);
                        started_sources += 1;
                    }
                    Err(err) => {
                        source_warnings.push(format!("Microphone is not available: {}", err));
                    }
                }
            }
            Err(err) => {
                source_warnings.push(err);
            }
        }

        #[cfg(target_os = "windows")]
        {
            const WINDOWS_SYSTEM_AUDIO_TARGET_SAMPLE_RATE: u32 = 16000;
            let system_audio_status =
                system_audio::get_system_audio_status(system_audio_device_id.as_deref());
            if system_audio_status.available {
                let system_start = (|| -> Result<
                    (
                        Sender<WorkerControlMessage>,
                        JoinHandle<()>,
                        JoinHandle<()>,
                    ),
                    String,
                > {
                    let (system_audio_tx, system_control_tx, system_worker) =
                        spawn_recognition_worker(
                            app.clone(),
                            running.clone(),
                            runtime_library_path.clone(),
                            model_path.clone(),
                            WINDOWS_SYSTEM_AUDIO_TARGET_SAMPLE_RATE,
                            "system",
                        )?;
                    let system_capture_worker = spawn_windows_system_loopback_capture(
                        running.clone(),
                        system_audio_tx,
                        WINDOWS_SYSTEM_AUDIO_TARGET_SAMPLE_RATE,
                        system_audio_device_id.clone(),
                    )?;
                    Ok((system_control_tx, system_worker, system_capture_worker))
                })();

                match system_start {
                    Ok((system_control_tx, system_worker, system_capture_worker)) => {
                        worker_controls.push(system_control_tx);
                        workers.push(system_worker);
                        workers.push(system_capture_worker);
                        started_sources += 1;
                    }
                    Err(err) => {
                        source_warnings
                            .push(format!("System audio loopback failed to start: {}", err));
                    }
                }
            } else {
                source_warnings.push(format!(
                    "System audio loopback is not available: {}",
                    system_audio_status.detail
                ));
            }
        }

        #[cfg(target_os = "macos")]
        let system_audio_process = {
            const MACOS_SYSTEM_AUDIO_SAMPLE_RATE: u32 = 16000;

            match spawn_recognition_worker(
                app,
                running.clone(),
                runtime_library_path.clone(),
                model_path.clone(),
                MACOS_SYSTEM_AUDIO_SAMPLE_RATE,
                "system",
            ) {
                Ok((system_audio_tx, system_control_tx, system_worker)) => {
                    worker_controls.push(system_control_tx);
                    match spawn_macos_system_audio_capture(
                        running.clone(),
                        system_audio_tx,
                        MACOS_SYSTEM_AUDIO_SAMPLE_RATE,
                    ) {
                        Ok((process_slot, system_capture_worker)) => {
                            workers.push(system_worker);
                            workers.push(system_capture_worker);
                            started_sources += 1;
                            Some(process_slot)
                        }
                        Err(err) => {
                            source_warnings
                                .push(format!("System audio capture is not available: {}", err));
                            None
                        }
                    }
                }
                Err(err) => {
                    source_warnings.push(format!(
                        "System audio recognition worker did not start: {}",
                        err
                    ));
                    None
                }
            }
        };

        if started_sources == 0 {
            let detail = if source_warnings.is_empty() {
                "No audio capture source is available.".to_string()
            } else {
                source_warnings.join(" ")
            };
            return Err(format!("STT could not start. {}", detail));
        }

        if !source_warnings.is_empty() {
            log::warn!(
                "STT started with limited audio capture: {}",
                source_warnings.join(" | ")
            );
            for warning in source_warnings {
                emit_stt_diagnostic(&app, "source_warning", "warn", warning, None);
            }
        }

        Ok(Self {
            running,
            streams,
            workers,
            worker_controls,
            #[cfg(target_os = "macos")]
            system_audio_process,
        })
    }

    fn switch_model(&self, model_path: &Path) -> Result<(), String> {
        let mut waiters: Vec<Receiver<Result<(), String>>> = Vec::new();

        for tx in &self.worker_controls {
            let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
            tx.send(WorkerControlMessage::SwitchModel {
                model_path: model_path.to_path_buf(),
                reply_tx,
            })
            .map_err(|_| "Failed to send model switch request to STT worker".to_string())?;
            waiters.push(reply_rx);
        }

        for rx in waiters {
            match rx.recv_timeout(MODEL_SWITCH_WORKER_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(err)) => return Err(err),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err("Timed out waiting for STT worker model switch".to_string())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("STT worker model switch reply channel disconnected".to_string())
                }
            }
        }

        Ok(())
    }

    fn preload_model(&self, model_path: &Path) -> Result<(), String> {
        let mut waiters: Vec<Receiver<Result<(), String>>> = Vec::new();

        for tx in &self.worker_controls {
            let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
            tx.send(WorkerControlMessage::PreloadModel {
                model_path: model_path.to_path_buf(),
                reply_tx,
            })
            .map_err(|_| "Failed to send model preload request to STT worker".to_string())?;
            waiters.push(reply_rx);
        }

        for rx in waiters {
            match rx.recv_timeout(MODEL_PRELOAD_WORKER_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(err)) => return Err(err),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err("Timed out waiting for STT worker model preload".to_string())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("STT worker model preload reply channel disconnected".to_string())
                }
            }
        }

        Ok(())
    }

    fn stop(&mut self) {
        self.running.store(false, Ordering::Relaxed);

        #[cfg(target_os = "macos")]
        if let Some(process_slot) = &self.system_audio_process {
            if let Ok(mut guard) = process_slot.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
        }

        let streams = std::mem::take(&mut self.streams);
        drop(streams);

        let workers = std::mem::take(&mut self.workers);
        for worker in workers {
            let _ = worker.join();
        }
    }
}

fn build_capture_stream(
    device: &cpal::Device,
    supported_config: SupportedStreamConfig,
    tx: SyncSender<Vec<i16>>,
    label: &str,
) -> Result<Stream, String> {
    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.config();
    let channels = config.channels as usize;

    match sample_format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            let error_label = label.to_string();
            device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _| {
                        let samples = downmix_f32_to_i16(data, channels);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        log::warn!("{} capture stream error: {}", error_label, err);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build {} stream: {}", label, e))
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            let error_label = label.to_string();
            device
                .build_input_stream(
                    &config,
                    move |data: &[i16], _| {
                        let samples = downmix_i16(data, channels);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        log::warn!("{} capture stream error: {}", error_label, err);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build {} stream: {}", label, e))
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let error_label = label.to_string();
            device
                .build_input_stream(
                    &config,
                    move |data: &[u16], _| {
                        let samples = downmix_u16_to_i16(data, channels);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        log::warn!("{} capture stream error: {}", error_label, err);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build {} stream: {}", label, e))
        }
        _ => Err(format!(
            "Unsupported sample format for {}: {:?}",
            label, sample_format
        )),
    }
}

fn enqueue_audio_chunk(tx: &SyncSender<Vec<i16>>, samples: Vec<i16>) {
    if samples.is_empty() {
        return;
    }

    match tx.try_send(samples) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            // Drop stale chunks to keep recognition near real-time.
        }
        Err(TrySendError::Disconnected(_)) => {
            // Worker is already stopping.
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_windows_system_loopback_capture(
    running: std::sync::Arc<AtomicBool>,
    tx: SyncSender<Vec<i16>>,
    target_sample_rate: u32,
    selected_output_device_id: Option<String>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("stt-system-loopback-capture".to_string())
        .spawn(move || {
            run_windows_system_loopback_capture(
                running,
                tx,
                target_sample_rate,
                selected_output_device_id,
            );
        })
        .map_err(|e| format!("Failed to spawn Windows loopback capture worker: {}", e))
}

#[cfg(target_os = "windows")]
fn run_windows_system_loopback_capture(
    running: std::sync::Arc<AtomicBool>,
    tx: SyncSender<Vec<i16>>,
    target_sample_rate: u32,
    selected_output_device_id: Option<String>,
) {
    let mut backoff = Duration::from_millis(250);

    while running.load(Ordering::Relaxed) {
        let result = run_windows_system_loopback_stream_once(
            &running,
            &tx,
            target_sample_rate,
            selected_output_device_id.as_deref(),
        );
        if !running.load(Ordering::Relaxed) {
            break;
        }

        if let Err(err) = result {
            log::warn!("Windows system loopback stream restart: {}", err);
            thread::sleep(backoff);
            let doubled = backoff + backoff;
            backoff = if doubled > Duration::from_secs(3) {
                Duration::from_secs(3)
            } else {
                doubled
            };
        } else {
            backoff = Duration::from_millis(250);
        }
    }
}

#[cfg(target_os = "windows")]
fn run_windows_system_loopback_stream_once(
    running: &std::sync::Arc<AtomicBool>,
    tx: &SyncSender<Vec<i16>>,
    target_sample_rate: u32,
    selected_output_device_id: Option<&str>,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = audio::resolve_output_device(selected_output_device_id)?;
    let device_name = audio::resolve_device_name(&device);
    let device_id = audio::resolve_device_id(&device);

    let supported = device
        .default_output_config()
        .map_err(|e| format!("Failed to get output config for loopback: {}", e))?;
    let stream_config: StreamConfig = supported.config();
    let sample_format = supported.sample_format();
    let source_sample_rate = supported.sample_rate();
    let channels = stream_config.channels as usize;

    let (error_tx, error_rx) = mpsc::channel::<String>();
    let stream = build_windows_loopback_stream(
        &device,
        &stream_config,
        sample_format,
        channels,
        source_sample_rate,
        target_sample_rate,
        tx.clone(),
        error_tx,
        &device_name,
    )?;

    stream
        .play()
        .map_err(|e| format!("Failed to start loopback stream '{}': {}", device_name, e))?;

    let mut device_poll_ticks = 0_u8;
    while running.load(Ordering::Relaxed) {
        match error_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(stream_error) => return Err(stream_error),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Loopback stream error channel disconnected".to_string());
            }
        }

        device_poll_ticks = device_poll_ticks.saturating_add(1);
        if device_poll_ticks >= 8 {
            device_poll_ticks = 0;
            if let Some(selected_device_id) = selected_output_device_id {
                if !audio::has_output_device(Some(selected_device_id)) {
                    return Err(format!(
                        "Selected output device is no longer available: {}",
                        selected_device_id
                    ));
                }
            } else {
                let current_device_id = host
                    .default_output_device()
                    .map(|device| audio::resolve_device_id(&device));
                if current_device_id.as_deref() != Some(device_id.as_str()) {
                    return Err(format!(
                        "Default output device changed from '{}' to '{}'",
                        device_name,
                        current_device_id.unwrap_or_else(|| "none".to_string())
                    ));
                }
            }
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn build_windows_loopback_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: usize,
    source_sample_rate: u32,
    target_sample_rate: u32,
    tx: SyncSender<Vec<i16>>,
    error_tx: Sender<String>,
    device_name: &str,
) -> Result<Stream, String> {
    match sample_format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            let error_tx = error_tx.clone();
            let label = device_name.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32_to_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        let message = format!("Loopback stream '{}' error: {}", label, err);
                        log::warn!("{}", message);
                        let _ = error_tx.send(message);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build f32 loopback stream: {}", e))
        }
        SampleFormat::I16 => {
            let tx = tx.clone();
            let error_tx = error_tx.clone();
            let label = device_name.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[i16], _| {
                        let mono = downmix_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        let message = format!("Loopback stream '{}' error: {}", label, err);
                        log::warn!("{}", message);
                        let _ = error_tx.send(message);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build i16 loopback stream: {}", e))
        }
        SampleFormat::U16 => {
            let tx = tx.clone();
            let error_tx = error_tx.clone();
            let label = device_name.to_string();
            device
                .build_input_stream(
                    config,
                    move |data: &[u16], _| {
                        let mono = downmix_u16_to_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
                        enqueue_audio_chunk(&tx, samples);
                    },
                    move |err| {
                        let message = format!("Loopback stream '{}' error: {}", label, err);
                        log::warn!("{}", message);
                        let _ = error_tx.send(message);
                    },
                    None,
                )
                .map_err(|e| format!("Failed to build u16 loopback stream: {}", e))
        }
        _ => Err(format!(
            "Unsupported sample format for Windows loopback: {:?}",
            sample_format
        )),
    }
}

fn spawn_recognition_worker(
    app: AppHandle,
    running: std::sync::Arc<AtomicBool>,
    runtime_library_path: PathBuf,
    model_path: PathBuf,
    sample_rate: u32,
    source: &'static str,
) -> Result<
    (
        SyncSender<Vec<i16>>,
        Sender<WorkerControlMessage>,
        JoinHandle<()>,
    ),
    String,
> {
    let (audio_tx, audio_rx) = mpsc::sync_channel::<Vec<i16>>(AUDIO_QUEUE_CAPACITY);
    let (control_tx, control_rx) = mpsc::channel::<WorkerControlMessage>();
    let source_name = source.to_string();

    let handle = thread::Builder::new()
        .name(format!("stt-worker-{}", source))
        .spawn(move || {
            if let Err(err) = run_worker(
                app.clone(),
                running,
                audio_rx,
                control_rx,
                &runtime_library_path,
                &model_path,
                sample_rate,
                &source_name,
            ) {
                log::error!("STT worker '{}' failed: {}", source_name, err);
                emit_stt_diagnostic(
                    &app,
                    "worker_error",
                    "error",
                    format!(
                        "Распознавание для источника '{}' остановилось: {}",
                        source_name, err
                    ),
                    Some(source_name.clone()),
                );
            }
        })
        .map_err(|e| format!("Failed to spawn STT worker '{}': {}", source, e))?;

    Ok((audio_tx, control_tx, handle))
}

#[cfg(target_os = "macos")]
fn spawn_macos_system_audio_capture(
    running: std::sync::Arc<AtomicBool>,
    tx: SyncSender<Vec<i16>>,
    sample_rate: u32,
) -> Result<(Arc<Mutex<Option<Child>>>, JoinHandle<()>), String> {
    let process_slot = Arc::new(Mutex::new(None::<Child>));
    let process_slot_for_thread = process_slot.clone();

    let handle = thread::Builder::new()
        .name("stt-system-audio-capture".to_string())
        .spawn(move || {
            if let Err(err) =
                run_macos_system_audio_capture(running, tx, sample_rate, &process_slot_for_thread)
            {
                log::error!("macOS system audio capture failed: {}", err);
            }
        })
        .map_err(|e| format!("Failed to spawn macOS system audio capture worker: {}", e))?;

    Ok((process_slot, handle))
}

#[cfg(target_os = "macos")]
fn run_macos_system_audio_capture(
    running: std::sync::Arc<AtomicBool>,
    tx: SyncSender<Vec<i16>>,
    sample_rate: u32,
    process_slot: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    let mut child = Command::new("swift")
        .arg("-")
        .arg(sample_rate.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch Swift ScreenCaptureKit helper: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(MACOS_SYSTEM_AUDIO_SWIFT_SCRIPT.as_bytes())
            .map_err(|e| format!("Failed to write ScreenCaptureKit helper script: {}", e))?;
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Swift ScreenCaptureKit helper did not expose stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Swift ScreenCaptureKit helper did not expose stderr".to_string())?;

    {
        let mut guard = process_slot
            .lock()
            .map_err(|_| "Failed to lock macOS system audio process slot".to_string())?;
        *guard = Some(child);
    }

    let mut pending = Vec::<u8>::new();
    let mut read_buf = [0_u8; 4096];

    while running.load(Ordering::Relaxed) {
        let read = match stdout.read(&mut read_buf) {
            Ok(n) => n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => {
                return Err(format!(
                    "Failed to read ScreenCaptureKit audio stream: {}",
                    err
                ))
            }
        };

        if read == 0 {
            break;
        }

        pending.extend_from_slice(&read_buf[..read]);
        let complete_bytes = pending.len() - (pending.len() % 2);
        if complete_bytes == 0 {
            continue;
        }

        let samples = pending[..complete_bytes]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        pending.drain(..complete_bytes);

        enqueue_audio_chunk(&tx, samples);
    }

    let mut stderr_text = String::new();
    let _ = stderr.read_to_string(&mut stderr_text);

    if let Ok(mut guard) = process_slot.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
        }
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
    }

    if !stderr_text.trim().is_empty() {
        log::debug!(
            "macOS ScreenCaptureKit helper stderr: {}",
            stderr_text.trim()
        );
    }

    Ok(())
}

fn run_worker(
    app: AppHandle,
    running: std::sync::Arc<AtomicBool>,
    audio_rx: Receiver<Vec<i16>>,
    control_rx: Receiver<WorkerControlMessage>,
    runtime_library_path: &Path,
    model_path: &Path,
    sample_rate: u32,
    source: &str,
) -> Result<(), String> {
    let api = VoskApi::load(runtime_library_path)?;
    let mut active_slot = load_recognition_slot(&api, sample_rate, model_path.to_path_buf())?;
    let mut standby_slot: Option<LoadedRecognitionSlot> = None;

    emit_stt_diagnostic(
        &app,
        "worker_ready",
        "info",
        format!("Источник '{}' готов к распознаванию речи.", source),
        Some(source.to_string()),
    );

    let mut last_partial = String::new();
    let mut saw_audio = false;

    while running.load(Ordering::Relaxed) {
        while let Ok(control) = control_rx.try_recv() {
            handle_worker_control(
                &api,
                sample_rate,
                &mut active_slot,
                &mut standby_slot,
                &mut last_partial,
                control,
            );
        }

        let chunk = match audio_rx.recv_timeout(Duration::from_millis(40)) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if chunk.is_empty() {
            continue;
        }

        if !saw_audio {
            saw_audio = true;
            emit_stt_diagnostic(
                &app,
                "audio_detected",
                "info",
                format!("Обнаружен аудиосигнал из источника '{}'.", source),
                Some(source.to_string()),
            );
        }

        let accepted = api.accept_waveform(active_slot.recognizer, &chunk)?;
        if accepted {
            let (text, confidence) = api.result_text_and_confidence(active_slot.recognizer)?;
            if !text.is_empty() {
                emit_stt_result(&app, source, text, true, confidence);
            }
            last_partial.clear();
        } else {
            let partial = api.partial_text(active_slot.recognizer)?;
            if !partial.is_empty() && partial != last_partial {
                emit_stt_result(&app, source, partial.clone(), false, 0.0);
                last_partial = partial;
            }
        }
    }

    let (final_text, confidence) = api.final_text_and_confidence(active_slot.recognizer)?;
    if !final_text.is_empty() {
        emit_stt_result(&app, source, final_text, true, confidence);
    }

    free_recognition_slot(&api, &mut active_slot);
    if let Some(mut standby) = standby_slot.take() {
        free_recognition_slot(&api, &mut standby);
    }

    Ok(())
}

enum WorkerControlMessage {
    SwitchModel {
        model_path: PathBuf,
        reply_tx: Sender<Result<(), String>>,
    },
    PreloadModel {
        model_path: PathBuf,
        reply_tx: Sender<Result<(), String>>,
    },
}

struct LoadedRecognitionSlot {
    model_path: PathBuf,
    model: ModelPtr,
    recognizer: RecognizerPtr,
}

fn load_recognition_slot(
    api: &VoskApi,
    sample_rate: u32,
    model_path: PathBuf,
) -> Result<LoadedRecognitionSlot, String> {
    let model = api.create_model(&model_path)?;
    let recognizer = api.create_recognizer(model, sample_rate as c_float)?;
    Ok(LoadedRecognitionSlot {
        model_path,
        model,
        recognizer,
    })
}

fn free_recognition_slot(api: &VoskApi, slot: &mut LoadedRecognitionSlot) {
    api.free_recognizer(slot.recognizer);
    api.free_model(slot.model);
    slot.recognizer = std::ptr::null_mut();
    slot.model = std::ptr::null_mut();
}

fn handle_worker_control(
    api: &VoskApi,
    sample_rate: u32,
    active_slot: &mut LoadedRecognitionSlot,
    standby_slot: &mut Option<LoadedRecognitionSlot>,
    last_partial: &mut String,
    control: WorkerControlMessage,
) {
    match control {
        WorkerControlMessage::SwitchModel {
            model_path,
            reply_tx,
        } => {
            if model_path == active_slot.model_path {
                let _ = reply_tx.send(Ok(()));
                return;
            }

            if standby_slot
                .as_ref()
                .is_some_and(|slot| slot.model_path == model_path)
            {
                if let Some(next_active) = standby_slot.take() {
                    let previous_active = std::mem::replace(active_slot, next_active);
                    if let Some(mut old_standby) = standby_slot.replace(previous_active) {
                        free_recognition_slot(api, &mut old_standby);
                    }
                    last_partial.clear();
                    let _ = reply_tx.send(Ok(()));
                    return;
                }
            }

            let result = (|| -> Result<(), String> {
                let next_active = load_recognition_slot(api, sample_rate, model_path)?;
                let previous_active = std::mem::replace(active_slot, next_active);
                if let Some(mut old_standby) = standby_slot.replace(previous_active) {
                    free_recognition_slot(api, &mut old_standby);
                }
                last_partial.clear();
                Ok(())
            })();

            let _ = reply_tx.send(result);
        }
        WorkerControlMessage::PreloadModel {
            model_path,
            reply_tx,
        } => {
            if model_path == active_slot.model_path
                || standby_slot
                    .as_ref()
                    .is_some_and(|slot| slot.model_path == model_path)
            {
                let _ = reply_tx.send(Ok(()));
                return;
            }

            let result = (|| -> Result<(), String> {
                let next_standby = load_recognition_slot(api, sample_rate, model_path)?;
                if let Some(mut existing_standby) = standby_slot.replace(next_standby) {
                    free_recognition_slot(api, &mut existing_standby);
                }
                Ok(())
            })();

            let _ = reply_tx.send(result);
        }
    }
}

fn emit_stt_result(app: &AppHandle, source: &str, text: String, is_final: bool, confidence: f32) {
    let normalized_text = normalize_transcript_text(&text, is_final);
    if normalized_text.is_empty() {
        return;
    }

    let payload = SttResult {
        text: normalized_text,
        is_final,
        confidence,
        source: source.to_string(),
    };
    let _ = app.emit("stt_result", payload);
}

fn emit_stt_diagnostic(
    app: &AppHandle,
    code: &str,
    level: &str,
    message: String,
    source: Option<String>,
) {
    let payload = SttDiagnostic {
        code: code.to_string(),
        level: level.to_string(),
        message,
        source,
    };
    let _ = app.emit("stt_diagnostic", payload);
}

fn normalize_transcript_text(text: &str, is_final: bool) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut normalized = trimmed.to_string();

    if let Some(first) = normalized.chars().next() {
        let first_len = first.len_utf8();
        let upper_first = first.to_uppercase().to_string();
        normalized.replace_range(0..first_len, &upper_first);
    }

    if is_final && !normalized.ends_with(['.', '!', '?']) {
        let lower = normalized.to_lowercase();
        let question_starts = [
            "who",
            "what",
            "where",
            "when",
            "why",
            "how",
            "which",
            "is",
            "are",
            "can",
            "could",
            "would",
            "should",
            "do",
            "does",
            "did",
            "will",
            "whom",
            "whose",
            "какой",
            "какая",
            "какие",
            "какое",
            "кто",
            "что",
            "где",
            "когда",
            "почему",
            "зачем",
            "как",
            "ли",
            "сколько",
        ];
        let is_question = question_starts
            .iter()
            .any(|prefix| lower.starts_with(prefix));
        normalized.push(if is_question { '?' } else { '.' });
    }

    normalized
}

fn downmix_f32_to_i16(data: &[f32], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            let sum = frame.iter().copied().sum::<f32>();
            let mono = (sum / channels as f32).clamp(-1.0, 1.0);
            (mono * i16::MAX as f32) as i16
        })
        .collect()
}

fn downmix_i16(data: &[i16], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            let sum = frame.iter().map(|v| *v as i32).sum::<i32>();
            (sum / channels as i32) as i16
        })
        .collect()
}

fn downmix_u16_to_i16(data: &[u16], channels: usize) -> Vec<i16> {
    if channels == 0 {
        return Vec::new();
    }
    data.chunks(channels)
        .map(|frame| {
            let sum = frame.iter().map(|v| (*v as i32) - 32768).sum::<i32>();
            (sum / channels as i32) as i16
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn resample_mono_i16(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
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
        let interpolated = left + (right - left) * frac;
        output.push(interpolated.round() as i16);
    }

    output
}

#[cfg(target_os = "macos")]
const MACOS_SYSTEM_AUDIO_SWIFT_SCRIPT: &str = r#"
import Foundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox

let requestedSampleRate: Int = {
  guard CommandLine.arguments.count >= 2 else { return 16000 }
  return Int(CommandLine.arguments[1]) ?? 16000
}()

final class AudioTap: NSObject, SCStreamOutput, SCStreamDelegate {
  private let out = FileHandle.standardOutput

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fputs("SCStream stopped with error: \(error)\n", stderr)
    exit(2)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard outputType == .audio else { return }
    guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

    var blockBuffer: CMBlockBuffer?
    var audioBufferList = AudioBufferList(
      mNumberBuffers: 1,
      mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
    )
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: &audioBufferList,
      bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: nil,
      blockBufferMemoryAllocator: nil,
      flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
      blockBufferOut: &blockBuffer
    )
    guard status == noErr else { return }
    guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
    guard let raw = audioBufferList.mBuffers.mData else { return }

    let channels = max(Int(asbd.pointee.mChannelsPerFrame), 1)
    let byteCount = Int(audioBufferList.mBuffers.mDataByteSize)
    if byteCount == 0 { return }

    let totalSamples = byteCount / MemoryLayout<Float>.size
    let frameCount = totalSamples / channels
    if frameCount == 0 { return }

    let floats = raw.bindMemory(to: Float.self, capacity: totalSamples)
    var pcm = Data(capacity: frameCount * MemoryLayout<Int16>.size)

    for frame in 0..<frameCount {
      var mono: Float = 0
      for channel in 0..<channels {
        mono += floats[(frame * channels) + channel]
      }
      mono /= Float(channels)
      let clamped = max(-1.0, min(1.0, mono))
      var s = Int16(clamped * Float(Int16.max))
      withUnsafeBytes(of: &s) { pcm.append(contentsOf: $0) }
    }

    out.write(pcm)
  }
}

@MainActor
func startCapture() async throws {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first else {
    throw NSError(
      domain: "SystemAudioCapture",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "No display available for ScreenCaptureKit capture."]
    )
  }

  let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
  let config = SCStreamConfiguration()
  config.capturesAudio = true
  config.excludesCurrentProcessAudio = true
  config.sampleRate = requestedSampleRate
  config.channelCount = 1
  config.queueDepth = 8
  config.minimumFrameInterval = CMTime(value: 1, timescale: 60)

  let tap = AudioTap()
  let stream = SCStream(filter: filter, configuration: config, delegate: tap)
  try stream.addStreamOutput(
    tap,
    type: .audio,
    sampleHandlerQueue: DispatchQueue(label: "ai-interview.system-audio")
  )
  try await stream.startCapture()
  RunLoop.main.run()
}

Task {
  do {
    try await startCapture()
  } catch {
    fputs("ScreenCaptureKit audio capture failed: \(error)\n", stderr)
    exit(3)
  }
}

dispatchMain()
"#;

type ModelPtr = *mut c_void;
type RecognizerPtr = *mut c_void;

type FnModelNew = unsafe extern "C" fn(*const c_char) -> ModelPtr;
type FnModelFree = unsafe extern "C" fn(ModelPtr);
type FnRecognizerNew = unsafe extern "C" fn(ModelPtr, c_float) -> RecognizerPtr;
type FnRecognizerFree = unsafe extern "C" fn(RecognizerPtr);
type FnAcceptWaveformS = unsafe extern "C" fn(RecognizerPtr, *const c_short, c_int) -> c_int;
type FnResult = unsafe extern "C" fn(RecognizerPtr) -> *const c_char;
type FnPartialResult = unsafe extern "C" fn(RecognizerPtr) -> *const c_char;
type FnFinalResult = unsafe extern "C" fn(RecognizerPtr) -> *const c_char;

struct VoskApi {
    _lib: Library,
    model_new: FnModelNew,
    model_free: FnModelFree,
    recognizer_new: FnRecognizerNew,
    recognizer_free: FnRecognizerFree,
    accept_waveform_s: FnAcceptWaveformS,
    result: FnResult,
    partial_result: FnPartialResult,
    final_result: FnFinalResult,
}

impl VoskApi {
    fn load(runtime_library_path: &Path) -> Result<Self, String> {
        // Safety: function pointers are loaded once from trusted runtime library.
        unsafe {
            crate::vosk_runtime::ensure_runtime_dir_on_path(runtime_library_path);
            let lib = Library::new(runtime_library_path).map_err(|e| {
                format!(
                    "Failed to load Vosk runtime '{}': {}",
                    runtime_library_path.display(),
                    e
                )
            })?;

            let model_new = *lib
                .get::<FnModelNew>(b"vosk_model_new\0")
                .map_err(|e| format!("Missing symbol vosk_model_new: {}", e))?;
            let model_free = *lib
                .get::<FnModelFree>(b"vosk_model_free\0")
                .map_err(|e| format!("Missing symbol vosk_model_free: {}", e))?;
            let recognizer_new = *lib
                .get::<FnRecognizerNew>(b"vosk_recognizer_new\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_new: {}", e))?;
            let recognizer_free = *lib
                .get::<FnRecognizerFree>(b"vosk_recognizer_free\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_free: {}", e))?;
            let accept_waveform_s = *lib
                .get::<FnAcceptWaveformS>(b"vosk_recognizer_accept_waveform_s\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_accept_waveform_s: {}", e))?;
            let result = *lib
                .get::<FnResult>(b"vosk_recognizer_result\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_result: {}", e))?;
            let partial_result = *lib
                .get::<FnPartialResult>(b"vosk_recognizer_partial_result\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_partial_result: {}", e))?;
            let final_result = *lib
                .get::<FnFinalResult>(b"vosk_recognizer_final_result\0")
                .map_err(|e| format!("Missing symbol vosk_recognizer_final_result: {}", e))?;

            Ok(Self {
                _lib: lib,
                model_new,
                model_free,
                recognizer_new,
                recognizer_free,
                accept_waveform_s,
                result,
                partial_result,
                final_result,
            })
        }
    }

    fn create_model(&self, model_path: &Path) -> Result<ModelPtr, String> {
        let path = model_path
            .to_str()
            .ok_or_else(|| "Model path contains invalid UTF-8".to_string())?;
        let c_path = CString::new(path).map_err(|e| format!("Invalid model path: {}", e))?;
        let model = unsafe { (self.model_new)(c_path.as_ptr()) };
        if model.is_null() {
            return Err(format!(
                "Vosk failed to load model from '{}'",
                model_path.display()
            ));
        }
        Ok(model)
    }

    fn free_model(&self, model: ModelPtr) {
        if !model.is_null() {
            unsafe { (self.model_free)(model) };
        }
    }

    fn create_recognizer(
        &self,
        model: ModelPtr,
        sample_rate: c_float,
    ) -> Result<RecognizerPtr, String> {
        let recognizer = unsafe { (self.recognizer_new)(model, sample_rate) };
        if recognizer.is_null() {
            return Err("Vosk failed to create recognizer".to_string());
        }
        Ok(recognizer)
    }

    fn free_recognizer(&self, recognizer: RecognizerPtr) {
        if !recognizer.is_null() {
            unsafe { (self.recognizer_free)(recognizer) };
        }
    }

    fn accept_waveform(&self, recognizer: RecognizerPtr, chunk: &[i16]) -> Result<bool, String> {
        let rc =
            unsafe { (self.accept_waveform_s)(recognizer, chunk.as_ptr(), chunk.len() as c_int) };
        if rc < 0 {
            return Err("Vosk recognizer returned an error on accept_waveform".to_string());
        }
        Ok(rc == 1)
    }

    fn partial_text(&self, recognizer: RecognizerPtr) -> Result<String, String> {
        let json = unsafe { cstr_to_string((self.partial_result)(recognizer))? };
        extract_partial_text(&json)
    }

    fn result_text_and_confidence(
        &self,
        recognizer: RecognizerPtr,
    ) -> Result<(String, f32), String> {
        let json = unsafe { cstr_to_string((self.result)(recognizer))? };
        extract_final_text_and_confidence(&json)
    }

    fn final_text_and_confidence(
        &self,
        recognizer: RecognizerPtr,
    ) -> Result<(String, f32), String> {
        let json = unsafe { cstr_to_string((self.final_result)(recognizer))? };
        extract_final_text_and_confidence(&json)
    }
}

unsafe fn cstr_to_string(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(|s| s.to_string())
        .map_err(|e| format!("Invalid UTF-8 from Vosk: {}", e))
}

fn extract_partial_text(json: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid partial JSON from Vosk: {}", e))?;
    Ok(value
        .get("partial")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn extract_final_text_and_confidence(json: &str) -> Result<(String, f32), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Invalid final JSON from Vosk: {}", e))?;

    let text = value
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let confidence = value
        .get("result")
        .and_then(|v| v.as_array())
        .map(|words| {
            let mut total = 0.0_f32;
            let mut count = 0_u32;
            for word in words {
                if let Some(conf) = word.get("conf").and_then(|v| v.as_f64()) {
                    total += conf as f32;
                    count += 1;
                }
            }
            if count > 0 {
                total / count as f32
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);

    Ok((text, confidence))
}
