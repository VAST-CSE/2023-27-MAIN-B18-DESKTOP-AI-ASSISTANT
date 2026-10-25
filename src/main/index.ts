import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, systemPreferences, Tray } from 'electron'
import { join } from 'node:path'
import { captureScreen, type CaptureResult } from './capture'
import { hotkeys } from './hotkey'
import { chat, checkOllama, listModels } from './ollama'
import { buildSystemPrompt } from './prompt'
import { getSettings, updateSettings } from './settings'
import { ensureModel, transcribe, voiceStatus } from './whisper'
import type {
  AskRequest,
  Bootstrap,
  HotkeyState,
  OllamaStatus,
  SaveResult,
  ScreenShotInfo,
  Settings
} from '../shared/types'

app.setName('REX')
if (process.platform === 'win32') app.setAppUserModelId('com.rex.app')

// Allow AudioContext to run without a direct user gesture inside the webview,
// which is essential when voice recording is triggered by a global system hotkey.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const isDev = !app.isPackaged
const rendererUrl = process.env.ELECTRON_RENDERER_URL

let panel: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let isCapturing = false
let lastCapture: CaptureResult | null = null
const inflight = new Map<string, AbortController>()

/** Time the compositor needs to drop the panel from the next frame it captures. */
const PANEL_SETTLE_MS = 120

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function settings(): Settings {
  return getSettings()
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Request cancelled.'
    return error.message
  }
  return String(error)
}

/** Sends to the panel, waiting for the first paint if the window is still loading. */
function send(channel: string, payload: unknown): void {
  const win = panel
  if (!win || win.isDestroyed()) return

  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    })
    return
  }

  win.webContents.send(channel, payload)
}

function showPanel(focus = true): BrowserWindow | null {
  if (!panel || panel.isDestroyed()) return null
  if (panel.isMinimized()) panel.restore()
  if (process.platform === 'darwin') {
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  panel.show()
  if (focus) panel.focus()
  return panel
}

function togglePanel(): void {
  if (!panel) return
  if (panel.isVisible() && panel.isFocused()) panel.hide()
  else showPanel()
}

/**
 * Captures the screen with REX's own panel left out of the picture.
 *
 * A plain `desktopCapturer` grab photographs every window on the display,
 * including this always-on-top panel, so the model would be asked about a
 * screenshot of its own chat UI. Hiding the panel outright would steal focus
 * and make the app flicker, so the window is made fully transparent for the
 * two frames it takes to composite the capture and then restored. Content
 * protection (`setContentProtection`) is deliberately not used: it would also
 * hide the panel from the user's own screenshots and screen recordings.
 */
async function captureExcludingPanel(source: 'hotkey' | 'manual'): Promise<CaptureResult> {
  const win = panel && !panel.isDestroyed() ? panel : null
  const wasVisible = Boolean(win?.isVisible())

  if (win && wasVisible) {
    win.setOpacity(0)
    await delay(PANEL_SETTLE_MS)
  }

  try {
    const maxWidth = settings().maxImageWidth
    return await captureScreen(maxWidth, source)
  } finally {
    if (win && wasVisible && !win.isDestroyed()) {
      win.setOpacity(1)
    }
  }
}

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 380,
    minHeight: 460,
    show: false,
    frame: false,
    resizable: true,
    fullscreenable: false,
    backgroundColor: '#0a0d14',
    title: 'REX',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  if (process.platform === 'darwin') {
    win.setAlwaysOnTop(settings().alwaysOnTop, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    win.setAlwaysOnTop(settings().alwaysOnTop)
  }

  win.on('close', (event) => {
    // Closing the panel just hides it; quitting happens through the tray.
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('show', refreshTrayMenu)
  win.on('hide', refreshTrayMenu)
  win.once('ready-to-show', () => showPanel())

  win.webContents.on('console-message', (_event, _level, message) => {
    console.info('[renderer]', message)
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer] load failed (${code}): ${description} — ${url}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function makeTrayIcon(): Electron.NativeImage {
  // Drawn at runtime so the project has no binary assets to keep in sync.
  const size = 22
  const buffer = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  const radius = size / 2 - 1.5

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre)
      const coverage = distance <= radius ? 1 : Math.max(0, radius + 1 - distance)
      const offset = (y * size + x) * 4
      // createFromBitmap expects BGRA.
      buffer[offset] = 0xff
      buffer[offset + 1] = 0x8f
      buffer[offset + 2] = 0x5b
      buffer[offset + 3] = Math.round(255 * Math.min(1, coverage))
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size })
  if (process.platform === 'darwin') image.setTemplateImage(false)
  return image
}

function prettyAccelerator(accelerator: string): string {
  if (!accelerator) return 'not set'
  return accelerator
    .replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace('Command', process.platform === 'darwin' ? 'Cmd' : 'Super')
    .replace(/\+/g, ' + ')
}

function refreshTrayMenu(): void {
  if (!tray) return

  const visible = Boolean(panel?.isVisible())
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: visible ? 'Hide REX' : 'Show REX',
      click: () => togglePanel()
    },
    {
      label: 'Ask from Screen',
      accelerator: settings().hotkey,
      click: () => void askFromHotkey()
    },
    { type: 'separator' },
    {
      label: 'Settings…',
      accelerator: 'CommandOrControl+,',
      click: () => {
        showPanel()
        send('ui:open-settings', null)
      }
    },
    { type: 'separator' },
    {
      label: 'Quit REX',
      click: () => quit()
    }
  ]

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function buildTray(): void {
  tray = new Tray(makeTrayIcon())
  tray.setToolTip(`REX — ${prettyAccelerator(settings().hotkey)}`)
  if (process.platform === 'darwin') tray.setTitle('REX')
  tray.on('click', () => togglePanel())
  refreshTrayMenu()
}

function registerHotkey(accelerator: string): HotkeyState {
  const state = hotkeys.register(accelerator, () => {
    console.info(`[hotkey] triggered: ${accelerator}`)
    void askFromHotkey()
  })
  console.info(
    state.registered
      ? `[hotkey] registered: ${state.accelerator}`
      : `[hotkey] registration failed: ${state.error ?? 'unknown error'}`
  )
  return state
}

async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true

  let status = systemPreferences.getMediaAccessStatus('microphone')
  console.info('[voice] microphone TCC status:', status)

  if (status === 'not-determined') {
    try {
      const asked = await systemPreferences.askForMediaAccess('microphone')
      console.info('[voice] askForMediaAccess →', asked)
      status = systemPreferences.getMediaAccessStatus('microphone')
    } catch (error) {
      console.warn('[voice] askForMediaAccess failed:', messageOf(error))
    }
  }

  // Chromium may still give getUserMedia a silent track when its web
  // permission handler approves access but macOS TCC has not approved this
  // signed app. Only proceed once macOS itself reports the mic as granted.
  return status === 'granted'
}

