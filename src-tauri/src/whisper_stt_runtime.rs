use crate::audio;
use crate::stt::{SttDiagnostic, SttResult};
#[cfg(target_os = "windows")]
use crate::system_audio;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use whisper_rs::{
    convert_integer_to_float_audio, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters, WhisperState,
};

const AUDIO_QUEUE_CAPACITY: usize = 32;
const MICROPHONE_TARGET_SAMPLE_RATE: u32 = 16000;
const MODEL_SWITCH_MANAGER_TIMEOUT: Duration = Duration::from_secs(50);
const MODEL_SWITCH_WORKER_TIMEOUT: Duration = Duration::from_secs(45);
const LANGUAGE_SWITCH_MANAGER_TIMEOUT: Duration = Duration::from_secs(20);
const LANGUAGE_SWITCH_WORKER_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_PRELOAD_MANAGER_TIMEOUT: Duration = Duration::from_secs(75);
const MODEL_PRELOAD_WORKER_TIMEOUT: Duration = Duration::from_secs(70);
const STOP_JOIN_GRACE_PERIOD: Duration = Duration::from_secs(4);
const STOP_COMPLETION_WAIT_TIMEOUT: Duration = Duration::from_secs(45);
const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const HEAVY_MODEL_WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(210);
const SESSION_STARTUP_TIMEOUT: Duration = Duration::from_secs(70);
const HEAVY_MODEL_SESSION_STARTUP_TIMEOUT: Duration = Duration::from_secs(240);
const AUDIO_STALL_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WhisperModelTier {
    Small,
    Medium,
    Large,
}

fn detect_whisper_model_tier(model_path: &Path) -> WhisperModelTier {
    let lower = model_path.to_string_lossy().to_lowercase();
    if lower.contains("large-v3") || lower.contains("large") {
        WhisperModelTier::Large
    } else if lower.contains("medium") {
        WhisperModelTier::Medium
    } else {
        WhisperModelTier::Small
    }
}

fn worker_startup_timeout_for_model(model_path: &Path) -> Duration {
    match detect_whisper_model_tier(model_path) {
        WhisperModelTier::Large | WhisperModelTier::Medium => HEAVY_MODEL_WORKER_STARTUP_TIMEOUT,
        WhisperModelTier::Small => WORKER_STARTUP_TIMEOUT,
    }
}

fn session_startup_timeout_for_model(model_path: &Path) -> Duration {
    match detect_whisper_model_tier(model_path) {
        WhisperModelTier::Large | WhisperModelTier::Medium => HEAVY_MODEL_SESSION_STARTUP_TIMEOUT,
        WhisperModelTier::Small => SESSION_STARTUP_TIMEOUT,
    }
}

