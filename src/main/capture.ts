import { desktopCapturer, screen, systemPreferences } from 'electron'
import type { ScreenShotInfo } from '../shared/types'

export interface CaptureResult {
  info: ScreenShotInfo
  /** Raw base64 JPEG (no data-url prefix), ready for Ollama's `images` field. */
  base64: string
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const PERMISSION_HINT =
  'Screen Recording permission is required. Open System Settings → Privacy & Security → ' +
  '"Screen & System Audio Recording" (called "Screen Recording" on older macOS), ' +
  'enable REX, then quit and relaunch the app.'

/**
 * macOS also reports "denied" for apps that have never been asked, so the status
 * cannot be used as a gate: making the capture request is exactly what registers
 * the app with TCC and produces the system prompt. Only "restricted" (an MDM
 * policy that the user cannot change) is a hard stop.
 */
function screenAccessState(): 'restricted' | 'denied' | 'other' {
  if (process.platform !== 'darwin') return 'other'

  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'restricted') return 'restricted'
  if (status === 'denied') return 'denied'
  return 'other'
}

/**
 * Captures the display the cursor is on and returns a JPEG sized for a vision
 * model, plus the cursor position normalised into that image.
 *
 * Electron gives us both numbers in the same coordinate space (DIP), which is
 * why this needs none of the DPI gymnastics a Qt + mss stack requires.
 */
export async function captureScreen(maxWidth: number, source: 'hotkey' | 'manual'): Promise<CaptureResult> {
  if (screenAccessState() === 'restricted') {
    throw new Error(PERMISSION_HINT)
  }

  const cursorPoint = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPoint)
  const scaleFactor = display.scaleFactor || 1

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scaleFactor),
        height: Math.round(display.size.height * scaleFactor)
      },
      fetchWindowIcons: false
    })
  } catch (error) {
    // ScreenCaptureKit refuses before the app is authorised; surface the reason
    // the user can act on instead of an opaque native error.
    if (screenAccessState() === 'denied') throw new Error(PERMISSION_HINT)
    throw error
  }

  if (sources.length === 0) {
    throw new Error(
      process.platform === 'darwin'
        ? PERMISSION_HINT
        : 'The operating system returned no screen sources to capture.'
    )
  }

  // display_id is only populated on macOS and Windows; fall back to the first source.
  const sourceForDisplay =
    sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]

  let image = sourceForDisplay.thumbnail
  if (image.isEmpty()) {
    throw new Error(
      process.platform === 'darwin'
        ? PERMISSION_HINT
        : 'The screenshot came back empty. Try again, or check your display settings.'
    )
  }

  const original = image.getSize()
  if (original.width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: 'good' })
  }

  const size = image.getSize()
  const jpeg = image.toJPEG(82)
  const base64 = jpeg.toString('base64')

  const localX = cursorPoint.x - display.bounds.x
  const localY = cursorPoint.y - display.bounds.y

  const info: ScreenShotInfo = {
    dataUrl: `data:image/jpeg;base64,${base64}`,
    displayLabel: `${display.label || 'Display'} · ${display.size.width}×${display.size.height} @${scaleFactor}x`,
    width: size.width,
    height: size.height,
    cursor:
      size.width > 0 && size.height > 0
        ? {
            x: clamp01(localX / Math.max(1, display.size.width)),
            y: clamp01(localY / Math.max(1, display.size.height))
          }
        : null,
    capturedAt: Date.now(),
    source
  }

  return { info, base64 }
}
