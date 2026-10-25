# REX — Feature Inventory

Everything the app does today, where it lives, and what it deliberately does not do yet.
Scope: the Electron app in this repository, not the original Python prototype.

**Legend:** ✅ implemented · ⚠️ implemented with limits · ⬜ planned

---

## 1. Local LLM (Ollama)

| # | Feature | Status | Where | Notes |
|---|---|---|---|---|
| 1.1 | Local-only inference through Ollama's HTTP API | ✅ | `src/main/ollama.ts` | No cloud provider, no API keys, no telemetry |
| 1.2 | Live model discovery (`GET /api/tags`) | ✅ | `listModels()` | Sorted vision-first, then alphabetically |
| 1.3 | Vision-model detection | ⚠️ | `looksVisionCapable()` | Tag heuristic (`llava`, `qwen2.5vl`, `gemma3`, `moondream`, …); Ollama exposes no capability flag, so any model stays selectable |
| 1.4 | Server health check (`GET /api/version`) | ✅ | `checkOllama()` | 2.5 s timeout; drives the status dot and setup card |
| 1.5 | Streaming chat (`POST /api/chat`, `stream: true`) | ✅ | `chat()` | NDJSON parsed line-by-line; tokens forwarded over IPC as they arrive |
| 1.6 | Mid-answer cancel | ✅ | `AbortController` + `ask:cancel` | Stop button and `Esc` abort the fetch and the stream reader |
| 1.7 | Model kept warm between questions | ✅ | `keep_alive: '30m'` | Avoids a cold reload on every follow-up |
| 1.8 | Deterministic answers | ✅ | `temperature: 0.2`, `num_ctx: 8192` | Lower creativity, enough context for a large image |
| 1.9 | Configurable endpoint | ✅ | Settings → *Ollama endpoint* | Works with a remote/LAN Ollama; validates `http(s)://` and strips trailing slashes |
| 1.10 | Actionable error mapping | ✅ | `explainHttpError()` | 404 → exact `ollama pull <model>` command; "does not support images" → pick a vision model; connection refused → `ollama serve` |
| 1.11 | Auto-select a model on first run | ✅ | `refreshOllama()` | Picks the first vision-capable model, otherwise the first model |
| 1.12 | Multi-provider support (Claude, OpenAI, Gemini…) | ⬜ | — | Out of scope for v1 by design |

---

## 2. Voice input (local Whisper)

| # | Feature | Status | Where | Notes |
|---|---|---|---|---|
| 2A.1 | Push-to-talk from the global hotkey | ✅ | `askFromHotkey()` → `voice:begin` | Capture and microphone start together; the transcript is submitted automatically |
| 2A.2 | On-device transcription | ✅ | `src/main/whisper.ts` | `whisper-cli` + `ggml-base.en.bin`; the WAV is written to the temp dir and deleted straight after |
| 2A.3 | Silent utterance detection | ✅ | `voice.ts` | RMS-based VAD with an adaptive noise floor; stops 1.2 s after the last voiced frame |
| 2A.4 | Bounded recording | ✅ | `voice.ts` | 7 s to start speaking, 20 s hard cap, so a stuck mic can't record forever |
| 2A.5 | Levels shown while listening | ✅ | `#voice-meter` | Seven-bar meter driven by a CSS `--level` variable |
| 2A.6 | One-time model download | ✅ | `ensureModel()` | 141 MB from Hugging Face into `userData/models`, with progress events; warmed in the background at launch |
| 2A.7 | Quiet-mic handling | ✅ | `normalize()` | Peak-normalises before transcription when the signal is below full scale |
| 2A.8 | Mic button beside the composer | ✅ | `#btn-voice` | Same code path as the hotkey, for clicking instead of speaking a shortcut |
| 2A.9 | Cancel with `Esc` | ✅ | `AbortController` | Stops the stream and closes the audio context without submitting |
| 2A.10 | Cloud speech providers | ⬜ | — | Deliberately local-only; the Python prototype had Deepgram/OpenAI fallbacks |

---

## 3. Screen understanding