fn normalize_device_selector(device_selector: Option<&str>) -> Option<&str> {
    device_selector.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn resolve_input_device_with_fallback(
    device_selector: Option<&str>,
) -> Result<(cpal::Device, Option<String>), String> {
    audio::resolve_input_device_with_fallback(normalize_device_selector(device_selector))
}

#[cfg(target_os = "windows")]
fn resolve_output_selector_with_fallback(
    device_selector: Option<&str>,
) -> (Option<String>, Option<String>) {
    let normalized = normalize_device_selector(device_selector);
    if normalized.is_none() {
        return (None, None);
    }

    match audio::resolve_output_device_with_fallback(normalized) {
        Ok((device, warning)) => (Some(audio::resolve_device_id(&device)), warning),
        Err(_) => (normalized.map(str::to_string), None),
    }
}

#[derive(Debug, Clone)]
pub struct SttRuntimeConfig {
    pub model_path: PathBuf,
    pub language: String,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

pub fn start_global_session(app: AppHandle, config: SttRuntimeConfig) -> Result<(), String> {
    let session_startup_timeout = session_startup_timeout_for_model(&config.model_path);
    if session_stopping_flag().load(Ordering::Relaxed) {
        log::info!(
            "STT start requested while previous stop is still running; waiting up to {:?}",
            STOP_COMPLETION_WAIT_TIMEOUT
        );
        wait_for_stop_completion(STOP_COMPLETION_WAIT_TIMEOUT)?;
    }

    {
        let mut guard = controller_slot()
            .lock()
            .map_err(|_| "Failed to lock STT controller state".to_string())?;
        cleanup_finished_session_locked(&mut guard);

        if guard.is_some() {
            return Err("STT session is already running".to_string());
        }
    }

    let (control_tx, control_rx) = mpsc::channel::<ControlMessage>();
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
    let model_label = config.model_path.display().to_string();
    log::info!(
        "Starting global STT session (model='{}', mic='{}', system='{}')",
        model_label,
        config
            .microphone_device_id
            .as_deref()
            .unwrap_or("(default)"),
        config
            .system_audio_device_id
            .as_deref()
            .unwrap_or("(default)")
    );
    let handle = thread::Builder::new()
        .name("stt-session-manager".to_string())
        .spawn(move || match SttSession::start(app, config) {
            Ok(mut session) => {
                let _ = startup_tx.send(Ok(()));
                while let Ok(message) = control_rx.recv() {
                    match message {
                        ControlMessage::Stop => {
                            log::info!("STT session manager received stop request");
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
                        ControlMessage::SwitchLanguage { language, reply_tx } => {
                            let _ = reply_tx.send(session.switch_language(&language));
                        }
                    }
                }
                session.stop();
                log::info!("STT session manager finished shutdown");
            }
            Err(err) => {
                log::error!("Failed to start STT session: {}", err);
                let _ = startup_tx.send(Err(err));
            }
        })
        .map_err(|e| format!("Failed to spawn STT manager thread: {}", e))?;

    {
        let mut guard = controller_slot()
            .lock()
            .map_err(|_| "Failed to lock STT controller state".to_string())?;
        cleanup_finished_session_locked(&mut guard);
        if guard.is_some() {
            let _ = control_tx.send(ControlMessage::Stop);
            let _ = handle.join();
            return Err("STT session is already running".to_string());
        }
        *guard = Some(SessionController {
            tx: control_tx.clone(),
            handle,
        });
    }

    match startup_rx.recv_timeout(session_startup_timeout) {
        Ok(Ok(())) => {
            log::info!("Global STT session startup confirmed");
            Ok(())
        }
        Ok(Err(err)) => {
            let _ = stop_global_session();
            Err(err)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = stop_global_session();
            Err(format!(
                "Timed out while waiting for STT manager startup (>{:?})",
                session_startup_timeout
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = stop_global_session();
            Err("STT manager exited before startup confirmation".to_string())
        }
    }
}

pub fn stop_global_session() -> Result<(), String> {
    let mut guard = controller_slot()
        .lock()
        .map_err(|_| "Failed to lock STT controller state".to_string())?;
    cleanup_finished_session_locked(&mut guard);

    let Some(controller) = guard.take() else {
        if session_stopping_flag().load(Ordering::Relaxed) {
            log::info!(
                "STT stop requested while previous stop is still completing; waiting up to {:?}",
                STOP_COMPLETION_WAIT_TIMEOUT
            );
            drop(guard);
            wait_for_stop_completion(STOP_COMPLETION_WAIT_TIMEOUT)?;
            return Ok(());
        }

        log::info!("STT stop requested, but there is no active session");
        return Ok(());
    };

    let SessionController { tx, handle } = controller;
    let manager_thread_name = handle.thread().name().unwrap_or("stt-session-manager");
    log::info!("Stopping global STT session via '{}'", manager_thread_name);
    session_stopping_flag().store(true, Ordering::Relaxed);
    let _ = tx.send(ControlMessage::Stop);

    let deadline = Instant::now() + STOP_JOIN_GRACE_PERIOD;
    let mut handle = Some(handle);
    while let Some(h) = handle.as_ref() {
        if h.is_finished() {
            if let Some(done) = handle.take() {
                let _ = done.join();
            }
            session_stopping_flag().store(false, Ordering::Relaxed);
            log::info!("Global STT session fully stopped");
            return Ok(());
        }

        if Instant::now() >= deadline {
            session_stopping_flag().store(true, Ordering::Relaxed);
            if let Some(detached) = handle.take() {
                thread::spawn(move || {
                    let _ = detached.join();
                    log::info!("Detached STT stop join finished in background");
                    session_stopping_flag().store(false, Ordering::Relaxed);
                });
            }
            log::warn!(
                "STT stop join timed out after {:?}; detaching join to avoid UI hang",
                STOP_JOIN_GRACE_PERIOD
            );
            return Err(
                "STT stop is still in progress. Please retry in a few seconds.".to_string(),
            );
        }

        thread::sleep(Duration::from_millis(25));
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

pub fn switch_global_language(language: String) -> Result<(), String> {
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
        .send(ControlMessage::SwitchLanguage { language, reply_tx })
        .map_err(|_| "Failed to request STT language switch".to_string())?;

    match reply_rx.recv_timeout(LANGUAGE_SWITCH_MANAGER_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("Timed out while switching STT language".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("STT language switch channel disconnected".to_string())
        }
    }
}

pub fn warm_model_cache(model_path: PathBuf) -> Result<(), String> {
    let started_at = Instant::now();
    let cached_model = get_or_load_cached_model(&model_path)?;
    log::info!(
        "Warm STT model cache ready for '{}' in {:?}",
        cached_model.model_path.display(),
        started_at.elapsed()
    );
    Ok(())
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

fn session_stopping_flag() -> &'static AtomicBool {
    static STOPPING: OnceLock<AtomicBool> = OnceLock::new();
    STOPPING.get_or_init(|| AtomicBool::new(false))
}

fn wait_for_stop_completion(timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while session_stopping_flag().load(Ordering::Relaxed) {
        {
            let mut guard = controller_slot()
                .lock()
                .map_err(|_| "Failed to lock STT controller state".to_string())?;
            cleanup_finished_session_locked(&mut guard);
        }

        if !session_stopping_flag().load(Ordering::Relaxed) {
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "Previous STT session is still stopping after {:?}.",
                timeout
            ));
        }

        thread::sleep(Duration::from_millis(50));
    }

    Ok(())
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
    SwitchLanguage {
        language: String,
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
        session_stopping_flag().store(false, Ordering::Relaxed);
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
        let model_path = config.model_path.clone();
        let language = config.language.clone();
        let heavy_model = detect_whisper_model_tier(&model_path) != WhisperModelTier::Small;
        let microphone_device_id = config.microphone_device_id.clone();
        #[cfg(target_os = "windows")]
        let system_audio_device_id = config.system_audio_device_id.clone();

        let mut streams = Vec::new();
        let mut workers = Vec::new();
        let mut worker_controls = Vec::new();
        let mut started_sources = 0usize;
        let mut source_warnings: Vec<String> = Vec::new();

        if heavy_model {
            log::info!(
                "Preloading Whisper model '{}' before starting capture workers",
                model_path.display()
            );
            warm_model_cache(model_path.clone())?;
        }

        match resolve_input_device_with_fallback(microphone_device_id.as_deref()) {
            Ok((mic_device, maybe_mic_warning)) => {
                if let Some(warning) = maybe_mic_warning {
                    source_warnings.push(warning);
                }
                let mic_start = (|| -> Result<(Stream, Sender<WorkerControlMessage>, JoinHandle<()>), String> {
                    let mic_supported = mic_device
                        .default_input_config()
                        .map_err(|e| format!("Failed to get microphone config: {}", e))?;
                    let (mic_audio_tx, mic_control_tx, mic_worker) = spawn_recognition_worker(
                        app.clone(),
                        running.clone(),
                        model_path.clone(),
                        language.clone(),
                        MICROPHONE_TARGET_SAMPLE_RATE,
                        "mic",
                    )?;
                    let mic_stream = build_capture_stream(
                        &mic_device,
                        mic_supported,
                        mic_audio_tx,
                        MICROPHONE_TARGET_SAMPLE_RATE,
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
            let can_start_system_audio = true;
            if heavy_model && started_sources > 0 {
                log::info!(
                    "Starting dual-source STT with a heavy model on Windows; startup time and CPU usage may increase"
                );
            }
            let (resolved_system_audio_selector, maybe_system_selector_warning) =
                resolve_output_selector_with_fallback(system_audio_device_id.as_deref());
            if let Some(warning) = maybe_system_selector_warning {
                source_warnings.push(warning);
            }
            if can_start_system_audio {
                let system_audio_status = system_audio::get_system_audio_status(
                    resolved_system_audio_selector.as_deref(),
                );
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
                                model_path.clone(),
                                language.clone(),
                                WINDOWS_SYSTEM_AUDIO_TARGET_SAMPLE_RATE,
                                "system",
                            )?;
                        let system_capture_worker = spawn_windows_system_loopback_capture(
                            running.clone(),
                            system_audio_tx,
                            WINDOWS_SYSTEM_AUDIO_TARGET_SAMPLE_RATE,
                            resolved_system_audio_selector.clone(),
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
        }

        #[cfg(target_os = "macos")]
        let system_audio_process = {
            const MACOS_SYSTEM_AUDIO_SAMPLE_RATE: u32 = 16000;

            {
                if heavy_model && started_sources > 0 {
                    log::info!(
                    "Starting dual-source STT with a heavy model on macOS; startup time and CPU usage may increase"
                );
                }

                match spawn_recognition_worker(
                    app.clone(),
                    running.clone(),
                    model_path.clone(),
                    language.clone(),
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
                                source_warnings.push(format!(
                                    "System audio capture is not available: {}",
                                    err
                                ));
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

    fn switch_language(&self, language: &str) -> Result<(), String> {
        let mut waiters: Vec<Receiver<Result<(), String>>> = Vec::new();

        for tx in &self.worker_controls {
            let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
            tx.send(WorkerControlMessage::SwitchLanguage {
                language: language.to_string(),
                reply_tx,
            })
            .map_err(|_| "Failed to send language switch request to STT worker".to_string())?;
            waiters.push(reply_rx);
        }

        for rx in waiters {
            match rx.recv_timeout(LANGUAGE_SWITCH_WORKER_TIMEOUT) {
                Ok(Ok(())) => {}
                Ok(Err(err)) => return Err(err),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err("Timed out waiting for STT worker language switch".to_string())
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("STT worker language switch reply channel disconnected".to_string())
                }
            }
        }

        Ok(())
    }

    fn stop(&mut self) {
        log::info!(
            "Stopping STT session resources (streams={}, workers={})",
            self.streams.len(),
            self.workers.len()
        );
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
            let worker_name = worker
                .thread()
                .name()
                .unwrap_or("unknown-worker")
                .to_string();
            let join_started_at = Instant::now();
            log::info!("Waiting for STT worker '{}' to stop", worker_name);
            let _ = worker.join();
            log::info!(
                "STT worker '{}' stopped after {:?}",
                worker_name,
                join_started_at.elapsed()
            );
        }
    }
}

fn build_capture_stream(
    device: &cpal::Device,
    supported_config: SupportedStreamConfig,
    tx: SyncSender<Vec<i16>>,
    target_sample_rate: u32,
    label: &str,
) -> Result<Stream, String> {
    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.config();
    let channels = config.channels as usize;
    let source_sample_rate = supported_config.sample_rate();

    match sample_format {
        SampleFormat::F32 => {
            let tx = tx.clone();
            let error_label = label.to_string();
            device
                .build_input_stream(
                    &config,
                    move |data: &[f32], _| {
                        let mono = downmix_f32_to_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
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
                        let mono = downmix_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
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
                        let mono = downmix_u16_to_i16(data, channels);
                        let samples =
                            resample_mono_i16(&mono, source_sample_rate, target_sample_rate);
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
    model_path: PathBuf,
    language: String,
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
    let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
    let startup_timeout = worker_startup_timeout_for_model(&model_path);
    let source_name = source.to_string();

    let handle = thread::Builder::new()
        .name(format!("stt-worker-{}", source))
        .spawn(move || {
            let mut startup_signal = Some(startup_tx);
            if let Err(err) = run_worker(
                app.clone(),
                running,
                audio_rx,
                control_rx,
                &model_path,
                &language,
                sample_rate,
                &source_name,
                &mut startup_signal,
            ) {
                if let Some(tx) = startup_signal.take() {
                    let _ = tx.send(Err(err.clone()));
                }
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

    match startup_rx.recv_timeout(startup_timeout) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            let _ = handle.join();
            return Err(err);
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(format!(
                "Timed out while starting recognition worker '{}' (>{:?})",
                source, startup_timeout
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = handle.join();
            return Err(format!(
                "Recognition worker '{}' exited before startup confirmation",
                source
            ));
        }
    }

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
    model_path: &Path,
    language: &str,
    sample_rate: u32,
    source: &str,
    startup_signal: &mut Option<Sender<Result<(), String>>>,
) -> Result<(), String> {
    let load_started_at = Instant::now();
    let mut active_slot = load_recognition_slot(sample_rate, model_path.to_path_buf())?;
    let mut active_language = normalize_whisper_language(language);
    log::info!(
        "STT worker '{}' loaded Whisper model '{}' in {:?}",
        source,
        active_slot.model_path.display(),
        load_started_at.elapsed()
    );

    emit_stt_diagnostic(
        &app,
        "worker_ready",
        "info",
        format!("Источник '{}' готов к распознаванию речи.", source),
        Some(source.to_string()),
    );
    if let Some(tx) = startup_signal.take() {
        let _ = tx.send(Ok(()));
    }

    let mut saw_audio = false;
    let mut audio_stalled = false;
    let mut last_audio_chunk_at = Instant::now();
    let mut audio_window = Vec::<i16>::new();
    let mut total_samples_seen = 0usize;
    let mut samples_since_decode = 0usize;
    let mut last_emitted_final_end_ms = 0_i64;
    let mut last_emitted_text = String::new();
    let mut last_progress_emit_audio_ms = 0_i64;

    while running.load(Ordering::Relaxed) {
        while let Ok(control) = control_rx.try_recv() {
            handle_worker_control(
                sample_rate,
                &mut active_slot,
                &mut active_language,
                &mut audio_window,
                &mut samples_since_decode,
                &mut last_emitted_final_end_ms,
                &mut last_emitted_text,
                &mut last_progress_emit_audio_ms,
                control,
            );
        }

        let chunk = match audio_rx.recv_timeout(Duration::from_millis(40)) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if saw_audio
                    && !audio_stalled
                    && last_audio_chunk_at.elapsed() >= AUDIO_STALL_TIMEOUT
                {
                    audio_stalled = true;
                    emit_stt_diagnostic(
                        &app,
                        "audio_stalled",
                        "warn",
                        format!(
                            "Поток звука из источника '{}' прервался. Попробуйте перезапуск аудио.",
                            source
                        ),
                        Some(source.to_string()),
                    );
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if chunk.is_empty() {
            continue;
        }
        last_audio_chunk_at = Instant::now();
        if audio_stalled {
            audio_stalled = false;
            emit_stt_diagnostic(
                &app,
                "audio_resumed",
                "info",
                format!("Поток звука из источника '{}' восстановлен.", source),
                Some(source.to_string()),
            );
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

        total_samples_seen = total_samples_seen.saturating_add(chunk.len());
        samples_since_decode = samples_since_decode.saturating_add(chunk.len());
        audio_window.extend_from_slice(&chunk);

        let max_window_samples = max_window_samples_for_model(&active_slot.model_path);
        if audio_window.len() > max_window_samples {
            let overflow = audio_window.len() - max_window_samples;
            audio_window.drain(..overflow);
        }

        if audio_window.len() < min_decode_samples_for_model(&active_slot.model_path) {
            continue;
        }

        if samples_since_decode < decode_step_samples_for_model(&active_slot.model_path) {
            continue;
        }

        samples_since_decode = 0;
        decode_audio_window(
            &app,
            &running,
            source,
            &mut active_slot,
            &active_language,
            &audio_window,
            total_samples_seen,
            &mut last_emitted_final_end_ms,
            &mut last_emitted_text,
            &mut last_progress_emit_audio_ms,
            false,
        )?;
    }

    if !audio_window.is_empty() {
        let flush_tail_samples = flush_tail_samples_for_model(&active_slot.model_path);
        let flush_tail_start = audio_window.len().saturating_sub(flush_tail_samples);
        decode_audio_window(
            &app,
            &running,
            source,
            &mut active_slot,
            &active_language,
            &audio_window[flush_tail_start..],
            total_samples_seen,
            &mut last_emitted_final_end_ms,
            &mut last_emitted_text,
            &mut last_progress_emit_audio_ms,
            true,
        )?;
    }

    log::info!("STT worker '{}' finished cleanly", source);

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
    SwitchLanguage {
        language: String,
        reply_tx: Sender<Result<(), String>>,
    },
}

struct LoadedRecognitionSlot {
    model_path: PathBuf,
    cached_model: Arc<CachedWhisperModel>,
    state: WhisperState,
}

impl LoadedRecognitionSlot {
    fn tier(&self) -> WhisperModelTier {
        self.cached_model.tier
    }
}

fn load_recognition_slot(
    _sample_rate: u32,
    model_path: PathBuf,
) -> Result<LoadedRecognitionSlot, String> {
    let cached_model = get_or_load_cached_model(&model_path)?;
    let state = cached_model
        .context
        .create_state()
        .map_err(|error| format!("Failed to create Whisper state: {}", error))?;
    Ok(LoadedRecognitionSlot {
        model_path,
        cached_model,
        state,
    })
}

fn normalize_whisper_language(language: &str) -> String {
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

fn handle_worker_control(
    sample_rate: u32,
    active_slot: &mut LoadedRecognitionSlot,
    active_language: &mut String,
    audio_window: &mut Vec<i16>,
    samples_since_decode: &mut usize,
    last_emitted_final_end_ms: &mut i64,
    last_emitted_text: &mut String,
    last_progress_emit_audio_ms: &mut i64,
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

            let result = (|| -> Result<(), String> {
                let next_active = load_recognition_slot(sample_rate, model_path)?;
                *active_slot = next_active;
                audio_window.clear();
                *samples_since_decode = 0;
                *last_emitted_final_end_ms = 0;
                last_emitted_text.clear();
                *last_progress_emit_audio_ms = 0;
                Ok(())
            })();

            let _ = reply_tx.send(result);
        }
        WorkerControlMessage::PreloadModel {
            model_path,
            reply_tx,
        } => {
            let result = warm_model_cache(model_path);
            let _ = reply_tx.send(result);
        }
        WorkerControlMessage::SwitchLanguage { language, reply_tx } => {
            *active_language = normalize_whisper_language(&language);
            audio_window.clear();
            *samples_since_decode = 0;
            *last_emitted_final_end_ms = 0;
            last_emitted_text.clear();
            *last_progress_emit_audio_ms = 0;
            let _ = reply_tx.send(Ok(()));
        }
    }
}

fn max_window_samples_for_model(model_path: &Path) -> usize {
    match detect_whisper_model_tier(model_path) {
        // Keep short windows for live dual-source decoding.
        WhisperModelTier::Small => (3 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
        WhisperModelTier::Medium => (5 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
        WhisperModelTier::Large => (6 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
    }
}

fn min_decode_samples_for_model(model_path: &Path) -> usize {
    match detect_whisper_model_tier(model_path) {
        // Keep the first decode quick enough for live UX (mic + loopback).
        WhisperModelTier::Small => (400 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
        WhisperModelTier::Medium => (1200 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
        WhisperModelTier::Large => (2500 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
    }
}

fn decode_step_samples_for_model(model_path: &Path) -> usize {
    match detect_whisper_model_tier(model_path) {
        // Use short decode steps so text lands on screen while user is speaking.
        WhisperModelTier::Small => (350 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
        WhisperModelTier::Medium => (800 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
        WhisperModelTier::Large => (1500 * MICROPHONE_TARGET_SAMPLE_RATE as usize) / 1000,
    }
}

fn flush_tail_samples_for_model(model_path: &Path) -> usize {
    match detect_whisper_model_tier(model_path) {
        WhisperModelTier::Small => (3 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
        WhisperModelTier::Medium => (3 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
        WhisperModelTier::Large => (2 * MICROPHONE_TARGET_SAMPLE_RATE) as usize,
    }
}

fn whisper_no_speech_threshold_for_model(model_path: &Path) -> f32 {
    match detect_whisper_model_tier(model_path) {
        WhisperModelTier::Small => 0.5,
        WhisperModelTier::Medium => 0.55,
        WhisperModelTier::Large => 0.6,
    }
}

fn whisper_decode_lock() -> &'static Mutex<()> {
    static DECODE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    DECODE_LOCK.get_or_init(|| Mutex::new(()))
}

fn whisper_threads_for_model(model_path: &Path) -> i32 {
    let available = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4);
    // Two STT workers (mic + system) run in parallel, so keep per-worker thread
    // budget conservative to avoid oversubscription and queue drops.
    let per_worker_budget = (available / 2).max(2);
    let target = match detect_whisper_model_tier(model_path) {
        // Small is used for realtime dual-stream: fewer threads reduce contention spikes.
        WhisperModelTier::Small => per_worker_budget.min(3).max(2),
        WhisperModelTier::Medium => per_worker_budget.min(4).max(2),
        WhisperModelTier::Large => per_worker_budget.min(6).max(3),
    };
    target as i32
}

fn whisper_best_of_for_model(model_path: &Path) -> i32 {
    match detect_whisper_model_tier(model_path) {
        WhisperModelTier::Small => 1,
        WhisperModelTier::Medium => 3,
        WhisperModelTier::Large => 2,
    }
}

fn looks_like_subtitle_credit_hallucination(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("редактор субтитр")
        || (lower.contains("субтитр") && lower.contains("корректор"))
        || (lower.contains("subtitles") && lower.contains("editor"))
}

fn decode_audio_window(
    app: &AppHandle,
    running: &AtomicBool,
    source: &str,
    active_slot: &mut LoadedRecognitionSlot,
    active_language: &str,
    audio_window: &[i16],
    total_samples_seen: usize,
    last_emitted_final_end_ms: &mut i64,
    last_emitted_text: &mut String,
    last_progress_emit_audio_ms: &mut i64,
    flush_tail: bool,
) -> Result<(), String> {
    if !flush_tail && !running.load(Ordering::Relaxed) {
        return Ok(());
    }
    if audio_window.is_empty() {
        return Ok(());
    }

    let mut audio_f32 = vec![0.0_f32; audio_window.len()];
    convert_integer_to_float_audio(audio_window, &mut audio_f32)
        .map_err(|error| format!("Failed to convert audio for Whisper: {}", error))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy {
        best_of: whisper_best_of_for_model(&active_slot.model_path),
    });
    params.set_language(Some(active_language));
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // In live mode we prefer stable text over fragile timestamp edges.
    params.set_no_timestamps(true);
    params.set_single_segment(true);
    // Avoid prompt/context growth that can cause repeated phantom text.
    params.set_no_context(true);
    // Suppress non-speech tokens to reduce subtitle-credit hallucinations on noise.
    params.set_suppress_nst(true);
    params.set_logprob_thold(-2.0);
    params.set_no_speech_thold(whisper_no_speech_threshold_for_model(
        &active_slot.model_path,
    ));
    params.set_n_threads(whisper_threads_for_model(&active_slot.model_path));

    let peak = audio_f32
        .iter()
        .fold(0.0_f32, |acc, sample| acc.max(sample.abs()));
    // Skip decoding near-silence chunks in streaming mode; otherwise we waste
    // CPU and can starve real speech updates.
    if peak < 0.0001 || (!flush_tail && peak < 0.001) {
        return Ok(());
    }
    // Boost low-level signals before decoding so Whisper does not classify
    // quiet speech as "no speech" too aggressively.
    if peak > 0.0001 && peak < 0.12 {
        let gain = (0.22 / peak).min(6.0);
        for sample in &mut audio_f32 {
            *sample = (*sample * gain).clamp(-1.0, 1.0);
        }
    }

    let decode_started_at = Instant::now();
    let model_tier = detect_whisper_model_tier(&active_slot.model_path);
    // Small model is the realtime path; allow parallel decode for mic/system.
    // Medium/Large still decode under a global lock to avoid CPU thrashing.
    let decode_guard = if model_tier == WhisperModelTier::Small {
        None
    } else {
        let guard = loop {
            if !running.load(Ordering::Relaxed) {
                return Ok(());
            }
            match whisper_decode_lock().try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::WouldBlock) => {
                    thread::sleep(Duration::from_millis(8));
                }
                Err(TryLockError::Poisoned(_)) => {
                    return Err("Whisper decode lock is poisoned".to_string());
                }
            }
        };
        Some(guard)
    };
    active_slot
        .state
        .full(params, &audio_f32)
        .map_err(|error| format!("Whisper transcription failed: {}", error))?;
    drop(decode_guard);
    if !running.load(Ordering::Relaxed) {
        return Ok(());
    }
    let decode_elapsed = decode_started_at.elapsed();

    let window_duration_ms =
        ((audio_window.len() as f64 / MICROPHONE_TARGET_SAMPLE_RATE as f64) * 1000.0) as i64;
    if decode_elapsed > Duration::from_millis(2500) {
        log::warn!(
            "Slow STT decode (source='{}', tier='{:?}', window_ms={}, decode_ms={})",
            source,
            detect_whisper_model_tier(&active_slot.model_path),
            window_duration_ms,
            decode_elapsed.as_millis()
        );
    }
    let total_audio_ms =
        ((total_samples_seen as f64 / MICROPHONE_TARGET_SAMPLE_RATE as f64) * 1000.0) as i64;
    let window_start_ms = total_audio_ms.saturating_sub(window_duration_ms);
    let stable_cutoff_ms = if flush_tail {
        total_audio_ms
    } else {
        total_audio_ms.saturating_sub(350)
    };
    let mut pending_partial: Option<(String, f32)> = None;
    let mut latest_segment: Option<(String, i64, i64)> = None;
    let mut segment_count = 0_usize;
    let mut emitted_any = false;

    for segment in active_slot.state.as_iter() {
        segment_count = segment_count.saturating_add(1);
        let text = segment.to_string();
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let segment_start_ts = i64::from(segment.start_timestamp());
        let segment_end_ts = i64::from(segment.end_timestamp());
        let mut start_ms = window_start_ms + segment_start_ts * 10;
        let mut end_ms = window_start_ms + segment_end_ts * 10;

        // Some streaming outputs can provide a single segment with zero timestamps.
        // In that case derive a monotonic pseudo-range from the current audio window
        // so dedupe/progress logic can keep emitting live updates.
        if segment_start_ts == 0 && segment_end_ts == 0 {
            start_ms = total_audio_ms.saturating_sub(window_duration_ms.max(250));
            end_ms = total_audio_ms;
        } else if end_ms <= start_ms {
            end_ms = (start_ms + 200).min(total_audio_ms);
        }
        latest_segment = Some((trimmed.to_string(), start_ms, end_ms));
        if end_ms <= *last_emitted_final_end_ms && trimmed == last_emitted_text.as_str() {
            // Keep a low-frequency partial heartbeat even for repeated text so UI
            // still shows that online recognition is alive.
            pending_partial = Some((trimmed.to_string(), 0.45));
            continue;
        }
        if end_ms > stable_cutoff_ms {
            let partial_confidence =
                (estimate_segment_confidence(trimmed, start_ms, end_ms) - 0.12).max(0.35);
            pending_partial = Some((trimmed.to_string(), partial_confidence));
            continue;
        }

        let confidence = estimate_segment_confidence(trimmed, start_ms, end_ms);
        emit_stt_result(app, source, trimmed.to_string(), true, confidence);
        *last_emitted_final_end_ms = end_ms.max(*last_emitted_final_end_ms);
        *last_emitted_text = trimmed.to_string();
        *last_progress_emit_audio_ms = total_audio_ms;
        emitted_any = true;
    }

    if let Some((partial_text, partial_confidence)) = pending_partial {
        let should_refresh_partial =
            total_audio_ms.saturating_sub(*last_progress_emit_audio_ms) >= 700;
        if partial_text != *last_emitted_text || should_refresh_partial {
            emit_stt_result(app, source, partial_text.clone(), false, partial_confidence);
            *last_emitted_text = partial_text;
            *last_progress_emit_audio_ms = total_audio_ms;
            emitted_any = true;
        }
    }

    if !emitted_any {
        let fallback_candidate: Option<(String, f32, Option<i64>)> = if flush_tail {
            latest_segment.as_ref().map(|(text, start_ms, end_ms)| {
                (
                    text.clone(),
                    estimate_segment_confidence(text, *start_ms, *end_ms).max(0.5),
                    Some(*end_ms),
                )
            })
        } else {
            latest_segment.as_ref().map(|(text, start_ms, end_ms)| {
                (
                    text.clone(),
                    estimate_segment_confidence(text, *start_ms, *end_ms).max(0.5),
                    Some(*end_ms),
                )
            })
        };

        if let Some((fallback_text, fallback_confidence, fallback_end_ms)) = fallback_candidate {
            let should_emit = fallback_text.as_str() != last_emitted_text.as_str()
                || flush_tail
                || total_audio_ms.saturating_sub(*last_progress_emit_audio_ms) >= 1000;
            if should_emit {
                let emit_as_final = flush_tail && fallback_end_ms.is_some();
                emit_stt_result(
                    app,
                    source,
                    fallback_text.clone(),
                    emit_as_final,
                    fallback_confidence,
                );
                if emit_as_final {
                    if let Some(end_ms) = fallback_end_ms {
                        *last_emitted_final_end_ms = end_ms.max(*last_emitted_final_end_ms);
                    }
                }
                *last_emitted_text = fallback_text;
                *last_progress_emit_audio_ms = total_audio_ms;
                emitted_any = true;
            }
        }
    }

    if !emitted_any {
        if let Some((fallback_text, start_ms, end_ms)) = latest_segment.as_ref() {
            let fallback_confidence =
                estimate_segment_confidence(fallback_text, *start_ms, *end_ms).max(0.4);
            emit_stt_result(
                app,
                source,
                fallback_text.clone(),
                false,
                fallback_confidence,
            );
            *last_emitted_text = fallback_text.clone();
            *last_progress_emit_audio_ms = total_audio_ms;
            emitted_any = true;
        }
    }

    if !emitted_any {
        let latest_preview = latest_segment
            .as_ref()
            .map(|(text, _, _)| text.chars().take(80).collect::<String>())
            .unwrap_or_else(|| "<none>".to_string());
        log::info!(
            "STT decode produced no transcript (source='{}', segments={}, peak={:.4}, latest='{}', flush_tail={})",
            source,
            segment_count,
            peak,
            latest_preview,
            flush_tail
        );
    }

    Ok(())
}

fn estimate_segment_confidence(text: &str, start_ms: i64, end_ms: i64) -> f32 {
    let duration_ms = (end_ms - start_ms).max(0) as f32;
    let char_count = text.chars().count() as f32;
    if duration_ms <= 0.0 || char_count <= 0.0 {
        return 0.0;
    }

    let chars_per_second = char_count / (duration_ms / 1000.0).max(0.25);
    if chars_per_second <= 0.0 {
        return 0.0;
    }
    if chars_per_second <= 18.0 {
        0.82
    } else if chars_per_second <= 24.0 {
        0.74
    } else {
        0.62
    }
}

fn emit_stt_result(app: &AppHandle, source: &str, text: String, is_final: bool, confidence: f32) {
    let normalized_text = normalize_transcript_text(&text, is_final);
    if normalized_text.is_empty() {
        return;
    }
    let chars = normalized_text.chars().count();
    log::info!(
        "Emitting stt_result (source='{}', final={}, conf={:.2}, chars={})",
        source,
        is_final,
        confidence,
        chars
    );

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
    if looks_like_subtitle_credit_hallucination(trimmed) {
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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CachedModelKey {
    model_path: PathBuf,
}

struct CachedWhisperModel {
    context: WhisperContext,
    model_path: PathBuf,
    tier: WhisperModelTier,
}

// Safety: whisper.cpp model contexts are immutable after load and are only used
// to create per-worker states. The owned context is dropped exactly once.
unsafe impl Send for CachedWhisperModel {}
unsafe impl Sync for CachedWhisperModel {}

fn normalize_cache_path(path: &Path) -> PathBuf {
    let normalized = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        return strip_windows_verbatim_prefix(&normalized);
    }
    #[cfg(not(target_os = "windows"))]
    {
        normalized
    }
}

#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();

    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }

    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }

    path.to_path_buf()
}

fn model_cache() -> &'static Mutex<HashMap<CachedModelKey, Arc<CachedWhisperModel>>> {
    static CACHE: OnceLock<Mutex<HashMap<CachedModelKey, Arc<CachedWhisperModel>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn model_load_lock_cache() -> &'static Mutex<HashMap<CachedModelKey, Arc<Mutex<()>>>> {
    static CACHE: OnceLock<Mutex<HashMap<CachedModelKey, Arc<Mutex<()>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_or_load_cached_model(model_path: &Path) -> Result<Arc<CachedWhisperModel>, String> {
    let cache_key = CachedModelKey {
        model_path: normalize_cache_path(model_path),
    };

    {
        let guard = model_cache()
            .lock()
            .map_err(|_| "Failed to lock Whisper model cache".to_string())?;
        if let Some(model) = guard.get(&cache_key) {
            log::debug!(
                "Reusing cached Whisper model '{}'",
                model.model_path.display()
            );
            return Ok(model.clone());
        }
    }

    let load_lock = {
        let mut guard = model_load_lock_cache()
            .lock()
            .map_err(|_| "Failed to lock Whisper model load state".to_string())?;
        guard
            .entry(cache_key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _load_guard = load_lock
        .lock()
        .map_err(|_| "Failed to lock Whisper model load gate".to_string())?;

    {
        let guard = model_cache()
            .lock()
            .map_err(|_| "Failed to lock Whisper model cache".to_string())?;
        if let Some(model) = guard.get(&cache_key) {
            return Ok(model.clone());
        }
    }

    let load_started_at = Instant::now();
    let context = WhisperContext::new_with_params(
        cache_key
            .model_path
            .to_str()
            .ok_or_else(|| "Model path contains invalid UTF-8".to_string())?,
        WhisperContextParameters::default(),
    )
    .map_err(|error| {
        format!(
            "Whisper failed to load model from '{}': {}",
            cache_key.model_path.display(),
            error
        )
    })?;

    let loaded_model = Arc::new(CachedWhisperModel {
        context,
        model_path: cache_key.model_path.clone(),
        tier: detect_whisper_model_tier(&cache_key.model_path),
    });

    let mut guard = model_cache()
        .lock()
        .map_err(|_| "Failed to lock Whisper model cache".to_string())?;
    if let Some(existing) = guard.get(&cache_key) {
        return Ok(existing.clone());
    }

    log::info!(
        "Loaded Whisper model '{}' into process cache in {:?}",
        cache_key.model_path.display(),
        load_started_at.elapsed()
    );
    guard.insert(cache_key, loaded_model.clone());
    Ok(loaded_model)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_guard() -> &'static Mutex<()> {
        static TEST_GUARD: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_GUARD.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn stop_does_not_clear_in_progress_flag_without_controller() {
        let _guard = test_guard().lock().unwrap();

        {
            let mut controller = controller_slot().lock().unwrap();
            *controller = None;
        }
        session_stopping_flag().store(true, Ordering::Relaxed);

        let result = stop_global_session();

        assert!(result.is_err());
        assert!(session_stopping_flag().load(Ordering::Relaxed));

        session_stopping_flag().store(false, Ordering::Relaxed);
    }

    #[test]
    fn wait_for_stop_completion_returns_when_flag_clears() {
        let _guard = test_guard().lock().unwrap();

        session_stopping_flag().store(true, Ordering::Relaxed);
        let worker = thread::spawn(|| {
            thread::sleep(Duration::from_millis(60));
            session_stopping_flag().store(false, Ordering::Relaxed);
        });

        let result = wait_for_stop_completion(Duration::from_secs(1));
        let _ = worker.join();

        assert!(result.is_ok());
        assert!(!session_stopping_flag().load(Ordering::Relaxed));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strip_windows_verbatim_prefix_restores_regular_drive_path() {
        let original = Path::new(r"\\?\C:\Users\Dmitry\models\vosk-model-ru-0.42");
        let stripped = strip_windows_verbatim_prefix(original);

        assert_eq!(
            stripped,
            PathBuf::from(r"C:\Users\Dmitry\models\vosk-model-ru-0.42")
        );
    }
}
