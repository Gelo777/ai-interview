# AI Interview Desktop

AI-powered desktop assistant for technical interviews. Captures microphone + system audio, runs **local offline STT** (
Vosk) and **OCR**, sends context to **Google Gemini** via user's API key, and displays AI responses in a
semi-transparent overlay.

**Platforms**: macOS 13+ / Windows 10+  
**Priorities**: (1) Accuracy → (2) Latency → (3) Usefulness. Cost is secondary.

## Tech Stack

| Layer    | Technology                                                    |
|----------|---------------------------------------------------------------|
| Desktop  | [Tauri v2](https://v2.tauri.app/) (Rust backend)              |
| Frontend | React 19 + TypeScript + Tailwind CSS 4 + Vite 7               |
| State    | [Zustand](https://github.com/pmndrs/zustand) with persistence |
| Audio    | [cpal](https://github.com/RustAudio/cpal) + platform APIs     |
| STT      | [Vosk](https://alphacephei.com/vosk/) (offline, streaming)    |
| OCR      | Apple Vision (macOS) / Windows.Media.Ocr (Windows)            |
| LLM      | Google Gemini API (streaming SSE)                             |
| Icons    | [lucide-react](https://lucide.dev/)                           |

## Prerequisites

- **Node.js** 22+
- **Rust** 1.77+
- **macOS** 13+ or **Windows** 10+

## Quick Start

```bash
# First-time setup
make setup

# Start development
make run

# Production build
make build
```

## All Commands

```bash
make setup       # Check env + install Node dependencies
make run         # Development mode with hot reload
make dev         # Same as make run
make build       # Production build (.dmg / .msi / .exe)
make check       # TypeScript + Rust type checks
make lint        # ESLint
make clean       # Remove build artifacts
make help        # Show command list
```

## Project Structure

```
src/                          # React frontend
  components/ui/              # Button, Toggle, Badge, Select, Slider, Card, StatusIndicator
  components/layout/          # Sidebar, MainLayout
  pages/
    Dashboard.tsx             # Home with readiness checks + start interview
    SettingsPage.tsx          # 6-tab settings (LLM, Language, Images, Privacy, Storage, Hotkeys)
    InterviewOverlay.tsx       # Interview mode: chat + AI panel + actions
    HistoryPage.tsx            # Session list + detail + report view
  stores/                     # Zustand: app, settings, session, history
  lib/
    types.ts                  # Shared TypeScript types
    gemini.ts                 # Gemini API client (models, streaming chat)
    tauri.ts                  # Tauri IPC wrappers

src-tauri/                    # Rust backend
  src/
    lib.rs                    # App setup + plugin registration
    commands.rs               # IPC: platform info, permissions, audio devices
    audio.rs                  # Audio device enumeration (cpal)
    stt.rs                    # Vosk STT engine interface
    capture_protection.rs     # Platform capture protection status
```

## Features

### Interview Overlay

Semi-transparent dark overlay with:

- **Chat feed**: interviewer (left), user (right), AI markers (center)
- **AI Response panel**: last answer only, scrollable, auto-replaced
- **Action bar**: "Send" and "Send + Screenshot" buttons with hotkey labels
- **Header**: mic/audio indicators, session timer
- **Rolling buffer**: memory-limited (1-256 MB), batch eviction, "N new messages" pill
- **Capture protection**: OS-level window protection badge

### Settings (6 tabs)

- **LLM**: API key (validated), model selection, summary/report toggles, max tokens
- **Language**: Vosk runtime status + latest stable check, install/update runtime, per-language small/large model selection, queued installs, cancel installation
- **Images/OCR**: OCR-to-text vs send-image mode
- **Privacy**: Capture protection toggle + platform compatibility status
- **Storage**: Chat memory limit slider, history retention by custom days or forever
- **Hotkeys**: Click-to-rebind shortcuts (up to 4 keys), conflict detection, reset to defaults

### History

- Session list with date, duration, metrics, report score
- Detail panel: full metrics + final report (scores, strengths, weaknesses, improvements)
- Auto-cleanup based on configurable retention (or keep forever)
- Manual session deletion

### Storage and Persistence

- Zustand state is persisted to system app data (`app_data/state/*.json`) in Tauri mode
- API key is stored in secure OS keychain storage
- Legacy browser localStorage values are migrated automatically

## Native Dependencies

Native dependencies used by the app and target platform APIs:

| Component          | macOS                               | Windows                             |
|--------------------|-------------------------------------|-------------------------------------|
| STT (Vosk)         | `libvosk.dylib` bundled             | `vosk.dll` bundled                  |
| STT models         | Downloaded on demand (small baseline + optional large) | Downloaded on demand (small baseline + optional large) |
| System audio       | ScreenCaptureKit (built-in API)     | WASAPI loopback (built-in API)      |
| OCR                | Apple Vision (built-in API)         | Windows.Media.Ocr (built-in API)    |
| Capture protection | NSWindow API (built-in)             | SetWindowDisplayAffinity (built-in) |
| Global hotkeys     | tauri-plugin-global-shortcut        | tauri-plugin-global-shortcut        |

### Vosk Runtime Library Placement

The app expects Vosk runtime libraries in deterministic platform folders:

- `src-tauri/resources/vosk/macos/` (`libvosk.dylib`)
- `src-tauri/resources/vosk/windows/` (`vosk.dll` or `libvosk.dll` + dependent DLLs if needed)

Optional helper for local/CI builds:

- set `VOSK_LIB_DIR=/path/to/vosk/libs` before build
- `build.rs` copies matching runtime libraries into the folders above and into `target/*/(debug|release)` for dev runs

`get_stt_status` now performs a runtime smoke-check by trying to load the library from bundled/resource paths.

## Documentation

- [`AGENTS.md`](AGENTS.md) — Agent/developer guidelines, architecture, conventions