async function askFromHotkey(): Promise<void> {
  if (isCapturing) return

  const win = panel
  if (!win || win.isDestroyed()) return

  // A press that reopens a hidden panel is a new invocation, so the previous
  // transcript goes away. If the panel is already on screen the user is in the
  // middle of a conversation, so its history is left alone.
  const startingFresh = !win.isVisible()

  isCapturing = true
  try {
    if (startingFresh) {
      lastCapture = null
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
      send('chat:new', null)
    }

    send('capture:started', null)

    // Capture before the panel is revealed: REX must never end up inside the
    // screenshot it is about to ask about.
    const capture = await captureExcludingPanel('hotkey')
    lastCapture = capture
    console.info('[hotkey] captured', capture.info.width, 'x', capture.info.height)
    send('screen:captured', capture.info)

    showPanel()

    if (!settings().voiceEnabled) {
      send('focus:composer', null)
      return
    }

    if (!(await ensureMicrophoneAccess())) {
      console.warn('[hotkey] microphone refused')
      send('voice:error', {
        message:
          'Microphone access is blocked. Enable REX in System Settings → Privacy & ' +
          'Security → Microphone, then relaunch the app.'
      })
      send('focus:composer', null)
      return
    }

    send('voice:begin', null)
  } catch (error) {
    console.warn('[hotkey] failed:', messageOf(error))
    send('capture:error', { message: messageOf(error) })
    // The panel was still hidden when the capture failed, so open it now to
    // show the error instead of leaving the user with nothing.
    if (!win.isVisible()) showPanel()
  } finally {
    isCapturing = false
  }
}

async function runAsk(request: AskRequest): Promise<void> {
  const id = request.id
  const controller = new AbortController()
  inflight.set(id, controller)

  try {
    const current = settings()

    if (!current.model) {
      throw new Error('No Ollama model selected yet. Open Settings and choose a vision model.')
    }

    if (request.useScreen && !lastCapture) {
      lastCapture = await captureExcludingPanel('manual')
      send('screen:captured', lastCapture.info)
    }

    const screen = lastCapture?.info ?? null

    const answer = await chat({
      endpoint: current.endpoint,
      model: current.model,
      system: buildSystemPrompt(screen),
      history: request.history,
      prompt: request.prompt,
      imageBase64: request.useScreen ? lastCapture?.base64 : undefined,
      signal: controller.signal,
      onToken: (token) => send('ask:token', { id, token })
    })

    send('ask:done', { id, text: answer })
  } catch (error) {
    const cancelled = controller.signal.aborted
    send('ask:error', {
      id,
      cancelled,
      message: cancelled ? 'Cancelled.' : messageOf(error)
    })
  } finally {
    inflight.delete(id)
  }
}

function applyAlwaysOnTop(value: boolean): void {
  if (!panel || panel.isDestroyed()) return
  if (process.platform === 'darwin') {
    panel.setAlwaysOnTop(value, 'floating')
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    panel.setAlwaysOnTop(value)
  }
}

