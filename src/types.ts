export type EstadoReunion =
  | 'borrador'
  | 'audio_listo'
  | 'transcribiendo'
  | 'transcrito'
  | 'resumiendo'
  | 'completado'
  | 'error'

export interface ArchivoReunion {
  id: number
  reunion_id: number
  tipo: 'audio' | 'video' | 'imagen' | 'documento'
  storage_key: string
  mime: string | null
  tamano_bytes: number | null
  duracion_segundos: number | null
  creado_en: string
  texto_ocr?: string | null
}

export interface Reunion {
  id: number
  titulo: string
  creado_en: string
  actualizado_en: string
  estado: EstadoReunion | string
  storage_key?: string | null
  mime_tipo?: string | null
  duracion_segundos?: number | null
  transcripcion?: string | null
  resumen?: string | null
  error_mensaje?: string | null
  meta?: unknown
  archivos?: ArchivoReunion[]
}

export interface ReunionListItem {
  id: number
  titulo: string
  estado: EstadoReunion | string
  creado_en: string
  actualizado_en: string
}

export interface ApiError {
  error: string
}
