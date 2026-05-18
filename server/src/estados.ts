export const ESTADOS = [
  'borrador',
  'audio_listo',
  'transcribiendo',
  'transcrito',
  'resumiendo',
  'completado',
  'error',
] as const

export type EstadoReunion = (typeof ESTADOS)[number]

export const ESTADO_LABELS: Record<EstadoReunion, string> = {
  borrador: 'Borrador',
  audio_listo: 'Audio listo',
  transcribiendo: 'Transcribiendo…',
  transcrito: 'Transcrito',
  resumiendo: 'Generando resumen…',
  completado: 'Completado',
  error: 'Error',
}

export function esEstadoValido(value: string): value is EstadoReunion {
  return (ESTADOS as readonly string[]).includes(value)
}

export function etiquetaEstado(estado: string): string {
  if (esEstadoValido(estado)) return ESTADO_LABELS[estado]
  return estado
}
