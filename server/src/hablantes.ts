import type { SegmentoDiarizado } from './openai.js'

export type MapaHablantes = Record<string, string>

export function normalizarMapaHablantes(raw: unknown): MapaHablantes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: MapaHablantes = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const k = String(key).trim()
    if (!k) continue
    const v = typeof val === 'string' ? val.trim() : String(val ?? '').trim()
    if (v) out[k] = v.slice(0, 120)
  }
  return out
}

export function nombreVisibleHablante(
  speaker: string,
  hablantes?: MapaHablantes,
): string {
  const key = speaker.trim() || '?'
  const custom = hablantes?.[key]?.trim()
  if (custom) return custom
  if (/^persona\s/i.test(key)) return key
  return `Persona ${key}`
}

export function segmentosATextoPlano(
  segmentos: SegmentoDiarizado[],
  hablantes?: MapaHablantes,
): string {
  return segmentos
    .filter((s) => s.text.trim())
    .map((s) => {
      const seg = Math.round(s.start)
      const nombre = nombreVisibleHablante(s.speaker, hablantes)
      return `${nombre} (${seg}s): ${s.text.trim()}`
    })
    .join('\n')
}

export interface TranscripcionJsonConHablantes {
  diarizada: boolean
  segmentos: SegmentoDiarizado[]
  hablantes?: MapaHablantes
}

export function parseTranscripcionJsonAlmacenado(
  raw: string | null | undefined,
): TranscripcionJsonConHablantes | null {
  if (raw == null || raw === '') return null
  try {
    const j = JSON.parse(raw) as TranscripcionJsonConHablantes
    if (j && typeof j === 'object' && Array.isArray(j.segmentos)) {
      return {
        diarizada: Boolean(j.diarizada),
        segmentos: j.segmentos,
        hablantes: normalizarMapaHablantes(j.hablantes),
      }
    }
  } catch {
    /* ignorar */
  }
  return null
}
