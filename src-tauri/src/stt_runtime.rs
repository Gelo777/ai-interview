use crate::audio;
use crate::stt::{SttDiagnostic, SttResult};
#[cfg(target_os = "windows")]
use crate::system_audio;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig, SupportedStreamConfig};
use libloading::Library;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
use std::os::raw::{c_char, c_float, c_int, c_short, c_void};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const AUDIO_QUEUE_CAPACITY: usize = 12;
const MICROPHONE_TARGET_SAMPLE_RATE: u32 = 16000;
const PARTIAL_RESULT_MIN_INTERVAL_MS: u64 = 180;
const MODEL_SWITCH_MANAGER_TIMEOUT: Duration = Duration::from_secs(50);
const MODEL_SWITCH_WORKER_TIMEOUT: Duration = Duration::from_secs(45);
const MODEL_PRELOAD_MANAGER_TIMEOUT: Duration = Duration::from_secs(75);
const MODEL_PRELOAD_WORKER_TIMEOUT: Duration = Duration::from_secs(70);
const STOP_JOIN_GRACE_PERIOD: Duration = Duration::from_secs(4);
const STOP_COMPLETION_WAIT_ON_START_TIMEOUT: Duration = Duration::from_secs(12);
const WORKER_JOIN_GRACE_PERIOD: Duration = Duration::from_millis(1200);
const WORKER_JOIN_POLL_INTERVAL: Duration = Duration::from_millis(20);
const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const HEAVY_MODEL_WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(210);
const SESSION_STARTUP_TIMEOUT: Duration = Duration::from_secs(70);
const HEAVY_MODEL_SESSION_STARTUP_TIMEOUT: Duration = Duration::from_secs(240);
const AUDIO_STALL_TIMEOUT: Duration = Duration::from_secs(4);
const STT_TARGET_RMS: f64 = 4200.0;
const STT_MIN_RMS_FOR_GAIN: f64 = 280.0;
const STT_MAX_GAIN: f64 = 3.0;

fn is_heavy_vosk_model_path(model_path: &Path) -> bool {
    let lower = model_path.to_string_lossy().to_lowercase();
    !lower.contains("small")
}

fn worker_startup_timeout_for_model(model_path: &Path) -> Duration {
    if is_heavy_vosk_model_path(model_path) {
        HEAVY_MODEL_WORKER_STARTUP_TIMEOUT
    } else {
        WORKER_STARTUP_TIMEOUT
    }
}

