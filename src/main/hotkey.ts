import { globalShortcut } from 'electron'
import type { HotkeyState } from '../shared/types'

/**
 * Thin wrapper around Electron's globalShortcut that reports *why* a shortcut
 * failed instead of silently doing nothing. The renderer uses that message to
 * tell the user the combination is taken by another app.
 */
class HotkeyManager {
  private state: HotkeyState = { accelerator: '', registered: false }

  register(accelerator: string, handler: () => void): HotkeyState {
    this.unregister()

    const trimmed = accelerator.trim()
    if (!trimmed) {
      this.state = { accelerator: '', registered: false, error: 'No shortcut configured.' }
      return this.state
    }

    try {
      const ok = globalShortcut.register(trimmed, handler)
      this.state = ok
        ? { accelerator: trimmed, registered: true }
        : {
            accelerator: trimmed,
            registered: false,
            error: `“${trimmed}” is already used by another app. Pick a different combination.`
          }
    } catch (error) {
      this.state = {
        accelerator: trimmed,
        registered: false,
        error: `“${trimmed}” is not a valid shortcut: ${(error as Error).message}`
      }
    }

    return this.state
  }

  unregister(): void {
    const { accelerator, registered } = this.state
    if (registered && accelerator) {
      try {
        globalShortcut.unregister(accelerator)
      } catch {
        // Nothing useful to do if the OS has already dropped it.
      }
    }
    this.state = { accelerator: '', registered: false }
  }

  get current(): HotkeyState {
    return this.state
  }
}

export const hotkeys = new HotkeyManager()
