import fs from 'node:fs'
import OpenAI from 'openai'

const OPENAI_MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function openAiApiKey(): string {
  return process.env.OPENAI_API_KEY?.trim() ?? ''
}

export function openAiConfigured(): boolean {
  return openAiApiKey().length > 0
}

function providerIsOpenAi(name: string, envKey: string): boolean {
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

function getClient(): OpenAI {
  const apiKey = openAiApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada en server/.env')
  }
  return new OpenAI({ apiKey })
}

export async function transcribirAudioOpenAi(audioPath: string): Promise<string> {
  const stat = fs.statSync(audioPath)
  if (stat.size > OPENAI_MAX_AUDIO_BYTES) {
    throw new Error(
      `El audio supera 25 MB (límite de OpenAI). Tamaño: ${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
    )
  }

  const client = getClient()
  const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || 'whisper-1'

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
}

export interface ResumenOpenAi {
  global: string
  porAudio: Record<string, string>
}

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
          'Eres un asistente experto en actas de reuniones en español. ' +
          'Debes elaborar un RESUMEN COMPLETO y bien explicado (no un recorte del inicio ni la transcripción literal). ' +
          'Incluye: contexto, temas tratados en orden lógico, decisiones, acuerdos, tareas o compromisos, y conclusiones. ' +
          'Usa varios párrafos claros en "global" (mínimo 8-12 frases si hay contenido suficiente). ' +
          'Responde SOLO con un JSON válido con esta forma exacta: ' +
          '{"global":"texto del resumen completo","porAudio":{"nombre_archivo":"resumen detallado de ese audio"}}. ' +
          'Si la transcripción tiene secciones "========== Audio: ... ==========", resume cada bloque en porAudio ' +
          'y haz un "global" que integre toda la reunión. ' +
          'Si es un solo audio sin cabeceras, deja porAudio como {} y pon todo el detalle en global.',
      },
      {
        role: 'user',
        content: `Título de la reunión: ${titulo}\n\nTranscripción:\n${transcripcion.slice(0, 120000)}`,
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
  const porAudio: Record<string, string> = {}
  if (parsed.porAudio && typeof parsed.porAudio === 'object') {
    for (const [k, v] of Object.entries(parsed.porAudio)) {
      const t = String(v ?? '').trim()
      if (t) porAudio[k] = t
    }
  }

  if (!global && Object.keys(porAudio).length === 0) {
    throw new Error('OpenAI devolvió un resumen vacío')
  }

  return { global, porAudio }
}
