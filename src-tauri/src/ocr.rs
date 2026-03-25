//! Platform-native OCR: Apple Vision (macOS) / Windows.Media.Ocr (Windows).
//! Input: base64-encoded image (PNG/JPEG). Output: recognized text.

use base64::Engine;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use uuid::Uuid;

struct TempFileCleanup {
    path: PathBuf,
}

impl TempFileCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFileCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Runs OCR on a base64-encoded image. Returns recognized text or error.
/// language_hint: e.g. "en-US", "ru" — used when the platform supports it.
pub fn ocr_image_base64(
    image_base64: String,
    language_hint: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return ocr_macos(image_base64, language_hint);

    #[cfg(target_os = "windows")]
    return ocr_windows(image_base64, language_hint);

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (image_base64, language_hint);
        Err("OCR is not implemented on this platform.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn ocr_macos(image_base64: String, language_hint: Option<String>) -> Result<String, String> {
    let image_path = write_temp_image(&image_base64)?;
    let _image_cleanup = TempFileCleanup::new(image_path.clone());
    let language = normalize_language_hint(language_hint.as_deref());
    let script = r#"
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("Missing image path argument\n", stderr)
  exit(2)
}

let imagePath = args[1]
let language = args.count >= 3 ? args[2] : "auto"

guard let image = NSImage(contentsOfFile: imagePath),
      let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let cgImage = rep.cgImage else {
  fputs("Failed to decode image for Vision OCR\n", stderr)
  exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if language != "auto" && !language.isEmpty {
  request.recognitionLanguages = [language]
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
  try handler.perform([request])
  let text = (request.results ?? [])
    .compactMap { ($0 as? VNRecognizedTextObservation)?.topCandidates(1).first?.string }
    .joined(separator: "\n")
  print(text)
} catch {
  fputs("Vision OCR request failed: \(error)\n", stderr)
  exit(4)
}
"#;

    let mut child = Command::new("swift")
        .arg("-")
        .arg(&image_path)
        .arg(&language)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch swift for OCR: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Failed to write OCR swift script: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to run swift OCR process: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("macOS Vision OCR failed: {}", stderr.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Err("macOS Vision OCR returned empty text.".to_string())
    } else {
        Ok(text)
    }
}

#[cfg(target_os = "windows")]
fn ocr_windows(image_base64: String, language_hint: Option<String>) -> Result<String, String> {
    let image_path = write_temp_image(&image_base64)?;
    let _image_cleanup = TempFileCleanup::new(image_path.clone());
    let script_path = write_temp_windows_ocr_script()?;
    let _script_cleanup = TempFileCleanup::new(script_path.clone());
    let language = normalize_language_hint(language_hint.as_deref());

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script_path)
        .arg(&image_path)
        .arg(&language)
        .output()
        .map_err(|e| format!("Failed to launch PowerShell OCR: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Windows OCR failed: {}", stderr.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Err("Windows OCR returned empty text.".to_string())
    } else {
        Ok(text)
    }
}

fn write_temp_image(image_base64: &str) -> Result<PathBuf, String> {
    let bytes = decode_image_payload(image_base64)?;
    let ext = detect_image_extension(&bytes);
    let path = std::env::temp_dir().join(format!("ai-interview-ocr-{}.{}", Uuid::new_v4(), ext));
    fs::write(&path, bytes).map_err(|e| format!("Failed to write temporary OCR image: {}", e))?;
    Ok(path)
}

fn decode_image_payload(image_base64: &str) -> Result<Vec<u8>, String> {
    let cleaned = image_base64
        .trim()
        .split(',')
        .next_back()
        .ok_or_else(|| "Invalid base64 image payload".to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|e| format!("Invalid base64 image payload: {}", e))?;
    if bytes.is_empty() {
        return Err("Empty image payload.".to_string());
    }
    Ok(bytes)
}

fn detect_image_extension(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else {
        "png"
    }
}

fn normalize_language_hint(language_hint: Option<&str>) -> String {
    match language_hint.map(str::trim).filter(|s| !s.is_empty()) {
        Some("auto") | None => "auto".to_string(),
        Some("en") => "en-US".to_string(),
        Some("ru") => "ru-RU".to_string(),
        Some(value) => value.to_string(),
    }
}
#[cfg(target_os = "windows")]
fn write_temp_windows_ocr_script() -> Result<PathBuf, String> {
    let script = r#"
param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [Parameter(Mandatory=$false)][string]$LanguageHint = "auto"
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

$file = [Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath).GetAwaiter().GetResult()
$stream = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read).GetAwaiter().GetResult()
$decoder = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream).GetAwaiter().GetResult()
$bitmap = $decoder.GetSoftwareBitmapAsync().GetAwaiter().GetResult()

if ($LanguageHint -and $LanguageHint -ne "auto") {
  $lang = [Windows.Globalization.Language]::new($LanguageHint)
  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

if ($null -eq $engine) {
  throw "Failed to create OCR engine."
}

$result = $engine.RecognizeAsync($bitmap).GetAwaiter().GetResult()
if ($null -eq $result) {
  throw "OCR result is null."
}

Write-Output $result.Text
"#;

    let path = std::env::temp_dir().join(format!("ai-interview-ocr-{}.ps1", Uuid::new_v4()));
    fs::write(&path, script).map_err(|e| format!("Failed to write temporary OCR script: {}", e))?;
    Ok(path)
}
