use serde::Serialize;

/// STT engine status
#[derive(Debug, Clone, Serialize)]
pub struct SttStatus {
    pub available: bool,
    pub model_loaded: bool,
    pub model_path: Option<String>,
    pub language: String,
    pub runtime_library_loaded: bool,
    pub runtime_library_path: Option<String>,
    pub detail: String,
}

/// A partial or final STT result
#[derive(Debug, Clone, Serialize)]
pub struct SttResult {
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    pub source: String, // "mic" or "system"
}

#[derive(Debug, Clone, Serialize)]
pub struct SttDiagnostic {
    pub code: String,
    pub level: String,
    pub message: String,
    pub source: Option<String>,
}

/// STT engine configuration
#[derive(Debug, Clone)]
pub struct SttConfig {
    pub model_path: String,
    pub language: String,
    pub runtime_library_path: Option<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            model_path: String::new(),
            language: "en".to_string(),
            runtime_library_path: None,
        }
    }
}

/// Placeholder STT engine. Will be replaced with Vosk once libvosk is available.
///
/// Integration plan:
/// 1. Download Vosk model (vosk-model-en-us-0.22 for EN, vosk-model-ru-0.42 for RU)
/// 2. Place in app data directory
/// 3. Initialize VoskModel + VoskRecognizer per audio track
/// 4. Feed audio chunks from cpal stream to recognizer
/// 5. Emit partial/final results via Tauri events
pub struct SttEngine {
    config: SttConfig,
}

impl SttEngine {
    pub fn new(config: SttConfig) -> Self {
        Self { config }
    }

    pub fn get_status(&self) -> SttStatus {
        let model_exists = !self.config.model_path.is_empty()
            && std::path::Path::new(&self.config.model_path).exists();
        let runtime_library_available = self
            .config
            .runtime_library_path
            .as_ref()
            .is_some_and(|path| std::path::Path::new(path).exists());

        SttStatus {
            available: model_exists && runtime_library_available,
            model_loaded: model_exists,
            model_path: if model_exists {
                Some(self.config.model_path.clone())
            } else {
                None
            },
            language: self.config.language.clone(),
            runtime_library_loaded: runtime_library_available,
            runtime_library_path: self.config.runtime_library_path.clone(),
            detail: match (runtime_library_available, model_exists) {
                (true, true) => "Vosk runtime and model found. Ready to start.".to_string(),
                (false, true) => {
                    "Vosk model found, but runtime library is missing/unloadable.".to_string()
                }
                (true, false) => format!(
                    "Vosk runtime found, but model is missing. Download a model to: {} \
                     (https://alphacephei.com/vosk/models)",
                    if self.config.model_path.is_empty() {
                        "<app_data>/models/vosk/"
                    } else {
                        &self.config.model_path
                    }
                ),
                (false, false) => format!(
                    "Vosk runtime library and model are missing. Model path: {}. \
                     Runtime is expected in app resources or VOSK_LIB_DIR.",
                    if self.config.model_path.is_empty() {
                        "<app_data>/models/vosk/"
                    } else {
                        &self.config.model_path
                    }
                ),
            },
        }
    }
}
