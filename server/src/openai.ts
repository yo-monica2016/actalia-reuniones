import './loadEnv'
import fs from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'

export const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Por encima de este tamaño por trozo se usa whisper-1 en lugar de diarize. */
export const OPENAI_DIARIZE_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  Number(process.env.OPENAI_DIARIZE_MAX_MB ?? 24) * 1024 * 1024,
)

const DIARIZE_MAX_RETRIES = Math.max(
  1,
  Math.min(3, Number(process.env.OPENAI_DIARIZE_MAX_RETRIES ?? 2)),
)
const DIARIZE_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(600_000, Number(process.env.OPENAI_DIARIZE_TIMEOUT_MS ?? 300_000)),
)
const DIARIZE_RETRY_BASE_MS = Math.max(
  500,
  Number(process.env.OPENAI_DIARIZE_RETRY_DELAY_MS ?? 2000),
)

export function debeIntentarDiarize(tamanoBytes: number): boolean {
  return tamanoBytes <= OPENAI_DIARIZE_MAX_BYTES
}

export function openAiApiKey(): string {
  return process.env.OPENAI_API_KEY?.trim() ?? ''
}

export function openAiConfigured(): boolean {
  return openAiApiKey().length > 0
}

function providerIsOpenAi(_name: string, envKey: string): boolean {
  const raw = process.env[envKey]?.trim().toLowerCase()
  if (raw === 'local') return false
  if (raw === 'openai') return openAiConfigured()
  return openAiConfigured()
}

export function useOpenAiTranscription(): boolean {
  return providerIsOpenAi('transcription', 'TRANSCRIPTION_PROVIDER')
}

export function useOpenAiSummary(): boolean {
  return providerIsOpenAi('summary', 'SUMMARY_PROVIDER')
}

function getClient(timeoutMs = DIARIZE_TIMEOUT_MS): OpenAI {
  const apiKey = openAiApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada en server/.env')
  }
  return new OpenAI({
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
  })
}

function errorTexto(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      err.cause instanceof Error
        ? err.cause.message
        : err.cause != null
          ? String(err.cause)
          : ''
    return `${err.message} ${cause}`.trim().toLowerCase()
  }
  return String(err).toLowerCase()
}

export function esErrorReintentoOpenAi(err: unknown): boolean {
  const msg = errorTexto(err)
  if (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('aborterror') ||
    msg.includes('temporarily unavailable')
  ) {
    return true
  }
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true
  if (msg.includes('rate limit') || msg.includes('overloaded')) return true
  return false
}

async function esperarReintento(attempt: number): Promise<void> {
  const delay = Math.min(60_000, DIARIZE_RETRY_BASE_MS * Math.pow(2, attempt - 1))
  await new Promise((resolve) => setTimeout(resolve, delay))
}

