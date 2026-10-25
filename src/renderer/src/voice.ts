/**
 * Microphone capture for push-to-talk.
 *
 * Records 16 kHz mono Float32 samples and stops by itself: shortly after you
 * start speaking, or after a couple of seconds of silence. Everything stays in
 * memory until the transcript is produced by the local whisper.cpp binary.
 */

export type VoicePhase = 'starting' | 'listening' | 'speech' | 'finishing'

export interface VoiceCaptureOptions {
  onLevel?: (level: number) => void
  onPhase?: (phase: VoicePhase) => void
  signal?: AbortSignal
}

export interface VoiceResult {
  samples: Float32Array
  durationMs: number
  peakRms: number
}

const SAMPLE_RATE = 16_000
const FRAME = 2048
/** Give up if nothing is said in this window. */
const NO_SPEECH_TIMEOUT_MS = 7000
/** How much silence ends the utterance once speech has started. */
const TRAILING_SILENCE_MS = 1200
/** Hard stop so a stuck microphone can never record forever. */
const MAX_UTTERANCE_MS = 20_000
/** Keep quiet laptop-mic speech above the VAD floor. */
const MIN_SPEECH_RMS = 0.0015

function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, samples.length))
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

/** Drops leading and trailing quiet frames so Whisper only sees speech. */
function trimSilence(samples: Float32Array, threshold: number): Float32Array {
  const window = Math.round(SAMPLE_RATE * 0.03)

  let start = 0
  for (let i = 0; i + window <= samples.length; i += window) {
    if (rms(samples.subarray(i, i + window)) > threshold) {
      start = i
      break
    }
  }

  let end = samples.length
  for (let i = samples.length - window; i >= 0; i -= window) {
    if (rms(samples.subarray(i, i + window)) > threshold) {
      end = Math.min(samples.length, i + window)
      break
    }
  }

  if (end - start < window * 3) return samples

  // Keep a small pad either side so the first and last phoneme survive.
  const pad = Math.round(SAMPLE_RATE * 0.12)
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad))
}

export async function recordUtterance(options: VoiceCaptureOptions = {}): Promise<VoiceResult> {
  options.onPhase?.('starting')

  // Using { ideal } constraints avoids OverconstrainedError when the audio
  // hardware only captures at 44.1 kHz or 48 kHz (standard on Mac).
  // AudioContext({ sampleRate: 16000 }) resamples the stream to 16 kHz.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      sampleRate: { ideal: SAMPLE_RATE },
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const track = stream.getAudioTracks()[0]
  console.info(
    `[voice] microphone track: ${track?.label || '(unnamed)'} ${JSON.stringify(track?.getSettings() ?? {})}`
  )

  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (context.state === 'suspended') await context.resume()

  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(FRAME, 1, 1)
  const sink = context.createGain()
  sink.gain.value = 0

  source.connect(processor)
  processor.connect(sink)
  sink.connect(context.destination)

  const chunks: Float32Array[] = []
  let total = 0
  let floor = 0.0005
  let peakRms = 0
  let speechStarted = false
  let lastVoiceAt = 0
  const startedAt = performance.now()

  return new Promise<VoiceResult>((resolve, reject) => {
    let settled = false

    const cleanup = (): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      processor.onaudioprocess = null
      try {
        processor.disconnect()
        source.disconnect()
        sink.disconnect()
      } catch {
        // already torn down
      }
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
    }

    const finish = (reason: 'silence' | 'max' | 'abort' | 'none'): void => {
      if (settled) return
      options.onPhase?.('finishing')
      cleanup()

      if (reason === 'abort') {
        reject(new Error('Cancelled.'))
        return
      }

      const merged = concat(chunks, total)
      const threshold = Math.max(MIN_SPEECH_RMS, floor * 2)
      const trimmed = speechStarted ? trimSilence(merged, threshold) : new Float32Array(0)

      console.info(
        `[voice] captured ${total} samples; peak RMS ${peakRms.toFixed(5)}; speech detected ${speechStarted}`
      )

      resolve({
        samples: trimmed,
        durationMs: Math.round((trimmed.length / SAMPLE_RATE) * 1000),
        peakRms
      })
    }

    const onAbort = (): void => finish('abort')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      const input = event.inputBuffer.getChannelData(0)
      const frame = new Float32Array(input.length)
      frame.set(input)

      chunks.push(frame)
      total += frame.length

      const level = rms(frame)
      peakRms = Math.max(peakRms, level)
      const now = performance.now()
      const threshold = Math.max(MIN_SPEECH_RMS, floor * 2)

      if (level < threshold) {
        // Track the room noise slowly so a fan or hum never counts as speech.
        floor = floor * 0.92 + level * 0.08
      }

      options.onLevel?.(Math.min(1, level * 14))

      if (level > threshold) {
        if (!speechStarted) {
          speechStarted = true
          options.onPhase?.('speech')
        }
        lastVoiceAt = now
      }

      if (speechStarted && now - lastVoiceAt >= TRAILING_SILENCE_MS) {
        finish('silence')
        return
      }

      if (!speechStarted && now - startedAt >= NO_SPEECH_TIMEOUT_MS) {
        finish('none')
        return
      }

      if (now - startedAt >= MAX_UTTERANCE_MS) {
        finish('max')
        return
      }

      if (!speechStarted) options.onPhase?.('listening')
    }

    options.onPhase?.('listening')
  })
}
