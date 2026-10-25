import type { ChatTurn, OllamaModel } from '../shared/types'

/**
 * Ollama's /api/tags does not report which models accept images, so we guess
 * from the tag. A wrong guess is not fatal: the user can still select any
 * model, and Ollama returns a clear error if it cannot read images.
 */
const VISION_HINTS = [
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'llama3.2-vision',
  'llama4',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen2.5vl',
  'qwen3-vl',
  'qwen3vl',
  'gemma3',
  'gemma4',
  'granite3.2-vision',
  'granite3.3-vision',
  'mistral-small3.1',
  'mistral-small3.2',
  'pixtral',
  'gemma3n'
]

export function looksVisionCapable(modelName: string): boolean {
  const name = modelName.toLowerCase()
  return VISION_HINTS.some((hint) => name.includes(hint))
}

export function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  return trimmed.replace(/\/+$/, '')
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'Timed out while talking to Ollama.'
    // fetch() reports connection refused through a generic TypeError.
    if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
      return 'Could not reach Ollama. Is it running? Try: ollama serve'
    }
    return error.message
  }
  return String(error)
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function checkOllama(endpoint: string): Promise<{ online: boolean; version?: string; error?: string }> {
  try {
    const response = await fetchWithTimeout(`${normalizeEndpoint(endpoint)}/api/version`, {}, 2500)
    if (!response.ok) throw new Error(`Ollama replied with HTTP ${response.status}.`)
    const body = (await response.json()) as { version?: string }
    return { online: true, version: body.version }
  } catch (error) {
    return { online: false, error: describeNetworkError(error) }
  }
}

export async function listModels(endpoint: string): Promise<OllamaModel[]> {
  const response = await fetchWithTimeout(`${normalizeEndpoint(endpoint)}/api/tags`, {}, 5000)
  if (!response.ok) throw new Error(`Ollama replied with HTTP ${response.status}.`)

  const body = (await response.json()) as {
    models?: Array<{ name?: string; size?: number; modified_at?: string }>
  }

  return (body.models ?? [])
    .filter((model): model is { name: string; size?: number; modified_at?: string } => Boolean(model.name))
    .map((model) => ({
      name: model.name,
      sizeBytes: model.size ?? 0,
      modifiedAt: model.modified_at,
      vision: looksVisionCapable(model.name)
    }))
    .sort((a, b) => Number(b.vision) - Number(a.vision) || a.name.localeCompare(b.name))
}

function explainHttpError(status: number, rawBody: string, model: string): string {
  let detail = rawBody.trim()

  try {
    const parsed = JSON.parse(rawBody) as { error?: string }
    if (parsed.error) detail = parsed.error
  } catch {
    // Keep the raw body when it is not JSON.
  }

  if (status === 404 || /not found|no such model/i.test(detail)) {
    return `Ollama does not have "${model}" yet. Pull it first: ollama pull ${model}`
  }

  if (/does not support images|image input/i.test(detail)) {
    return `"${model}" cannot read images. Pick a vision model such as qwen2.5vl:3b or llava:7b.`
  }

  return `Ollama error (HTTP ${status}): ${detail || 'no details returned'}`
}

export interface ChatOptions {
  endpoint: string
  model: string
  system: string
  history: ChatTurn[]
  prompt: string
  /** Raw base64 JPEG, no data-url prefix. */
  imageBase64?: string
  signal?: AbortSignal
  onToken?: (token: string) => void
}

/**
 * Streams a chat completion from Ollama's /api/chat endpoint.
 * Returns the full answer once the stream finishes.
 */
export async function chat(options: ChatOptions): Promise<string> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: options.system },
    ...options.history.map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: 'user',
      content: options.prompt,
      ...(options.imageBase64 ? { images: [options.imageBase64] } : {})
    }
  ]

  const response = await fetch(`${normalizeEndpoint(options.endpoint)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // Keeping the model resident makes follow-up questions much faster.
      keep_alive: '30m',
      options: { temperature: 0.2, num_ctx: 8192 }
    }),
    signal: options.signal
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(explainHttpError(response.status, body, options.model))
  }

  if (!response.body) throw new Error('Ollama returned an empty response stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return

    let event: { message?: { content?: string }; error?: string }
    try {
      event = JSON.parse(trimmed) as { message?: { content?: string }; error?: string }
    } catch {
      return
    }

    if (event.error) throw new Error(event.error)

    const token = event.message?.content ?? ''
    if (token) {
      answer += token
      options.onToken?.(token)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }

  // Flush whatever is left when the stream does not end with a newline.
  handleLine(buffer)

  return answer
}
