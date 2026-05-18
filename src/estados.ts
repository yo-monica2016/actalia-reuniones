export const ESTADO_LABELS: Record<string, string> = {
  borrador: 'Borrador',
  audio_listo: 'Audio listo',
  transcribiendo: 'Transcribiendo…',
  transcrito: 'Transcrito',
  resumiendo: 'Generando resumen…',
  completado: 'Completado',
  error: 'Error',
}

export function etiquetaEstado(estado: string): string {
  return ESTADO_LABELS[estado] ?? estado
}
