import { spawn } from 'node:child_process'
import { createWriteStream, promises as fs, statSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { VoiceProgressEvent, VoiceStatus } from '../shared/types'

/**
 * Local speech-to-text backed by whisper.cpp.
 *
 * Nothing leaves the machine: the recording is written to a temp WAV, handed to
 * the `whisper-cli` binary, and deleted as soon as the transcript is parsed.
 */

const MODEL_FILE = 'ggml-base.en.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`
const MIN_MODEL_BYTES = 100 * 1024 * 1024

let reportedProgress = 0
let lastProgress: VoiceProgressEvent | null = null
let downloading: Promise<string> | null = null

function modelDir(): string {
  return join(app.getPath('userData'), 'models')
}

function modelPath(): string {
  return join(modelDir(), MODEL_FILE)
}

/** Paths to try, most specific first. */
function binaryCandidates(): string[] {
  const bundled = join(process.resourcesPath ?? '', 'whisper')

  if (process.platform === 'win32') {
    return [join(bundled, 'whisper-cli.exe'), 'whisper-cli.exe', join(bundled, 'main.exe')]
  }

  return [
    join(bundled, 'whisper-cli'),
    join(bundled, 'main'),
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
    '/opt/homebrew/bin/whisper-cpp',
    '/usr/local/bin/whisper-cpp',
    'whisper-cli'
  ]
}

function looksExecutable(path: string): boolean {
  if (!path.includes('/') && !path.includes('\\')) return true // bare name: resolved through PATH
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function findWhisperBinary(): string | null {
  for (const candidate of binaryCandidates()) {
    if (looksExecutable(candidate)) return candidate
  }
  return null
}

function emitProgress(event: VoiceProgressEvent): void {
  lastProgress = event
  if (!app.isReady()) return

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('voice:progress', event)
  }
}

export function voiceProgress(): VoiceProgressEvent | null {
  return lastProgress
}

async function downloadModel(): Promise<string> {
  const target = modelPath()
  await fs.mkdir(modelDir(), { recursive: true })

  const partial = `${target}.part`
  const response = await fetch(MODEL_URL, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download the speech model (HTTP ${response.status}).`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  reportedProgress = 0

  const out = createWriteStream(partial)
  const reader = response.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => out.once('drain', resolve))
      }

      const fraction = total > 0 ? received / total : 0
      if (fraction - reportedProgress > 0.02 || reportedProgress === 0) {
        reportedProgress = fraction
        emitProgress({ phase: 'download', receivedBytes: received, totalBytes: total, fraction })
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.once('error', reject)
    })
  } catch (error) {
    out.destroy()
    await fs.rm(partial, { force: true })
    throw error
  }

  const written = (await fs.stat(partial)).size
  if (written < MIN_MODEL_BYTES) {
    await fs.rm(partial, { force: true })
    throw new Error('The speech model download was incomplete. Try again.')
  }

  await fs.rename(partial, target)
  emitProgress({ phase: 'ready', fraction: 1 })
  return target
}

/** Downloads the model once; concurrent callers share the same promise. */
export async function ensureModel(): Promise<string> {
  const target = modelPath()

  try {
    const info = await fs.stat(target)
    if (info.size >= MIN_MODEL_BYTES) return target
    await fs.rm(target, { force: true })
  } catch {
    // missing — fall through to download
  }

  downloading ??= downloadModel().finally(() => {
    downloading = null
  })

  return downloading
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const binary = findWhisperBinary()
  let modelPresent = false
  let modelBytes = 0

  try {
    const info = await fs.stat(modelPath())
    modelBytes = info.size
    modelPresent = info.size >= MIN_MODEL_BYTES
  } catch {
    modelPresent = false
  }

  return {
    ready: Boolean(binary) && modelPresent,
    binaryPath: binary,
    modelPath: modelPath(),
    modelPresent,
    modelBytes,
    error: binary
      ? undefined
      : 'whisper.cpp is not installed. Run: brew install whisper-cpp'
  }
}

/** Laptop mics often record speech far below full scale; Whisper likes a hot signal. */
function normalize(samples: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i])
    if (magnitude > peak) peak = magnitude
  }

  if (peak < 0.02 || peak > 0.95) return samples

  const gain = 0.95 / peak
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] * gain
  return out
}

/** Float32 mono samples at 16 kHz → 16-bit PCM WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // format: PCM
  buffer.writeUInt16LE(1, 22) // channels
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }

  return buffer
}

/** Whisper likes to invent these when the input is mostly silence. */
function cleanTranscript(raw: string): string {
  const withoutTags = raw
    .replace(/\[(BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE)\]/gi, ' ')
    .replace(/\((silence|music|noise|inaudible)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^(thank you\.?|thanks for watching\.?|you\.?)$/i.test(withoutTags)) return ''
  return withoutTags
}

export interface TranscribeOptions {
  signal?: AbortSignal
}

export async function transcribe(samples: Float32Array, options: TranscribeOptions = {}): Promise<string> {
  if (!samples || samples.length < 1600) return ''

  const binary = findWhisperBinary()
  if (!binary) throw new Error('whisper.cpp is not installed. Run: brew install whisper-cpp')

  const model = await ensureModel()
  const wavPath = join(tmpdir(), `rex-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`)
  await fs.writeFile(wavPath, encodeWav(normalize(samples), 16000))

  const threads = Math.max(2, Math.min(6, cpus().length - 1))
  const args = ['-m', model, '-f', wavPath, '-l', 'en', '-nt', '-np', '-t', String(threads)]

  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      const kill = (): void => {
        child.kill('SIGKILL')
        reject(new Error('Transcription cancelled.'))
      }
      options.signal?.addEventListener('abort', kill, { once: true })

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Transcription timed out.'))
      }, 60_000)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(
          new Error(
            `Could not run ${binary}. ${error.message}`
          )
        )
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', kill)
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `whisper-cli exited with code ${code}`))
      })
    })

    return cleanTranscript(output)
  } finally {
    await fs.rm(wavPath, { force: true })
  }
}
