# AI Interview Desktop — Agent Guidelines

## Project Overview

Desktop app (macOS 13+ / Windows 10+) for real-time AI-assisted technical interviews. Captures microphone + system
audio, runs local offline STT (Vosk) and OCR, sends context to Gemini LLM via user's API key, shows AI responses in a
semi-transparent overlay.

## Tech Stack

| Layer            | Technology                                                                 |
|------------------|----------------------------------------------------------------------------|
| Desktop shell    | Tauri v2                                                                   |
| Frontend         | React 19 + TypeScript + Tailwind CSS 4 + Vite 7                            |
| State management | Zustand (persisted to localStorage)                                        |
| Backend          | Rust (Tauri commands)                                                      |
| Audio capture    | cpal (mic), ScreenCaptureKit (macOS sys audio), WASAPI (Windows sys audio) |
| STT              | Vosk (offline, streaming, 2 tracks)                                        |
| OCR              | Apple Vision (macOS) / Windows.Media.Ocr (Windows)                         |
| LLM              | Google Gemini API (streaming SSE)                                          |
| Icons            | lucide-react                                                               |

## Project Structure

```
src/                          # React frontend
  main.tsx                    # Entry point
  App.tsx                     # Root component (view router)
  index.css                   # Tailwind + design tokens
  components/
    ui/                       # Reusable primitives (Button, Toggle, Badge, etc.)
    layout/                   # Sidebar, MainLayout
  pages/
    SetupWizard.tsx           # First-launch wizard (4 steps)
    Dashboard.tsx             # Home screen with readiness checks
    SettingsPage.tsx           # 5-tab settings (LLM, Images, Privacy, Storage, Hotkeys)
    InterviewOverlay.tsx       # Interview mode overlay
    HistoryPage.tsx            # Session history with detail panel
  stores/
    app.ts                    # Global app state (view, permissions, interview flag)
    settings.ts               # All user settings (persisted)
    session.ts                # Active interview session state
    history.ts                # Session history (persisted, 30-day TTL)
  lib/
    types.ts                  # Shared TypeScript types
    gemini.ts                 # Gemini API client (model list, streaming chat)
    tauri.ts                  # Tauri IPC wrappers
  hooks/                      # Custom React hooks

src-tauri/                    # Rust backend
  src/
    lib.rs                    # Tauri app setup, plugin registration, command handlers
    main.rs                   # Binary entry point
    commands.rs               # IPC commands (platform info, permissions, audio devices)
    audio.rs                  # Audio device enumeration via cpal
    stt.rs                    # Vosk STT engine interface
    capture_protection.rs     # Platform-specific capture protection status
  Cargo.toml                  # Rust dependencies
  tauri.conf.json             # Tauri window/app configuration
  capabilities/default.json   # Tauri permission capabilities
```

## Key Architecture Decisions

1. **State lives in frontend** — Zustand stores manage all app state; Rust backend provides native capabilities (audio,
   STT, permissions)
2. **LLM client in TypeScript** — Gemini API calls happen from frontend; no Rust proxy needed (reduces latency)
3. **STT in Rust** — Vosk runs in a Rust thread, emits results via Tauri events to frontend
4. **Overlay = separate Tauri window** — Interview overlay is a second window (transparent, always-on-top, no
   decorations); main window stays on dashboard
5. **Settings locked during interview** — `isInterviewActive` flag in app store disables all settings UI

## Coding Conventions

- **Language**: All code, comments, UI text in English
- **Formatting**: Prettier defaults (2-space indent, no semicolons in TS if configured)
- **Components**: Functional React with hooks, no class components
- **State**: Zustand with `persist` middleware for settings/history; plain stores for session
- **Styling**: Tailwind utility classes; custom design tokens defined in `@theme` block in index.css
- **Rust**: Standard Rust formatting (`cargo fmt`), error handling via `Result`/`Option`
- **Types**: Strict TypeScript, shared types in `src/lib/types.ts`
- **Imports**: Use `@/` alias for `src/` directory

## Design System

- **Theme**: Dark (navy/black backgrounds)
- **Accent**: Orange (#f97316)
- **Typography**: 14px body, 12px caption, 18-20px headings, monospace for hotkeys
- **Spacing**: 4/8/12/16/24/32 scale
- **Status colors**: Green (success/supported), Yellow (warning/limited), Red (danger/denied)
- **Bubbles**: Blue (interviewer), Indigo (user), Orange (AI)

## Commands

```bash
make dev          # Start Tauri dev mode (frontend + backend)
make build        # Production build (.dmg / .exe)
make check        # TypeScript + Rust type checks
make lint         # ESLint
make fmt          # Format all code
make clean        # Remove build artifacts
```

## Native Dependencies Bundling

All native deps are bundled in the app binary / app bundle:

| Dependency         | macOS                        | Windows                             | Bundling Strategy                                                                                                                                                                       |
|--------------------|------------------------------|-------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Vosk (STT)         | libvosk.dylib                | vosk.dll                            | Set `VOSK_LIB_DIR` at build to dir containing the lib; copy lib into Tauri bundle resources so it is loadable at runtime. Models: `download_vosk_model` command + app_data/models/vosk. |
| System audio       | ScreenCaptureKit (built-in)  | WASAPI (built-in)                   | Platform API, no external files                                                                                                                                                         |
| OCR                | Apple Vision (built-in)      | Windows.Media.Ocr (built-in)        | Platform API, no external files                                                                                                                                                         |
| Capture protection | NSWindow API (built-in)      | SetWindowDisplayAffinity (built-in) | Platform API, no external files                                                                                                                                                         |
| Global hotkeys     | tauri-plugin-global-shortcut | tauri-plugin-global-shortcut        | Compiled into binary                                                                                                                                                                    |

The only runtime download is the Vosk language model (~50MB for small, ~1.8GB for large), managed by the app's model
manager.

## Testing Strategy

- **Frontend**: Vitest + React Testing Library
- **Backend**: Rust unit tests via `cargo test`
- **E2E**: Manual test matrix against Zoom/Teams/Meet/Telemost
- **Platform matrix**: macOS 13-15, Windows 10-11
