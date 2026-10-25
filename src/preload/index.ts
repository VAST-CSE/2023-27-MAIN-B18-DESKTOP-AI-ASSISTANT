import { contextBridge, ipcRenderer } from 'electron'
import type {
  AskDoneEvent,
  AskErrorEvent,
  AskRequest,
  AskTokenEvent,
  Bootstrap,
  RexApi,
  HotkeyState,
  OllamaStatus,
  SaveResult,
  ScreenShotInfo,
  Settings,
  VoiceProgressEvent,
  VoiceStatus
} from '../shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: RexApi = {
  platform: process.platform,

  bootstrap: () => ipcRenderer.invoke('app:bootstrap') as Promise<Bootstrap>,
  saveSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke('settings:save', patch) as Promise<SaveResult>,
  ollamaStatus: () => ipcRenderer.invoke('ollama:status') as Promise<OllamaStatus>,
  capture: () => ipcRenderer.invoke('screen:capture') as Promise<ScreenShotInfo>,
  ask: (request: AskRequest) => ipcRenderer.invoke('ask', request) as Promise<{ ok: true }>,
  cancel: (id: string) => ipcRenderer.invoke('ask:cancel', id) as Promise<void>,
  hide: () => ipcRenderer.invoke('window:hide') as Promise<void>,
  quit: () => ipcRenderer.invoke('app:quit') as Promise<void>,

  voiceStatus: () => ipcRenderer.invoke('voice:status') as Promise<VoiceStatus>,
  prepareVoice: () => ipcRenderer.invoke('voice:prepare') as Promise<VoiceStatus>,
  openMicrophoneSettings: () => ipcRenderer.invoke('open:microphone-settings') as Promise<void>,
  transcribe: (samples: Float32Array) =>
    ipcRenderer.invoke('voice:transcribe', samples) as Promise<{ text: string }>,

  onVoiceBegin: (cb) => subscribe<null>('voice:begin', cb),
  onVoiceError: (cb) => subscribe<{ message: string }>('voice:error', cb),
  onVoiceProgress: (cb) => subscribe<VoiceProgressEvent>('voice:progress', cb),

  onScreen: (cb) => subscribe<ScreenShotInfo>('screen:captured', cb),
  onCaptureStarted: (cb) => subscribe<null>('capture:started', cb),
  onCaptureError: (cb) => subscribe<{ message: string }>('capture:error', cb),
  onNewChat: (cb) => subscribe<null>('chat:new', cb),
  onAskToken: (cb) => subscribe<AskTokenEvent>('ask:token', cb),
  onAskDone: (cb) => subscribe<AskDoneEvent>('ask:done', cb),
  onAskError: (cb) => subscribe<AskErrorEvent>('ask:error', cb),
  onHotkeyState: (cb) => subscribe<HotkeyState>('hotkey:state', cb),
  onFocusComposer: (cb) => subscribe<null>('focus:composer', cb),
  onOpenSettings: (cb) => subscribe<null>('ui:open-settings', cb)
}

contextBridge.exposeInMainWorld('rex', api)
