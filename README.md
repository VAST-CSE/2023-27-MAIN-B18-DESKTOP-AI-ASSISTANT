# REX

A lightweight, cross-platform desktop companion: press a hotkey, **speak** a question about
whatever is on your screen, and a local vision model answers.

Everything stays on the machine — the screenshot goes to a local Ollama server and the voice is
transcribed by whisper.cpp. No cloud, no API keys, no telemetry.

- **Local LLM** — Ollama, any vision-capable model (`qwen2.5vl:3b` recommended)
- **Local speech** — whisper.cpp with `ggml-base.en.bin`, fully offline
- **Screen aware** — captures the display under the cursor and downscales it before sending
- **Hands free** — the hotkey starts both the capture and the microphone; recording stops on its own
- **Zero runtime npm dependencies** — Electron plus dev-only tooling
- **macOS and Windows** — one codebase, two builds

The feature-by-feature breakdown lives in [features.md](features.md).

---

## Requirements

- **Node.js 20+**
- **Ollama** running locally
- **A vision-capable model**, for example `qwen2.5vl:3b`, `llava:7b`, `gemma3:4b` or `moondream`
- **whisper.cpp** for voice — macOS: `brew install whisper-cpp`; Windows: put `whisper-cli.exe` on `PATH`
- **macOS**: screen-recording and microphone permission (asked on first use)
- **Windows**: nothing extra

The speech model (`ggml-base.en.bin`, 141 MB) downloads once into the app's data folder and is
reused offline afterwards.

---

## Quick start

```bash
git clone https://github.com/VAST-CSE/2023-27-MAIN-B18-DESKTOP-AI-ASSISTANT.git
cd 2023-27-MAIN-B18-DESKTOP-AI-ASSISTANT
npm install
npm run dev
```

If Electron's binary download was skipped by npm's script gating, run it once manually:

```bash
node node_modules/electron/install.js
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Hot-reloading dev server (electron-vite + Vite 8) |
| `npm run build` | Production bundle into `out/` |
| `npm run preview` | Run the production bundle locally |
| `npm run typecheck` | Type-check `main`/`preload` and `renderer` separately |
| `npm run package` | Build and ad-hoc sign `release/mac-arm64/REX.app` |
| `npm run dist` | Build installers into `release/` (DMG on macOS, NSIS on Windows) |
| `npm run start:app` | Launch the packaged macOS app in the background |

### Ollama

```bash
# macOS
brew install ollama

# any platform, once installed
ollama serve
ollama pull qwen2.5vl:3b
```

REX detects Ollama automatically. If it isn't reachable, the panel shows the three commands
above and a **Check again** button.

### Voice engine

```bash
brew install whisper-cpp      # macOS
```

The app looks for `whisper-cli` in `<App>/Contents/Resources/whisper/`, `/opt/homebrew/bin`,
`/usr/local/bin` and `PATH`. The model is downloaded automatically the first time it is needed —
there is nothing to fetch by hand.

---

## Using it

| Action | Result |
|---|---|
| **⌘⇧Space** (macOS) / **Ctrl+Shift+Space** (Windows) | Capture the screen, start listening, transcribe, then answer |
| **＋** in the title bar / **⌘N** | Clear the conversation and screenshot, then start a new chat |
| **🎤** button in the composer | Start listening without the hotkey |
| Speak, then pause | Recording stops ~1.2 s after you stop talking and submits automatically |
| Type + **Enter** | Ask a follow-up about the same screenshot |
| **Esc** while listening | Cancel the recording |
| **Esc** otherwise | Cancel the answer · close Settings · hide the panel |
| **⌘,** / **Ctrl+,** | Open Settings |
| Tray icon | Show/hide the panel, run a capture, open Settings, quit |

The hotkey is configurable: open Settings, click the shortcut field and press the combination you
want. A bare **F1–F24** key is allowed; combinations need at least one modifier.

### First run on macOS

The first capture triggers a permission prompt. If you dismissed it, macOS 15+ calls the pane
**Screen & System Audio Recording** (older versions: *Screen Recording*). There is no “+” button —
macOS adds apps itself, so enable **REX** (or **Electron** when running `npm run dev`) in
that list, then fully quit and relaunch the app.

Voice needs the same treatment for **Microphone**. The linker-signed Electron binary used by
`npm run dev` cannot be granted TCC permissions on macOS 15, so use the packaged app for voice.

---

## Packaging

```bash
npm run package
codesign --force --deep --sign - "release/mac-arm64/REX.app"
cp -R "release/mac-arm64/REX.app" /Applications/
```

The ad-hoc signature binds `Info.plist` and the resources, which is what lets macOS register
**REX** for screen capture and microphone access. Without it, permission prompts never
appear and recording silently fails.

### Launching on macOS

`electron-builder` produces an unsigned bundle and we sign it ad-hoc, which macOS 15's
LaunchServices sometimes refuses to start (Electron logs
`codesign_util.cc:79 task_name_for_pid: (os/kern) failure (5)` and exits). Double-click
**`Start REX.command`** in this folder instead — it execs the binary directly:

```bash
./Start\ REX.command
```

`npm run start:app` does the same thing. The app lives in the menu bar, so once it is running you
can close the panel and it keeps listening for the hotkey.

---

## How it works

```
hotkey ──▶ capture screen (display under cursor, ≤1280 px JPEG)
       └─▶ microphone ─▶ VAD trims silence ─▶ whisper-cli ─▶ transcript
                                                              │
                                         transcript + screenshot
                                                              ▼
                                              Ollama /api/chat (stream)
                                                              ▼
                                                   token stream in the panel
