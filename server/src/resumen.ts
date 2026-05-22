export interface TemaResumen {
  titulo: string
  resumen: string
}

export interface ResumenAlmacenado {
  global: string
  temas: TemaResumen[]
  porAudio: Record<string, string>
}

export function normalizarTemas(raw: unknown): TemaResumen[] {
  if (!Array.isArray(raw)) return []
  const out: TemaResumen[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const titulo = String((item as TemaResumen).titulo ?? '').trim()
    const resumen = String((item as TemaResumen).resumen ?? '').trim()
    if (titulo && resumen) out.push({ titulo, resumen })
  }
  return out
}

export function leerResumenAlmacenado(
  raw: string | null | undefined,
): ResumenAlmacenado {
  const t = String(raw ?? '').trim()
  if (!t) return { global: '', temas: [], porAudio: {} }
  if (t.startsWith('{')) {
    try {
      const p = JSON.parse(t) as ResumenAlmacenado
      return {
        global: String(p.global ?? '').trim(),
        temas: normalizarTemas(p.temas),
        porAudio:
          p.porAudio && typeof p.porAudio === 'object' ? p.porAudio : {},
      }
    } catch {
      return { global: t, temas: [], porAudio: {} }
    }
  }
  return {
    global: t.replace(/========== Audio:\s*.+?\s*==========\s*/g, '').trim(),
    temas: [],
    porAudio: {},
  }
}

export function formatearResumenParaDescarga(data: ResumenAlmacenado): string {
  const partes: string[] = []

  if (data.temas.length > 0) {
    const bloques = data.temas.map(
      (tema) => `## ${tema.titulo}\n\n${tema.resumen}`,
    )
    partes.push(`========== Temas tratados ==========\n\n${bloques.join('\n\n')}`)
  }

  for (const nombre of Object.keys(data.porAudio)) {
    const texto = data.porAudio[nombre]?.trim()
    if (texto) {
      partes.push(`========== ${nombre} ==========\n\n${texto}`)
    }
  }

  if (data.global.trim()) {
    const etiqueta =
      data.temas.length > 0 || Object.keys(data.porAudio).length > 0
        ? '========== Resumen general =========='
        : ''
    partes.push(
      etiqueta
        ? `${etiqueta}\n\n${data.global.trim()}`
        : data.global.trim(),
    )
  }

  return partes.join('\n\n')
}