export async function conReintentosOpenAi<T>(
  etiqueta: string,
  fn: () => Promise<T>,
  maxIntentos = DIARIZE_MAX_RETRIES,
): Promise<T> {
  let ultimo: unknown
  const t0 = Date.now()
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      if (intento > 1) {
        console.log(`[openai] ${etiqueta}: reintento ${intento}/${maxIntentos}`)
      }
      const result = await fn()
      console.log(
        `[openai] ${etiqueta}: OK en ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      )
      return result
    } catch (err) {
      ultimo = err
      const reintentar = esErrorReintentoOpenAi(err) && intento < maxIntentos
      const detalle = err instanceof Error ? err.message : String(err)
      if (!reintentar) {
        console.error(
          `[openai] ${etiqueta}: fallo definitivo (${intento}/${maxIntentos}):`,
          detalle,
        )
        throw err
      }
      console.warn(
        `[openai] ${etiqueta}: intento ${intento}/${maxIntentos} falló (${detalle}), reintentando…`,
      )
      await esperarReintento(intento)
    }
  }
  throw ultimo
}

export interface SegmentoDiarizado {
  speaker: string
  start: number
  end: number
  text: string
}

import { segmentosATextoPlano } from './hablantes.js'

export { segmentosATextoPlano } from './hablantes.js'

function mimeDesdeRuta(audioPath: string): string {
  const ext = path.extname(audioPath).toLowerCase()
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.webm') return 'audio/webm'
  if (ext === '.m4a') return 'audio/mp4'
  return 'application/octet-stream'
}

type DiarizeApiPayload = {
  text?: string
  segments?: Array<{
    speaker?: string
    start?: number
    end?: number
    text?: string
  }>
}

function parsearRespuestaDiarize(data: DiarizeApiPayload): {
  texto: string
  segmentos: SegmentoDiarizado[]
} {
  const segmentos: SegmentoDiarizado[] = (data.segments ?? [])
    .map((s) => ({
      speaker: String(s.speaker ?? '?').trim() || '?',
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      text: String(s.text ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0)

  const texto =
    segmentos.length > 0
      ? segmentosATextoPlano(segmentos)
      : String(data.text ?? '').trim()

  if (!texto) {
    throw new Error('OpenAI devolvió una transcripción vacía (diarize)')
  }

  return { texto, segmentos }
}

async function diarizeViaApi(
  audioPath: string,
  model: string,
): Promise<{ texto: string; segmentos: SegmentoDiarizado[] }> {
  const apiKey = openAiApiKey()
  const nombre = path.basename(audioPath)
  const t0 = Date.now()
  console.log(`[openai] diarize enviando a API (${nombre})…`)

  const body = new FormData()
  body.append('file', new Blob([fs.readFileSync(audioPath)]), nombre)
  body.append('model', model)
  body.append('response_format', 'diarized_json')
  body.append('chunking_strategy', 'auto')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    signal: AbortSignal.timeout(DIARIZE_TIMEOUT_MS),
  })

  console.log(
    `[openai] diarize respuesta HTTP ${res.status} en ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`OpenAI diarize ${res.status}: ${errText.slice(0, 500)}`)
  }

  const data = (await res.json()) as DiarizeApiPayload
  return parsearRespuestaDiarize(data)
}

export async function transcribirAudioOpenAiDiarize(
  audioPath: string,
): Promise<{ texto: string; segmentos: SegmentoDiarizado[] }> {
  const stat = fs.statSync(audioPath)
  if (stat.size > OPENAI_MAX_AUDIO_BYTES) {
    throw new Error('Audio demasiado grande para diarización OpenAI (máx. 25 MB)')
  }

  const model =
    process.env.OPENAI_DIARIZE_MODEL?.trim() || 'gpt-4o-transcribe-diarize'
  const tamanoMb = (stat.size / (1024 * 1024)).toFixed(1)

  const maxMbDiarize = (OPENAI_DIARIZE_MAX_BYTES / (1024 * 1024)).toFixed(1)
  console.log(
    `[openai] diarize inicio: ${path.basename(audioPath)} (${tamanoMb} MB), ` +
      `timeout ${DIARIZE_TIMEOUT_MS}ms, ${DIARIZE_MAX_RETRIES} intento(s), máx diarize ${maxMbDiarize} MB`,
  )

  return conReintentosOpenAi(`diarize ${path.basename(audioPath)}`, () =>
    diarizeViaApi(audioPath, model),
  )
}

