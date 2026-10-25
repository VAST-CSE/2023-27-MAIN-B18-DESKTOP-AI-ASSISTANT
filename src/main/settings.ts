import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

let cached: Settings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function cleanEndpoint(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return fallback
  return trimmed
}

function cleanHotkey(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function sanitize(input: Partial<Settings>): Partial<Settings> {
  const output: Partial<Settings> = {}

  if (input.hotkey !== undefined) output.hotkey = cleanHotkey(input.hotkey, DEFAULT_SETTINGS.hotkey)
  if (input.endpoint !== undefined) output.endpoint = cleanEndpoint(input.endpoint, DEFAULT_SETTINGS.endpoint)
  if (input.model !== undefined) output.model = typeof input.model === 'string' ? input.model.trim() : ''
  if (input.alwaysOnTop !== undefined) output.alwaysOnTop = Boolean(input.alwaysOnTop)
  if (input.voiceEnabled !== undefined) output.voiceEnabled = Boolean(input.voiceEnabled)
  if (input.maxImageWidth !== undefined) {
    output.maxImageWidth = clampNumber(input.maxImageWidth, 640, 2560, DEFAULT_SETTINGS.maxImageWidth)
  }

  return output
}

export function getSettings(): Settings {
  if (cached) return cached

  let stored: Partial<Settings> = {}
  try {
    const path = settingsPath()
    if (existsSync(path)) {
      stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>
    }
  } catch {
    // A corrupt settings file should never stop the app from starting.
    stored = {}
  }

  cached = { ...DEFAULT_SETTINGS, ...sanitize(stored) }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...sanitize(patch) }
  cached = next

  try {
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error('[settings] could not persist settings:', error)
  }

  return next
}
