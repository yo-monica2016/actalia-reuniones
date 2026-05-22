import type { MapaHablantes, SegmentoTranscripcion } from './types'

export function etiquetaPersona(speaker: string): string {
  const s = speaker.trim() || '?'
  if (/^persona\s/i.test(s)) return s
  return `Persona ${s}`
}

export function nombreHablante(
  speaker: string,
  hablantes?: MapaHablantes,
): string {
  const key = speaker.trim() || '?'
  const custom = hablantes?.[key]?.trim()
  if (custom) return custom
  return etiquetaPersona(speaker)
}

export function speakersUnicos(segmentos: SegmentoTranscripcion[]): string[] {
  const set = new Set<string>()
  for (const s of segmentos) {
    const k = s.speaker.trim() || '?'
    set.add(k)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'))
}

export function formatSegundos(seg: number): string {
  const s = Math.max(0, Math.round(seg))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m > 0) return `${m}:${String(r).padStart(2, '0')}`
  return `${s}s`
}

export interface GrupoHablante {
  speaker: string
  etiqueta: string
  segmentos: SegmentoTranscripcion[]
  primerInicio: number
}

export function agruparSegmentosPorHablante(
  segmentos: SegmentoTranscripcion[],
  hablantes?: MapaHablantes,
): GrupoHablante[] {
  const map = new Map<string, SegmentoTranscripcion[]>()

  for (const seg of segmentos) {
    if (!seg.text.trim()) continue
    const key = seg.speaker.trim() || '?'
    const lista = map.get(key) ?? []
    lista.push(seg)
    map.set(key, lista)
  }

  const grupos: GrupoHablante[] = []
  for (const [speaker, segs] of map) {
    segs.sort((a, b) => a.start - b.start)
    grupos.push({
      speaker,
      etiqueta: nombreHablante(speaker, hablantes),
      segmentos: segs,
      primerInicio: segs[0]?.start ?? 0,
    })
  }

  grupos.sort((a, b) => a.primerInicio - b.primerInicio)
  return grupos
}