export async function transcribirAudioOpenAi(audioPath: string): Promise<string> {
  const stat = fs.statSync(audioPath)
  if (stat.size > OPENAI_MAX_AUDIO_BYTES) {
    throw new Error(
      `El audio supera 25 MB (límite de OpenAI). Tamaño: ${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
    )
  }

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || 'whisper-1'

  return conReintentosOpenAi(`whisper-1 ${path.basename(audioPath)}`, async () => {
    const client = getClient()
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model,
      language: 'es',
    })
    const texto = String(transcription.text ?? '').trim()
    if (!texto) {
      throw new Error('OpenAI devolvió una transcripción vacía')
    }
    return texto
  })
}

import type { ResumenAlmacenado } from './resumen.js'
import { normalizarTemas } from './resumen.js'

export type ResumenOpenAi = ResumenAlmacenado

export async function resumirTranscripcionOpenAi(
  transcripcion: string,
  tituloReunion?: string,
): Promise<ResumenOpenAi> {
  const client = getClient()
  const model = process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o-mini'
  const titulo = tituloReunion?.trim() || 'Reunión'
  const maxTokens = Number(process.env.OPENAI_RESUMEN_MAX_TOKENS ?? 4096)

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Eres un asistente experto en actas y resúmenes de reuniones en español.\n\n' +
          'Tu tarea NO es copiar la transcripción ni resumir solo el inicio. Debes leer TODA la transcripción e identificar QUÉ ASUNTOS se trataron realmente.\n\n' +
          'REGLAS OBLIGATORIAS:\n' +
          '1. Lista en "temas" cada asunto que SÍ aparece en la transcripción (problemas, decisiones, acuerdos, datos, riesgos, tareas, etc.).\n' +
          '2. Cada tema debe tener un "titulo" corto y claro (3-8 palabras) y un "resumen" de 2-6 frases explicando qué se dijo sobre ESE asunto, con hechos concretos.\n' +
          '3. Si un asunto NO se mencionó, NO lo incluyas en "temas". No inventes ni rellenes con suposiciones.\n' +
          '4. Ordena los temas en orden lógico (cronológico o por importancia), no alfabético.\n' +
          '5. Si hay nombres de personas en la transcripción (p. ej. Nieves, Carla, Luis o "Persona A/B"), úsalos cuando ayuden a entender quién dijo o acordó qué; no cambies los nombres.\n' +
          '6. En "global" escribe solo una SÍNTESIS general de 4-8 frases: de qué iba la reunión y conclusiones principales. No repitas aquí el detalle de cada tema (eso va en "temas").\n' +
          '7. Si la transcripción tiene cabeceras "========== Audio: ... ==========", rellena "porAudio" con un resumen por archivo; si es un solo audio sin cabeceras, "porAudio" debe ser {}.\n' +
          '8. Incluye en "temas" (cuando existan) decisiones, acuerdos, compromisos o próximos pasos como temas propios o dentro del tema al que pertenezcan.\n' +
          '9. Responde SOLO con JSON válido, sin markdown ni texto fuera del JSON.\n\n' +
          'Formato EXACTO:\n' +
          '{"global":"síntesis breve de toda la reunión","temas":[{"titulo":"Título del asunto","resumen":"Qué se habló de este asunto..."}],"porAudio":{"nombre_archivo":"resumen de ese audio si aplica"}}\n\n' +
          'Si no hay contenido suficiente, "temas" puede ser [] y "global" explica que la transcripción es insuficiente.',
      },
      {
        role: 'user',
        content:
          `Título de la reunión: ${titulo}\n\n` +
          'Genera el resumen por TEMAS: por cada asunto del que se habló, un bloque en "temas". Si no se mencionó, no lo incluyas.\n\n' +
          `Transcripción:\n${transcripcion.slice(0, 120000)}`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content?.trim() ?? ''
  if (!raw) {
    throw new Error('OpenAI no devolvió resumen')
  }

  let parsed: ResumenOpenAi
  try {
    parsed = JSON.parse(raw) as ResumenOpenAi
  } catch {
    throw new Error('OpenAI devolvió un resumen con formato inválido')
  }

  const global = String(parsed.global ?? '').trim()
  const temas = normalizarTemas(parsed.temas)
  const porAudio: Record<string, string> = {}
  if (parsed.porAudio && typeof parsed.porAudio === 'object') {
    for (const [k, v] of Object.entries(parsed.porAudio)) {
      const t = String(v ?? '').trim()
      if (t) porAudio[k] = t
    }
  }

  if (!global && temas.length === 0 && Object.keys(porAudio).length === 0) {
    throw new Error('OpenAI devolvió un resumen vacío')
  }

  return { global, temas, porAudio }
}