function quit(): void {
  isQuitting = true
  app.quit()
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', (): Bootstrap => ({
    platform: process.platform,
    settings: settings(),
    hotkey: hotkeys.current
  }))

  ipcMain.handle('settings:save', (_event, patch: Partial<Settings>): SaveResult => {
    const before = settings()
    const next = updateSettings(patch)

    // Re-register when the shortcut changed, or when a previous registration
    // failed and the user is trying to save again.
    let state = hotkeys.current
    if (next.hotkey !== before.hotkey || !state.registered) {
      state = registerHotkey(next.hotkey)
    }

    applyAlwaysOnTop(next.alwaysOnTop)
    if (tray) tray.setToolTip(`REX — ${prettyAccelerator(next.hotkey)}`)
    refreshTrayMenu()

    return { settings: next, hotkey: state }
  })

  ipcMain.handle('ollama:status', async (): Promise<OllamaStatus> => {
    const endpoint = settings().endpoint
    const health = await checkOllama(endpoint)

    if (!health.online) {
      return { ...health, models: [] }
    }

    try {
      return { ...health, models: await listModels(endpoint) }
    } catch (error) {
      return { ...health, models: [], error: messageOf(error) }
    }
  })

  ipcMain.handle('screen:capture', async (): Promise<ScreenShotInfo> => {
    const capture = await captureExcludingPanel('manual')
    lastCapture = capture
    return capture.info
  })

  ipcMain.handle('voice:status', async () => {
    const status = await voiceStatus()
    if (process.platform === 'darwin') {
      const micStatus = systemPreferences.getMediaAccessStatus('microphone')
      if (micStatus === 'denied' || micStatus === 'restricted') {
        return {
          ...status,
          ready: false,
          error:
            'Microphone access is blocked. Enable REX in System Settings → Privacy & Security → Microphone, then relaunch the app.'
        }
      }
    }
    return status
  })

  ipcMain.handle('voice:prepare', async () => {
    const micAllowed = await ensureMicrophoneAccess()
    if (!micAllowed) {
      const status = await voiceStatus()
      return {
        ...status,
        ready: false,
        error:
          'Microphone access is blocked. Enable REX in System Settings → Privacy & Security → Microphone, then relaunch the app.'
      }
    }
    // Request microphone access before any first-run model download. The
    // download can take long enough that users otherwise assume recording
    // never started, and macOS needs the permission request to happen promptly.
    await ensureModel()
    return voiceStatus()
  })

  ipcMain.handle('open:microphone-settings', () => {
    if (process.platform === 'darwin') {
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      )
    }
  })

  ipcMain.handle('voice:transcribe', async (_event, samples: Float32Array) => {
    const text = await transcribe(samples)
    return { text }
  })

  ipcMain.handle('ask', (_event, request: AskRequest) => {
    void runAsk(request)
    return { ok: true as const }
  })

  ipcMain.handle('ask:cancel', (_event, id: string) => {
    inflight.get(id)?.abort()
  })

  ipcMain.handle('window:hide', () => {
    panel?.hide()
  })

  ipcMain.handle('app:quit', () => {
    quit()
  })
}

function bootstrap(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    )
  } else {
    Menu.setApplicationMenu(null)
  }

  // Explicitly allow media permissions (microphone) for WebContents
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
      return
    }
    callback(false)
  })

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') {
      return true
    }
    return false
  })

  registerIpc()
  panel = createPanel()
  buildTray()

  const state = registerHotkey(settings().hotkey)
  if (!state.registered) {
    console.warn(`[hotkey] ${state.error ?? 'could not register the global shortcut'}`)
  }

  // Warm the speech model in the background so the first hotkey press is instant.
  if (settings().voiceEnabled) {
    setTimeout(() => {
      void ensureModel().catch((error) => {
        console.warn('[voice] speech model unavailable:', messageOf(error))
      })
    }, 3000)
  }

  // Diagnostic: `--self-test-hotkey` runs the exact hotkey pipeline shortly
  // after launch so the whole path can be checked without a real keystroke.
  if (process.argv.includes('--self-test-hotkey')) {
    console.info('[hotkey] self-test requested')
    setTimeout(() => void askFromHotkey(), 2000)
  }
}

process.on('exit', (code) => console.info(`[app] process exit: ${code}`))

if (!app.requestSingleInstanceLock()) {
  console.warn('[app] another instance owns the single-instance lock; exiting')
  app.quit()
} else {
  app.on('second-instance', () => showPanel())

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[startup] failed:', error)
    app.quit()
  })

  app.on('activate', () => {
    if (!panel) panel = createPanel()
    showPanel()
  })

  // The app lives in the tray, so closing the panel must not quit it.
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit()
  })

  app.on('before-quit', () => {
    console.info('[app] before-quit')
    isQuitting = true
    hotkeys.unregister()
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
  })

  app.on('will-quit', () => console.info('[app] will-quit'))
  app.on('window-all-closed', () => console.info('[app] all windows closed'))
}
