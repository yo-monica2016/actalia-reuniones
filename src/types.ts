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
  /** 1 = incluir foto en acta.pdf cuando hay texto_ocr; 0 = solo texto */
  incluir_imagen_acta?: boolean | number |  string | null
}

export interface SegmentoTranscripcion {
  speaker: string
  start: number
  end: number
  text: string
}

/** Clave = speaker del modelo (A, B…); valor = nombre mostrado (ej. Luis). */
export type MapaHablantes = Record<string, string>

export interface TranscripcionJsonGuardada {
  diarizada: boolean
  segmentos: SegmentoTranscripcion[]
  hablantes?: MapaHablantes
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
  transcripcion_json?: string | TranscripcionJsonGuardada | null
  transcripcion_aviso?: string | null
  resumen?: string | null
  incluir_transcripcion_acta?: boolean | number | string | null
  incluir_resumen_acta?: boolean | number | string | null
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

export type RolUsuario = 'admin' | 'usuario'

export interface Usuario {
  id: number
  email: string
  nombre: string | null
  rol: RolUsuario
}

export interface UsuarioListItem extends Usuario {
  creado_en?: string
}

export interface LoginResponse {
  token: string
  usuario: Usuario
}
export interface ReunionUsuarioAcceso {
  id: number
  email: string
  nombre: string | null
  asignado_en?: string
}

export interface ReunionUsuariosResponse {
  dueno: ReunionUsuarioAcceso | null
  asignados: ReunionUsuarioAcceso[]
}

export interface Registro {
  id: number
  usuario_id: number | null
  email: string | null
  accion: string
  reunion_id: number | null
  reunion_titulo: string | null
  entidad_tipo: string | null
  entidad_id: number | null
  detalle: Record<string, unknown> | null
  ip: string | null
  creado_en: string
}

export interface RegistrosFiltros {
  limit?: number
  offset?: number
  reunionId?: number
  usuarioId?: number
  accion?: string
  desde?: string
  hasta?: string
}