| # | Feature | Status | Where | Notes |
|---|---|---|---|---|
| 2.1 | Capture the display under the cursor | ✅ | `captureScreen()` | `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` |
| 2.2 | Multi-monitor awareness | ✅ | `capture.ts` | Picks the matching `desktopCapturer` source via `display_id` |
| 2.3 | High-DPI correct capture | ✅ | `capture.ts` | Requests `display.size × scaleFactor` physical pixels |
| 2.4 | Downscale before upload | ✅ | `nativeImage.resize()` | 1280 px longest edge by default; JPEG quality 82 |
| 2.5 | Configurable image size | ✅ | Settings → *Screenshot size* | 1024 / 1280 / 1600 px presets, clamped 640–2560 |
| 2.6 | Cursor position passed to the model | ✅ | `prompt.ts` | Normalised to 0–1 and described as "% from left/top", so the model can say "the button under your cursor" |
| 2.7 | Screenshot preview in the panel | ✅ | `#screen-card` | Shows display label, timestamp, and a *Recapture* button |
| 2.8 | Screenshot reuse for follow-ups | ✅ | `lastCapture` | One capture can back several questions; *Recapture* refreshes it |
| 2.9 | macOS screen-capture permission handling | ✅ | `screenAccessState()` | Never gates on the unreliable `denied` status — a capture attempt is what registers the app with TCC and triggers the system prompt; `restricted` (MDM) is the only hard stop |
| 2.10 | Empty-capture detection | ✅ | `capture.ts` | Treats a blank `NativeImage` as a permission problem instead of sending a black screenshot |
| 2.11 | OCR / pixel-coordinate pointing | ⬜ | — | Needs the overlay milestone below |
| 2.12 | Window-only capture | ⬜ | — | v1 always captures the whole display |
| 2.13 | REX never appears in its own screenshots | ✅ | `captureExcludingPanel()` | The panel is faded to fully transparent for the grab and restored afterwards, so the model is never asked about REX's own chat UI |

---

## 4. Invocation and hotkey

| # | Feature | Status | Where | Notes |
|---|---|---|---|---|
| 4.1 | System-wide global hotkey | ✅ | `hotkey.ts` | `globalShortcut`, works while another app is focused |
| 4.2 | Fully configurable shortcut | ✅ | Settings → *Global hotkey* | Click, then press the combination |
| 4.3 | Modifier validation | ✅ | `acceleratorFromEvent()` | Requires ≥1 modifier, or a bare F1–F24 |
| 4.4 | Conflict detection | ✅ | `HotkeyManager.register()` | Reports when the OS refuses the registration |
| 4.5 | Automatic rollback | ✅ | `commitHotkey()` | A rejected shortcut reverts to the last working one — never leaves the app unreachable |
| 4.6 | Persisted across restarts | ✅ | `settings.json` | Restored and re-registered on launch |
| 4.7 | Startup failure surfaced in UI | ✅ | `renderHotkey()` | Warning banner with a pointer to Settings |
| 4.8 | Tray-menu trigger | ✅ | `askFromHotkey()` | *Ask about my screen* does the same thing without the keyboard |
| 4.9 | Hold-to-talk / push-to-talk | ⬜ | — | `globalShortcut` has no key-up event; needs a native key hook |

**Default:** `CommandOrControl+Shift+Space` → `⌘⇧Space` on macOS, `Ctrl+Shift+Space` on Windows.

---

## 5. Panel and conversation UX

| # | Feature | Status | Where | Notes |
|---|---|---|---|---|
| 5.1 | Frameless floating panel | ✅ | `createPanel()` | 480×680, resizable, draggable title bar |
| 5.2 | Always-on-top mode | ✅ | Settings → toggle | `floating` level on macOS |
| 5.3 | Tray-resident app | ✅ | `buildTray()` | Closing the panel hides it; the app keeps running |
| 5.4 | Tray icon generated at runtime | ✅ | `makeTrayIcon()` | No binary assets; BGRA bitmap drawn in code |
| 5.5 | Auto-ask on hotkey | ✅ | `subscribe()` | Captures with the panel hidden, then opens the panel and asks *"Describe what is on my screen…"* immediately |
| 5.6 | Free-text follow-up questions | ✅ | Composer | `Enter` sends, `Shift+Enter` newlines |
| 5.7 | Conversation context | ⚠️ | `history.slice(-8)` | Last 8 turns of text; the image is attached only to the current turn |
| 5.8 | Streaming answer bubble with caret | ✅ | `handleToken()` | Text appears as the model produces it |
| 5.9 | Stop generation | ✅ | Stop button / `Esc` | Leaves the partial answer visible and marked cancelled |
| 5.10 | Error states in-thread | ✅ | `handleError()` | Failed answers render as an error bubble instead of a blank panel |
| 5.11 | Toasts for transient feedback | ✅ | `toast()` | Hotkey changes, capture errors, validation |
| 5.12 | Setup card when Ollama is down | ✅ | `#ollama-help` | Install → start → pull, with a *Check again* button |
| 5.13 | Persisted conversation history | ⬜ | — | Cleared when the app quits |
| 5.14 | Markdown / code rendering | ⬜ | — | Answers render as plain text |
| 5.15 | Cursor companion + pointing animation | ⬜ | — | The next milestone |
| 5.16 | Fresh chat when the hotkey reopens the panel | ✅ | `askFromHotkey()` / `clearChat()` | Hidden panel → new conversation and a new screenshot; panel already on screen → the running transcript is left untouched. Also available any time via **＋** / **⌘N** |