fn session_startup_timeout_for_model(model_path: &Path) -> Duration {
    if is_heavy_vosk_model_path(model_path) {
        HEAVY_MODEL_SESSION_STARTUP_TIMEOUT
    } else {
        SESSION_STARTUP_TIMEOUT
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
    pub runtime_library_path: PathBuf,
    pub microphone_device_id: Option<String>,
    pub system_audio_device_id: Option<String>,
}

pub fn start_global_session(app: AppHandle, config: SttRuntimeConfig) -> Result<(), String> {
    let session_startup_timeout = session_startup_timeout_for_model(&config.model_path);
    if session_stopping_flag().load(Ordering::Relaxed) {
        log::info!(
            "STT start requested while previous stop is still running; waiting up to {:?}",
            STOP_COMPLETION_WAIT_ON_START_TIMEOUT
        );
        wait_for_stop_completion(STOP_COMPLETION_WAIT_ON_START_TIMEOUT)?;
    }

    {
        let mut guard = controller_slot()
            .lock()
            .map_err(|_| "Failed to lock STT controller state".to_string())?;
        cleanup_finished_session_locked(&mut guard);

        if guard.is_some() {
            return Err("Распознавание уже запущено".to_string());
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
            return Err("Распознавание уже запущено".to_string());
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
        drop(guard);
        if session_stopping_flag().load(Ordering::Relaxed) {
            log::info!("STT stop requested while previous stop is still completing");
            return Err(
                "Остановка распознавания еще выполняется. Повторите через несколько секунд."
                    .to_string(),
            );
        }

        log::info!("STT stop requested, but there is no active session");
        return Ok(());
    };
    drop(guard);

    let SessionController { tx, handle } = controller;
    let manager_thread_name = handle.thread().name().unwrap_or("stt-session-manager");
    log::info!("Stopping global STT session via '{}'", manager_thread_name);
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
                "Остановка распознавания еще выполняется. Повторите через несколько секунд."
                    .to_string(),
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
        .ok_or_else(|| "Распознавание не запущено".to_string())?;

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
            Err("Переключение профиля заняло слишком много времени".to_string())
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
        .ok_or_else(|| "Распознавание не запущено".to_string())?;

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
            Err("Подготовка профиля заняла слишком много времени".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("STT model preload channel disconnected".to_string())
        }
    }
}

pub fn warm_model_cache(runtime_library_path: PathBuf, model_path: PathBuf) -> Result<(), String> {
    let started_at = Instant::now();
    let cached_model = get_or_load_cached_model(&runtime_library_path, &model_path)?;
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

fn join_worker_with_grace_period(
    worker: JoinHandle<()>,
    worker_name: String,
    grace_period: Duration,
) -> bool {
    let deadline = Instant::now() + grace_period;
    let mut worker = Some(worker);

    while let Some(handle) = worker.as_ref() {
        if handle.is_finished() {
            if let Some(done) = worker.take() {
                let _ = done.join();
            }
            return true;
        }

        if Instant::now() >= deadline {
            if let Some(detached) = worker.take() {
                thread::spawn(move || {
                    let _ = detached.join();
                    log::info!("Detached STT worker '{}' join finished", worker_name);
                });
            }
            return false;
        }

        thread::sleep(WORKER_JOIN_POLL_INTERVAL);
    }

    true
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
        let heavy_model = is_heavy_vosk_model_path(&model_path);
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
                "Preloading heavy STT model '{}' before starting capture workers",
                model_path.display()
            );
            warm_model_cache(runtime_library_path.clone(), model_path.clone())?;
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
                        runtime_library_path.clone(),
                        model_path.clone(),
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
                                runtime_library_path.clone(),
                                model_path.clone(),
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
            return Err(format!("Распознавание не запустилось. {}", detail));
        }

        if !source_warnings.is_empty() {
            log::warn!(
                "Распознавание запущено с ограниченным захватом аудио: {}",
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
            let joined_in_time = join_worker_with_grace_period(
                worker,
                worker_name.clone(),
                WORKER_JOIN_GRACE_PERIOD,
            );
            if joined_in_time {
                log::info!(
                    "STT worker '{}' stopped after {:?}",
                    worker_name,
                    join_started_at.elapsed()
                );
            } else {
                log::warn!(
                    "STT worker '{}' did not stop within {:?}; detached join in background",
                    worker_name,
                    WORKER_JOIN_GRACE_PERIOD
                );
            }
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
    let mut active_output_selector = selected_output_device_id;

    while running.load(Ordering::Relaxed) {
        let result = run_windows_system_loopback_stream_once(
            &running,
            &tx,
            target_sample_rate,
            active_output_selector.as_deref(),
        );
        if !running.load(Ordering::Relaxed) {
            break;
        }

        if let Err(err) = result {
            let normalized = err.to_ascii_lowercase();
            if active_output_selector.is_some()
                && (normalized.contains("selected output device is not available")
                    || normalized.contains("selected output device is no longer available"))
            {
                log::warn!(
                    "Selected loopback output device became unavailable; falling back to current default output"
                );
                active_output_selector = None;
            }
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
                        enqueue_audio_chunk(&tx, condition_audio_for_stt(&samples));
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
                &runtime_library_path,
                &model_path,
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
    runtime_library_path: &Path,
    model_path: &Path,
    sample_rate: u32,
    source: &str,
    startup_signal: &mut Option<Sender<Result<(), String>>>,
) -> Result<(), String> {
    let load_started_at = Instant::now();
    let mut active_slot =
        load_recognition_slot(runtime_library_path, sample_rate, model_path.to_path_buf())?;
    let mut standby_slot: Option<LoadedRecognitionSlot> = None;
    log::info!(
        "STT worker '{}' loaded model '{}' in {:?}",
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

    let mut last_partial = String::new();
    let mut last_partial_emit_at = Instant::now()
        .checked_sub(Duration::from_millis(PARTIAL_RESULT_MIN_INTERVAL_MS))
        .unwrap_or_else(Instant::now);
    let mut saw_audio = false;
    let mut last_audio_at: Option<Instant> = None;
    let mut stall_reported = false;

    while running.load(Ordering::Relaxed) {
        while let Ok(control) = control_rx.try_recv() {
            handle_worker_control(
                runtime_library_path,
                sample_rate,
                &mut active_slot,
                &mut standby_slot,
                &mut last_partial,
                control,
            );
        }

        let chunk = match audio_rx.recv_timeout(Duration::from_millis(40)) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                if saw_audio
                    && !stall_reported
                    && last_audio_at.is_some_and(|at| at.elapsed() >= AUDIO_STALL_TIMEOUT)
                {
                    stall_reported = true;
                    emit_stt_diagnostic(
                        &app,
                        "audio_stalled",
                        "warn",
                        format!(
                            "Audio stream '{}' is not delivering frames for {:?}.",
                            source, AUDIO_STALL_TIMEOUT
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

        let now = Instant::now();
        last_audio_at = Some(now);
        if stall_reported {
            stall_reported = false;
            emit_stt_diagnostic(
                &app,
                "audio_resumed",
                "info",
                format!("Audio stream '{}' resumed.", source),
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

        let accepted = active_slot
            .api()
            .accept_waveform(active_slot.recognizer, &chunk)?;
        if accepted {
            let (text, confidence) = active_slot
                .api()
                .result_text_and_confidence(active_slot.recognizer)?;
            if !text.is_empty() {
                emit_stt_result(&app, source, text, true, confidence);
            }
            last_partial.clear();
        } else {
            let partial = active_slot.api().partial_text(active_slot.recognizer)?;
            if !partial.is_empty() && partial != last_partial {
                let now = Instant::now();
                let should_emit_partial = now.duration_since(last_partial_emit_at)
                    >= Duration::from_millis(PARTIAL_RESULT_MIN_INTERVAL_MS);
                if should_emit_partial {
                    emit_stt_result(&app, source, partial.clone(), false, 0.0);
                    last_partial_emit_at = now;
                }
                last_partial = partial;
            }
        }
    }

    let (final_text, confidence) = active_slot
        .api()
        .final_text_and_confidence(active_slot.recognizer)?;
    if !final_text.is_empty() {
        emit_stt_result(&app, source, final_text, true, confidence);
    }

    free_recognition_slot(&mut active_slot);
    if let Some(mut standby) = standby_slot.take() {
        free_recognition_slot(&mut standby);
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
}

struct LoadedRecognitionSlot {
    model_path: PathBuf,
    cached_model: Arc<CachedVoskModel>,
    recognizer: RecognizerPtr,
}

impl LoadedRecognitionSlot {
    fn api(&self) -> &VoskApi {
        self.cached_model.api.as_ref()
    }
}

fn load_recognition_slot(
    runtime_library_path: &Path,
    sample_rate: u32,
    model_path: PathBuf,
) -> Result<LoadedRecognitionSlot, String> {
    let cached_model = get_or_load_cached_model(runtime_library_path, &model_path)?;
    let recognizer = cached_model
        .api
        .create_recognizer(cached_model.model, sample_rate as c_float)?;
    Ok(LoadedRecognitionSlot {
        model_path,
        cached_model,
        recognizer,
    })
}

fn free_recognition_slot(slot: &mut LoadedRecognitionSlot) {
    slot.api().free_recognizer(slot.recognizer);
    slot.recognizer = std::ptr::null_mut();
}

fn handle_worker_control(
    runtime_library_path: &Path,
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
                        free_recognition_slot(&mut old_standby);
                    }
                    last_partial.clear();
                    let _ = reply_tx.send(Ok(()));
                    return;
                }
            }

            let result = (|| -> Result<(), String> {
                let next_active =
                    load_recognition_slot(runtime_library_path, sample_rate, model_path)?;
                let previous_active = std::mem::replace(active_slot, next_active);
                if let Some(mut old_standby) = standby_slot.replace(previous_active) {
                    free_recognition_slot(&mut old_standby);
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
                let next_standby =
                    load_recognition_slot(runtime_library_path, sample_rate, model_path)?;
                if let Some(mut existing_standby) = standby_slot.replace(next_standby) {
                    free_recognition_slot(&mut existing_standby);
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

fn resample_mono_i16(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
    if samples.is_empty() || input_rate == 0 || output_rate == 0 || input_rate == output_rate {
        return samples.to_vec();
    }

    if output_rate < input_rate {
        return downsample_mono_i16_area(samples, input_rate, output_rate);
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

fn condition_audio_for_stt(samples: &[i16]) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }

    let mean = samples.iter().map(|sample| *sample as f64).sum::<f64>() / samples.len() as f64;
    let rms = (samples
        .iter()
        .map(|sample| {
            let centered = *sample as f64 - mean;
            centered * centered
        })
        .sum::<f64>()
        / samples.len() as f64)
        .sqrt();

    if rms < STT_MIN_RMS_FOR_GAIN {
        return samples
            .iter()
            .map(|sample| clamp_i16_from_f64(*sample as f64 - mean))
            .collect();
    }

    let gain = (STT_TARGET_RMS / rms).clamp(1.0, STT_MAX_GAIN);
    samples
        .iter()
        .map(|sample| {
            let centered = *sample as f64 - mean;
            clamp_i16_from_f64(centered * gain)
        })
        .collect()
}

fn downsample_mono_i16_area(samples: &[i16], input_rate: u32, output_rate: u32) -> Vec<i16> {
    let ratio = input_rate as f64 / output_rate as f64;
    let output_len = ((samples.len() as f64) / ratio).round() as usize;
    if output_len == 0 {
        return Vec::new();
    }

    let mut output = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let source_start = output_index as f64 * ratio;
        let source_end = ((output_index + 1) as f64 * ratio).min(samples.len() as f64);
        let mut cursor = source_start;
        let mut weighted_sum = 0.0_f64;
        let mut total_weight = 0.0_f64;

        while cursor < source_end {
            let sample_index = cursor.floor() as usize;
            let next_boundary = ((sample_index + 1) as f64).min(source_end);
            let weight = next_boundary - cursor;
            if let Some(sample) = samples.get(sample_index) {
                weighted_sum += *sample as f64 * weight;
                total_weight += weight;
            }
            cursor = next_boundary;
        }

        let averaged = if total_weight > 0.0 {
            weighted_sum / total_weight
        } else {
            *samples.last().unwrap_or(&0) as f64
        };
        output.push(clamp_i16_from_f64(averaged));
    }

    output
}

fn clamp_i16_from_f64(value: f64) -> i16 {
    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
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

// Safety: Vosk function pointers are immutable after load, and the library handle
// remains alive for the lifetime of the shared API object.
unsafe impl Send for VoskApi {}
unsafe impl Sync for VoskApi {}

impl VoskApi {
    fn load(runtime_library_path: &Path) -> Result<Self, String> {
        // Safety: function pointers are loaded once from trusted runtime library.
        unsafe {
            crate::vosk_runtime::ensure_runtime_dir_on_path(runtime_library_path);
            let lib = Library::new(runtime_library_path).map_err(|e| {
                format!(
                    "Не удалось загрузить голосовой модуль '{}': {}",
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

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CachedModelKey {
    runtime_library_path: PathBuf,
    model_path: PathBuf,
}

struct CachedVoskModel {
    api: Arc<VoskApi>,
    model: ModelPtr,
    model_path: PathBuf,
}

// Safety: Vosk models are reused as read-only state across recognizers. The raw
// pointer is owned by this struct and freed only once in Drop.
unsafe impl Send for CachedVoskModel {}
unsafe impl Sync for CachedVoskModel {}

impl Drop for CachedVoskModel {
    fn drop(&mut self) {
        self.api.free_model(self.model);
        self.model = std::ptr::null_mut();
    }
}

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

fn runtime_api_cache() -> &'static Mutex<HashMap<PathBuf, Arc<VoskApi>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<VoskApi>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn model_cache() -> &'static Mutex<HashMap<CachedModelKey, Arc<CachedVoskModel>>> {
    static CACHE: OnceLock<Mutex<HashMap<CachedModelKey, Arc<CachedVoskModel>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn model_load_lock_cache() -> &'static Mutex<HashMap<CachedModelKey, Arc<Mutex<()>>>> {
    static CACHE: OnceLock<Mutex<HashMap<CachedModelKey, Arc<Mutex<()>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_or_load_vosk_api(runtime_library_path: &Path) -> Result<Arc<VoskApi>, String> {
    let runtime_library_path = normalize_cache_path(runtime_library_path);
    {
        let guard = runtime_api_cache()
            .lock()
            .map_err(|_| "Не удалось подготовить голосовой модуль".to_string())?;
        if let Some(api) = guard.get(&runtime_library_path) {
            return Ok(api.clone());
        }
    }

    let api = Arc::new(VoskApi::load(&runtime_library_path)?);
    let mut guard = runtime_api_cache()
        .lock()
        .map_err(|_| "Не удалось подготовить голосовой модуль".to_string())?;
    let entry = guard
        .entry(runtime_library_path)
        .or_insert_with(|| api.clone());
    Ok(entry.clone())
}

fn get_or_load_cached_model(
    runtime_library_path: &Path,
    model_path: &Path,
) -> Result<Arc<CachedVoskModel>, String> {
    let cache_key = CachedModelKey {
        runtime_library_path: normalize_cache_path(runtime_library_path),
        model_path: normalize_cache_path(model_path),
    };

    {
        let guard = model_cache()
            .lock()
            .map_err(|_| "Failed to lock STT model cache".to_string())?;
        if let Some(model) = guard.get(&cache_key) {
            log::debug!("Reusing cached STT model '{}'", model.model_path.display());
            return Ok(model.clone());
        }
    }

    let load_lock = {
        let mut guard = model_load_lock_cache()
            .lock()
            .map_err(|_| "Failed to lock STT model load state".to_string())?;
        guard
            .entry(cache_key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _load_guard = load_lock
        .lock()
        .map_err(|_| "Failed to lock STT model load gate".to_string())?;

    {
        let guard = model_cache()
            .lock()
            .map_err(|_| "Failed to lock STT model cache".to_string())?;
        if let Some(model) = guard.get(&cache_key) {
            log::debug!(
                "Reusing cached STT model '{}' after waiting for active loader",
                model.model_path.display()
            );
            return Ok(model.clone());
        }
    }

    let load_started_at = Instant::now();
    let api = get_or_load_vosk_api(&cache_key.runtime_library_path)?;
    let model = api.create_model(&cache_key.model_path)?;
    let loaded_model = Arc::new(CachedVoskModel {
        api,
        model,
        model_path: cache_key.model_path.clone(),
    });

    let mut guard = model_cache()
        .lock()
        .map_err(|_| "Failed to lock STT model cache".to_string())?;
    if let Some(existing) = guard.get(&cache_key) {
        return Ok(existing.clone());
    }

    log::info!(
        "Loaded STT model '{}' into process cache in {:?}",
        cache_key.model_path.display(),
        load_started_at.elapsed()
    );
    guard.insert(cache_key, loaded_model.clone());
    Ok(loaded_model)
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
