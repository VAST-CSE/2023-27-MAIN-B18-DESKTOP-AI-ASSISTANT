import './style.css'
import { recordUtterance, type VoicePhase } from './voice'
import type {
  AskDoneEvent,
  AskErrorEvent,
  AskTokenEvent,
  ChatTurn,
  HotkeyState,
  OllamaModel,
  ScreenShotInfo,
  Settings
} from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/types'

const DEFAULT_QUESTION = 'Describe what is on my screen and what I can do here.'

const api = window.rex

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Element #${id} is missing from index.html`)
  return node as T
}

const conversation = el<HTMLDivElement>('conversation')
const emptyState = el<HTMLDivElement>('empty-state')
const emptyHotkey = el<HTMLElement>('empty-hotkey')
const composer = el<HTMLTextAreaElement>('composer')
const askButton = el<HTMLButtonElement>('btn-ask')
const stopButton = el<HTMLButtonElement>('btn-stop')
const screenCard = el<HTMLElement>('screen-card')
const screenPreview = el<HTMLImageElement>('screen-preview')
const screenLabel = el<HTMLElement>('screen-label')
const statusDot = el<HTMLElement>('status-dot')
const statusText = el<HTMLElement>('status-text')
const hotkeyChip = el<HTMLElement>('hotkey-chip')
const banner = el<HTMLElement>('banner')
const drawer = el<HTMLElement>('drawer')
const toastEl = el<HTMLElement>('toast')
const hotkeyButton = el<HTMLButtonElement>('btn-hotkey')
const hotkeyError = el<HTMLElement>('hotkey-error')
const modelSelect = el<HTMLSelectElement>('model-select')
const endpointInput = el<HTMLInputElement>('endpoint')
const maxWidthSelect = el<HTMLSelectElement>('max-width')
const alwaysOnTopInput = el<HTMLInputElement>('always-on-top')
const ollamaHelp = el<HTMLElement>('ollama-help')
const voiceBar = el<HTMLElement>('voice-bar')
const voiceLabel = el<HTMLElement>('voice-label')
const voiceMeter = el<HTMLElement>('voice-meter')
const voiceButton = el<HTMLButtonElement>('btn-voice')
const voiceEnabledInput = el<HTMLInputElement>('voice-enabled')
const voiceStatusText = el<HTMLElement>('voice-status')

let settings: Settings = { ...DEFAULT_SETTINGS }
let hotkeyState: HotkeyState = { accelerator: '', registered: false }
let platform = 'darwin'
let models: OllamaModel[] = []
let screenInfo: ScreenShotInfo | null = null
let history: ChatTurn[] = []
let activeId: string | null = null
let currentBubble: HTMLElement | null = null
let currentText = ''
let lastPrompt = ''
let recording = false
let drawerOpen = false
let toastTimer = 0
let ollamaOnline = false
let statusKind: 'online' | 'offline' | 'checking' = 'checking'
let statusLabel = 'Checking Ollama…'
let listening = false
let voiceAbort: AbortController | null = null

// ── small helpers ───────────────────────────────────────────────────────────

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function textOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}

function prettyAccelerator(accelerator: string): string {
  if (!accelerator) return ''
  const mac = platform === 'darwin'
  const text = accelerator
    .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Command', mac ? '⌘' : 'Super')
    .replace('Control', mac ? '⌃' : 'Ctrl')
    .replace('Alt', mac ? '⌥' : 'Alt')
    .replace('Shift', mac ? '⇧' : 'Shift')

  return mac ? text.replace(/\+/g, '') : text.replace(/\+/g, ' + ')
}

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

function paintStatus(kind: 'online' | 'offline' | 'checking', label: string): void {
  statusDot.className = `status-dot ${kind}`
  statusText.textContent = label
}

function setStatus(kind: 'online' | 'offline' | 'checking', label: string): void {
  statusKind = kind
  statusLabel = label
  paintStatus(kind, label)
}

function restoreStatus(): void {
  paintStatus(statusKind, statusLabel)
}

function showBanner(message: string): void {
  banner.textContent = message
  banner.classList.remove('hidden')
}

function hideBanner(): void {
  banner.classList.add('hidden')
}

function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  toastEl.textContent = message
  toastEl.className = `toast ${kind}`
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.className = 'toast hidden'
  }, 4200)
}

function scrollToBottom(): void {
  conversation.scrollTop = conversation.scrollHeight
}