---

## 6. Configuration

| # | Feature | Status | Notes |
|---|---|---|---|
| 6.1 | JSON settings file | ✅ | macOS `~/Library/Application Support/REX/settings.json` · Windows `%APPDATA%\REX\settings.json` |
| 6.2 | Corrupt-file resilience | ✅ | Bad JSON falls back to defaults instead of crashing |
| 6.3 | Input sanitising | ✅ | Endpoint scheme check, numeric clamping, empty-model handling |
| 6.4 | Settings written on every change | ✅ | No explicit *Save* button |
| 6.5 | Reset hotkey to default | ✅ | *Reset* in the hotkey row |
| 6.6 | Environment-variable config | ⬜ | Everything is in the settings file |

| Key | Default | Purpose |
|---|---|---|
| `hotkey` | `CommandOrControl+Shift+Space` | Global accelerator |
| `endpoint` | `http://127.0.0.1:11434` | Ollama base URL |
| `model` | auto-picked | Model tag used for answers |
| `alwaysOnTop` | `true` | Panel stays above other windows |
| `maxImageWidth` | `1280` | Longest edge of the image sent to the model |

---

## 7. Privacy and security

| # | Feature | Status | Notes |
|---|---|---|---|
| 7.1 | Screenshots never leave the machine | ✅ | Only `fetch` target is the configured Ollama endpoint |
| 7.2 | Renderer sandboxing | ✅ | `contextIsolation: true`, `nodeIntegration: false` |
| 7.3 | Minimal preload bridge | ✅ | Only the `window.rex` methods in `shared/types.ts` are exposed |
| 7.4 | Content-Security-Policy | ✅ | No remote scripts, no `eval`, `object-src 'none'` |
| 7.5 | External links open in the browser | ✅ | `setWindowOpenHandler` → `shell.openExternal`, window creation denied |
| 7.6 | Single instance | ✅ | Second launch focuses the existing panel |
| 7.7 | No telemetry / analytics | ✅ | Nothing phones home |

---

## 8. Cross-platform

| # | Feature | Status | Notes |
|---|---|---|---|
| 8.1 | macOS (Apple Silicon + Intel) | ✅ | DMG targets `arm64` and `x64` |
| 8.2 | Windows (x64) | ✅ | NSIS installer target |
| 8.3 | One codebase, no platform forks | ✅ | Platform differences isolated to capture permissions, always-on-top level, tray template icon and the app menu |
| 8.4 | macOS menu bar with standard Edit roles | ✅ | Keeps ⌘C/⌘V/⌘Q working |
| 8.5 | Windows/Linux menu removed | ✅ | Tray-only UX |
| 8.6 | Linux | ⬜ | Not targeted; capture/global shortcut paths would need testing |
| 8.7 | Code signing / notarisation | ⬜ | Unsigned builds: macOS needs right-click → Open, Windows shows SmartScreen |

---

## 9. Developer experience

| # | Feature | Status | Notes |
|---|---|---|---|
| 9.1 | TypeScript, strict mode | ✅ | Separate configs for main/preload and renderer |
| 9.2 | `npm run typecheck` | ✅ | Checks both halves independently |
| 9.3 | Hot-reload dev server | ✅ | `npm run dev` (electron-vite + Vite 8) |
| 9.4 | Production build | ✅ | `npm run build` → `out/` (~68 KB of code) |
| 9.5 | Installers | ✅ | `npm run dist` → `release/` |
| 9.6 | Zero runtime dependencies | ✅ | Uses Electron built-ins only (`desktopCapturer`, `nativeImage`, `fetch`, `globalShortcut`) |
| 9.7 | Automated tests | ⬜ | Manual/CDP smoke checks only so far |

---

## 10. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘⇧Space` / `Ctrl+Shift+Space` | Capture screen and ask REX (configurable) |
| `Enter` | Send the typed question |
| `Enter` on an empty box | Send the default "describe my screen" prompt |
| `Shift+Enter` | New line |
| `Esc` | Cancel the current answer · close Settings · hide the panel (in that order) |
| `⌘,` / `Ctrl+,` | Open Settings |
| `⌘Q` / `Alt+F4` | Quit (tray menu also has Quit) |

---

## 11. Not in v1

- **Cursor overlay / pointing** — flying to and highlighting the element the model identifies
- **Spoken answers** — text-to-speech playback of the model's reply (input is already voice)
- **Persistence** — saved conversations and per-app memory
- **Better targeting** — window-only capture, OCR, UI-automation element lookup
- **Distribution** — auto-update, signed builds, crash reporting
- **Cloud models** — Claude / OpenAI / Gemini providers