```

- `src/main` — window, tray, global shortcut, screen capture, Ollama client, settings, Whisper
- `src/preload` — the typed IPC bridge exposed as `window.rex`
- `src/renderer` — the panel UI, streaming renderer, settings drawer, microphone capture
- `src/shared` — types shared by all three processes

```
REX/
├── src/
│   ├── main/        Electron main process (window, tray, hotkey, capture, Ollama, whisper)
│   ├── preload/     context-isolated IPC bridge
│   ├── renderer/    panel UI, styles, voice recording
│   └── shared/      types used across processes
├── build/           macOS entitlements (committed on purpose)
├── out/             generated by `npm run build`
├── release/         generated by `npm run package` / `npm run dist`
├── electron-builder.yml
└── electron.vite.config.ts
```

Screenshots are downscaled with `nativeImage` and sent as base64 JPEG. The voice recording is
written to a temp WAV, handed to `whisper-cli`, and deleted as soon as the transcript is parsed.
Nothing is written outside the app's data folder and the system temp directory.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Global hotkey | `⌘⇧Space` | Any Electron accelerator, or a bare F-key |
| Ollama endpoint | `http://127.0.0.1:11434` | Point at another machine if you like |
| Model | first vision model found | Detection is automatic; refresh with **Check again** |
| Always on top | on | The panel floats over other windows |
| Max image width | 1280 px | Smaller is faster and cheaper |
| Voice input | on | Turning it off makes the hotkey fall back to the keyboard |

Settings live in `~/Library/Application Support/REX/settings.json`
(`%APPDATA%\REX` on Windows).

---

## Troubleshooting

**“Ollama is offline”** — start the server (`ollama serve`), then press **Check again**. A model
that is not pulled yet shows as `not pulled`; run `ollama pull qwen2.5vl:3b`.

**The first answer takes ~15 s** — the model is loading into memory. It is sub-second after that.
`ollama ps` shows what is resident; models unload after five idle minutes by default.

**Hotkey does nothing** — another app owns that combination, or macOS withheld it. Open Settings,
re-record the shortcut; the app reports when the OS refuses a registration and rolls back to the
last working one.

**“Could not capture the screen”** — grant screen recording in *Privacy & Security → Screen & System
Audio Recording*, then relaunch. macOS caches the decision per launch.

**“whisper.cpp is not installed”** — voice needs the local engine: `brew install whisper-cpp` on
macOS. The binary is looked up at `<App>/Contents/Resources/whisper/`, `/opt/homebrew/bin`,
`/usr/local/bin` and `PATH`.

**Voice records nothing (macOS)** — grant microphone access to REX in
*Privacy & Security → Microphone*, then relaunch. Echo cancellation is disabled on purpose: the app
plays no audio, and AEC was ducking the speaker's own voice.

**First transcription is slow** — the first `whisper-cli` run compiles Metal kernels (~17 s). Every
run after that takes about half a second for a few seconds of audio.

**`npm install` fails with `EACCES` on `~/.npm`** — the npm cache has root-owned files:

```bash
sudo chown -R "$(id -u):$(id -g)" ~/.npm
```

---

## Privacy

- Screenshots are sent only to the Ollama endpoint you configure (localhost by default).
- Audio never leaves the machine; transcription runs in `whisper-cli`.
- No analytics, no auto-update, no network calls other than Ollama and the one-time model
  download from Hugging Face.
- Everything the app stores lives in its own application-support folder.

---

## Not in v1

- Cursor overlay that points at the element the model identifies
- Spoken answers (text-to-speech)
- Saved conversations and per-app memory
- Window-only capture, OCR, UI-automation lookup
- Signed installers, auto-update, crash reporting
- Cloud model providers

---

## License

MIT