// ── conversation ─────────────────────────────────────────────────────────────

function appendMessage(role: 'user' | 'assistant', text: string): HTMLElement {
  emptyState.classList.add('hidden')

  const row = document.createElement('div')
  row.className = `msg ${role}`

  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text

  row.append(bubble)
  conversation.append(row)
  scrollToBottom()

  return bubble
}

function setBusy(busy: boolean): void {
  askButton.disabled = busy
  stopButton.classList.toggle('hidden', !busy)
  composer.placeholder = busy ? 'REX is thinking…' : 'Ask a question about your screen…'
}

function resetRun(): void {
  activeId = null
  currentBubble = null
  currentText = ''
  setBusy(false)
}

/**
 * Drops the transcript, the screenshot and any in-flight answer, leaving the
 * panel in the same state as a first launch.
 */
function clearChat(): void {
  if (activeId) void api.cancel(activeId)
  if (listening) cancelVoice()

  history = []
  lastPrompt = ''
  screenInfo = null

  for (const node of conversation.querySelectorAll('.msg')) node.remove()
  emptyState.classList.remove('hidden')
  screenPreview.removeAttribute('src')
  screenCard.classList.add('hidden')

  composer.value = ''
  autosize()
  resetRun()
}

function applyScreen(info: ScreenShotInfo): void {
  screenInfo = info
  screenPreview.src = info.dataUrl
  const time = new Date(info.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  screenLabel.textContent = `${info.displayLabel} · ${time}`
  screenCard.classList.remove('hidden')
  emptyState.classList.add('hidden')
  restoreStatus()
}

async function recapture(reportError = true): Promise<boolean> {
  try {
    applyScreen(await api.capture())
    return true
  } catch (error) {
    if (reportError) toast(textOf(error), 'error')
    return false
  }
}

async function ask(prompt: string): Promise<void> {
  const text = prompt.trim()
  if (!text || activeId) return

  if (!settings.model) {
    openDrawer()
    toast('Choose an Ollama model first.', 'error')
    return
  }

  if (!screenInfo) {
    const captured = await recapture()
    if (!captured) return
  }

  appendMessage('user', text)
  const bubble = appendMessage('assistant', '')
  bubble.classList.add('streaming')

  currentBubble = bubble
  currentText = ''
  lastPrompt = text
  activeId = newId()
  setBusy(true)

  try {
    await api.ask({
      id: activeId,
      prompt: text,
      history: history.slice(-8),
      useScreen: Boolean(screenInfo)
    })
  } catch (error) {
    if (currentBubble) {
      currentBubble.classList.remove('streaming')
      currentBubble.classList.add('error')
      currentBubble.textContent = textOf(error)
    }
    resetRun()
  }
}

function submit(): void {
  if (activeId) return
  const text = composer.value.trim()
  composer.value = ''
  autosize()
  void ask(text || DEFAULT_QUESTION)
}

function autosize(): void {
  composer.style.height = 'auto'
  composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`
}

// ── voice ───────────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<VoicePhase, string> = {
  starting: 'Starting microphone…',
  listening: 'Listening…',
  speech: 'Hearing you…',
  finishing: 'Transcribing…'
}

function setVoiceLevel(level: number): void {
  voiceMeter.style.setProperty('--level', String(level))
}

function setVoicePhase(phase: VoicePhase): void {
  voiceLabel.textContent = PHASE_LABEL[phase]
  voiceBar.dataset.phase = phase
}

function showVoiceBar(phase: VoicePhase = 'starting'): void {
  voiceBar.classList.remove('hidden')
  setVoiceLevel(0)
  setVoicePhase(phase)
}

function hideVoiceBar(): void {
  voiceBar.classList.add('hidden')
  setVoiceLevel(0)
}

function cancelVoice(): void {
  voiceAbort?.abort()
}

async function startVoice(): Promise<void> {
  if (listening || activeId) return

  if (!settings.voiceEnabled) {
    composer.focus()
    return
  }

  listening = true
  voiceAbort = new AbortController()
  voiceButton.classList.add('active')
  showVoiceBar()

  try {
    const status = await api.prepareVoice()
    if (!status.ready) {
      toast(status.error ?? 'The speech engine is not ready yet.', 'error')
      openDrawer()
      return
    }

    const { samples, durationMs, peakRms } = await recordUtterance({
      signal: voiceAbort.signal,
      onPhase: setVoicePhase,
      onLevel: setVoiceLevel
    })

    if (samples.length < 1600) {
      toast(
        peakRms < 0.0005
          ? 'No microphone signal was detected. Check the selected input device and microphone permission.'
          : 'Audio reached the microphone, but speech was too quiet to detect. Move closer and try again.',
        'info'
      )
      composer.focus()
      return
    }

    setVoicePhase('finishing')
    const startedAt = performance.now()
    const { text } = await api.transcribe(samples)
    console.info(
      `[voice] ${durationMs}ms audio → ${Math.round(performance.now() - startedAt)}ms transcription`
    )

    const clean = text.trim()
    if (!clean) {
      toast('Didn’t catch that — try speaking a little closer to the mic.', 'info')
      composer.focus()
      return
    }

    composer.value = clean
    autosize()
    submit()
  } catch (error) {
    const message = textOf(error)
    if (
      (error instanceof DOMException && error.name === 'NotAllowedError') ||
      /permission|notallowed/i.test(message)
    ) {
      toast(
        'Microphone access is blocked. Enable REX in System Settings → Privacy & ' +
          'Security → Microphone, then relaunch the app.',
        'error'
      )
      void api.openMicrophoneSettings()
      openDrawer()
    } else if (!/cancel/i.test(message)) {
      toast(message, 'error')
    }
    composer.focus()
  } finally {
    listening = false
    voiceAbort = null
    voiceButton.classList.remove('active')
    hideVoiceBar()
  }
}

async function refreshVoiceStatus(): Promise<void> {
  try {
    const status = await api.voiceStatus()
    if (status.ready) {
      const size = (status.modelBytes / 1024 / 1024).toFixed(0)
      voiceStatusText.textContent = `whisper.cpp ready · ${size} MB model · fully offline`
    } else if (status.error) {
      voiceStatusText.textContent = status.error
    } else if (!status.binaryPath) {
      voiceStatusText.textContent = 'whisper.cpp was not found.'
    } else {
      voiceStatusText.textContent =
        'Speech model downloads on first use (141 MB). Until then the hotkey falls back to typing.'
    }
  } catch (error) {
    voiceStatusText.textContent = textOf(error)
  }
}

// ── streaming handlers ───────────────────────────────────────────────────────

function handleToken({ id, token }: AskTokenEvent): void {
  if (id !== activeId || !currentBubble) return
  currentText += token
  currentBubble.textContent = currentText
  scrollToBottom()
}

function handleDone({ id, text }: AskDoneEvent): void {
  if (id !== activeId) return

  const finalText = text || currentText || '(no answer)'
  if (currentBubble) {
    currentBubble.classList.remove('streaming')
    currentBubble.textContent = finalText
  }

  history.push({ role: 'user', content: lastPrompt }, { role: 'assistant', content: finalText })
  resetRun()
}

function handleError({ id, message, cancelled }: AskErrorEvent): void {
  if (id !== activeId) return

  if (currentBubble) {
    currentBubble.classList.remove('streaming')
    if (cancelled) {
      currentBubble.classList.add('cancelled')
      currentBubble.textContent = currentText ? `${currentText}\n\n[cancelled]` : 'Cancelled.'
    } else {
      currentBubble.classList.add('error')
      currentBubble.textContent = message
    }
  } else if (!cancelled) {
    toast(message, 'error')
  }

  resetRun()
}

// ── drawer and settings ──────────────────────────────────────────────────────

function openDrawer(): void {
  drawerOpen = true
  drawer.classList.remove('hidden')
  void refreshOllama()
  void refreshVoiceStatus()
}

function closeDrawer(): void {
  drawerOpen = false
  drawer.classList.add('hidden')
}

function fillSettings(): void {
  endpointInput.value = settings.endpoint
  maxWidthSelect.value = String(settings.maxImageWidth)
  alwaysOnTopInput.checked = settings.alwaysOnTop
  voiceEnabledInput.checked = settings.voiceEnabled
}

function renderHotkey(state: HotkeyState): void {
  hotkeyState = state
  const label = prettyAccelerator(state.accelerator)
  hotkeyButton.textContent = label || 'Click to set shortcut'
  emptyHotkey.textContent = label
  hotkeyChip.textContent = label
  hotkeyChip.classList.toggle('hidden', !label)

  if (state.registered) {
    hotkeyError.classList.add('hidden')
    hotkeyError.textContent = ''
  } else {
    hotkeyError.classList.remove('hidden')
    hotkeyError.textContent = state.error ?? 'Hotkey not registered'
  }
}

function populateModels(): void {
  modelSelect.innerHTML = ''

  if (models.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = ollamaOnline ? 'No models installed' : 'Ollama offline'
    modelSelect.append(opt)
    modelSelect.disabled = true
    return
  }

  modelSelect.disabled = false
  for (const m of models) {
    const opt = document.createElement('option')
    opt.value = m.name
    const size = formatBytes(m.sizeBytes)
    const vision = m.vision ? '👁 ' : ''
    opt.textContent = `${vision}${m.name}${size ? ` (${size})` : ''}`
    if (m.name === settings.model) opt.selected = true
    modelSelect.append(opt)
  }

  if (!settings.model && models.length > 0) {
    const preferred = models.find((m) => m.vision) ?? models[0]
    modelSelect.value = preferred.name
    void persist({ model: preferred.name })
  }
}

async function persist(patch: Partial<Settings>): Promise<void> {
  try {
    const res = await api.saveSettings(patch)
    settings = res.settings
    renderHotkey(res.hotkey)
    fillSettings()
  } catch (error) {
    toast(textOf(error), 'error')
  }
}

async function refreshOllama(): Promise<void> {
  setStatus('checking', 'Checking Ollama…')
  try {
    const res = await api.ollamaStatus()
    ollamaOnline = res.online
    models = res.models

    if (!res.online) {
      setStatus('offline', 'Ollama is offline')
      ollamaHelp.classList.remove('hidden')
      showBanner('Ollama is not reachable. Run: ollama serve')
    } else {
      const count = models.length
      setStatus('online', `Ollama ${res.version ?? 'ready'} · ${count} model${count === 1 ? '' : 's'}`)
      ollamaHelp.classList.add('hidden')
      hideBanner()
    }

    populateModels()
  } catch (error) {
    ollamaOnline = false
    setStatus('offline', 'Ollama offline')
    showBanner(`Could not reach Ollama: ${textOf(error)}`)
    ollamaHelp.classList.remove('hidden')
    populateModels()
  }
}

// ── key recorder ─────────────────────────────────────────────────────────────

const MODIFIER_NAMES: Record<string, string> = {
  Meta: 'CommandOrControl',
  Control: 'Control',
  Alt: 'Alt',
  Shift: 'Shift'
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Equal: '=',
  Minus: '-',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.'
}

function recordKey(event: KeyboardEvent): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null

  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const code = event.code
  let main = KEY_ALIASES[code] ?? KEY_ALIASES[event.key]

  if (!main) {
    if (/^Key[A-Z]$/.test(code)) main = code.replace('Key', '')
    else if (/^Digit[0-9]$/.test(code)) main = code.replace('Digit', '')
    else if (/^F[1-9][0-9]?$/.test(code)) main = code
    else if (event.key.length === 1) main = event.key.toUpperCase()
    else main = event.key
  }

  // Standalone F-keys are fine on their own; everything else needs a modifier.
  if (parts.length === 0 && !/^F[1-9][0-9]?$/.test(main)) return null

  parts.push(main)
  return parts.join('+')
}

// ── UI wiring ────────────────────────────────────────────────────────────────

function wire(): void {
  const newChatBtn = document.getElementById('btn-new-chat') || document.getElementById('btn-clear')
  newChatBtn?.addEventListener('click', clearChat)

  const settingsBtn = document.getElementById('btn-settings')
  settingsBtn?.addEventListener('click', () => {
    if (drawerOpen) closeDrawer()
    else openDrawer()
  })

  const closeSettingsBtn = document.getElementById('btn-close-settings') || document.getElementById('btn-drawer-close')
  closeSettingsBtn?.addEventListener('click', closeDrawer)

  const hideBtn = document.getElementById('btn-hide')
  hideBtn?.addEventListener('click', () => void api.hide())

  const retryBtn = document.getElementById('btn-retry') || document.getElementById('btn-retry-ollama')
  retryBtn?.addEventListener('click', () => void refreshOllama())

  const helpRetryBtn = document.getElementById('btn-help-retry')
  helpRetryBtn?.addEventListener('click', () => void refreshOllama())

  const recaptureBtn = document.getElementById('btn-recapture')
  recaptureBtn?.addEventListener('click', () => void recapture())

  const modelsRefreshBtn = document.getElementById('btn-models-refresh')
  modelsRefreshBtn?.addEventListener('click', () => void refreshOllama())

  const hotkeyResetBtn = document.getElementById('btn-hotkey-reset')
  hotkeyResetBtn?.addEventListener('click', () => void persist({ hotkey: DEFAULT_SETTINGS.hotkey }))

  const quitBtn = document.getElementById('btn-quit')
  quitBtn?.addEventListener('click', () => void api.quit())

  askButton.addEventListener('click', submit)
  stopButton.addEventListener('click', () => {
    if (activeId) void api.cancel(activeId)
  })

  screenCard.addEventListener('click', () => void recapture())

  hotkeyButton.addEventListener('click', () => {
    recording = true
    hotkeyButton.textContent = 'Press combination…'
    hotkeyButton.classList.add('recording')

    const handler = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        recording = false
        window.removeEventListener('keydown', handler, true)
        hotkeyButton.classList.remove('recording')
        renderHotkey(hotkeyState)
        return
      }

      const accel = recordKey(event)
      if (!accel) return

      recording = false
      window.removeEventListener('keydown', handler, true)
      hotkeyButton.classList.remove('recording')
      void persist({ hotkey: accel })
    }

    window.addEventListener('keydown', handler, true)
  })

  modelSelect.addEventListener('change', () => {
    void persist({ model: modelSelect.value })
  })

  endpointInput.addEventListener('change', async () => {
    const value = endpointInput.value.trim()
    if (!/^https?:\/\//i.test(value)) {
      endpointInput.value = settings.endpoint
      toast('Endpoint must start with http:// or https://', 'error')
      return
    }
    await persist({ endpoint: value })
    await refreshOllama()
  })

  maxWidthSelect.addEventListener('change', () => {
    void persist({ maxImageWidth: Number(maxWidthSelect.value) })
  })

  alwaysOnTopInput.addEventListener('change', () => {
    void persist({ alwaysOnTop: alwaysOnTopInput.checked })
  })

  voiceEnabledInput.addEventListener('change', () => {
    void persist({ voiceEnabled: voiceEnabledInput.checked }).then(() => refreshVoiceStatus())
  })

  el<HTMLButtonElement>('btn-voice-cancel').addEventListener('click', cancelVoice)
  voiceButton.addEventListener('click', () => {
    if (listening) {
      cancelVoice()
    } else {
      void startVoice()
    }
  })

  composer.addEventListener('input', autosize)
  composer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  })

  window.addEventListener('keydown', (event) => {
    if (recording) return

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault()
      clearChat()
      composer.focus()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (listening) cancelVoice()
      else if (activeId) void api.cancel(activeId)
      else if (drawerOpen) closeDrawer()
      else void api.hide()
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault()
      openDrawer()
    }
  })
}

function subscribe(): void {
  api.onScreen((info) => {
    applyScreen(info)
  })

  api.onCaptureStarted(() => {
    paintStatus('checking', 'Capturing screen…')
  })

  api.onNewChat(() => clearChat())

  api.onCaptureError(({ message }) => {
    restoreStatus()
    toast(message, 'error')
    openDrawer()
  })

  api.onVoiceBegin(() => void startVoice())

  api.onVoiceError(({ message }) => {
    toast(message, 'error')
    openDrawer()
    void refreshVoiceStatus()
  })

  api.onVoiceProgress((event) => {
    if (event.phase === 'download' && typeof event.fraction === 'number') {
      const percent = Math.round(event.fraction * 100)
      voiceStatusText.textContent = `Downloading speech model… ${percent}%`
      if (listening) voiceLabel.textContent = `Downloading speech model… ${percent}%`
    }
    if (event.phase === 'ready') void refreshVoiceStatus()
  })

  api.onAskToken(handleToken)
  api.onAskDone(handleDone)
  api.onAskError(handleError)

  api.onHotkeyState((state) => renderHotkey(state))

  api.onFocusComposer(() => composer.focus())

  api.onOpenSettings(() => openDrawer())
}

async function init(): Promise<void> {
  try {
    const boot = await api.bootstrap()
    platform = boot.platform
    settings = boot.settings
    renderHotkey(boot.hotkey)
    fillSettings()
  } catch (error) {
    toast(textOf(error), 'error')
  }

  wire()
  subscribe()

  await refreshOllama()
  composer.focus()
}

void init()
