import type {
  ApiError,
  LoginResponse,
  Reunion,
  ReunionListItem,
  Registro,
  RegistrosFiltros,
  ReunionUsuariosResponse,
  ReunionInvitacion,
  EnviarInvitacionesResponse,
  Usuario,
  UsuarioListItem,
} from './types'
import { clearAuth, getToken, setAuth } from './authStorage'

/**
 * Dev: VITE_API_URL vacío → rutas relativas (/api, /health) pasan por el proxy de Vite → 127.0.0.1:3001.
 * Prod o override: VITE_API_URL=http://127.0.0.1:3001
 */
function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (import.meta.env.DEV) return ''
  return 'http://127.0.0.1:3001'
}

const API_BASE = resolveApiBase()

function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  return API_BASE ? `${API_BASE}${p}` : p
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getToken()
  return {
    ...(extra ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T | ApiError
  if (!res.ok) {
    const err = data as ApiError
    throw new Error(err.error ?? `Error ${res.status}`)
  }
  return data as T
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await parseJson<LoginResponse>(res)
  setAuth(data.token, data.usuario)
  return data
}

export function logout(): void {
  clearAuth()
}

export async function fetchMe(): Promise<Usuario> {
  const res = await fetch(apiUrl('/api/auth/me'), {
    headers: authHeaders(),
  })
  const data = await parseJson<{ usuario: Usuario }>(res)
  setAuth(getToken()!, data.usuario)
  return data.usuario
}

export async function listUsuarios(): Promise<UsuarioListItem[]> {
  const res = await fetch(apiUrl('/api/auth/usuarios'), {
    headers: authHeaders(),
  })
  return parseJson<UsuarioListItem[]>(res)
}
export async function listReunionesDeUsuario(usuarioId: number): Promise<ReunionListItem[]> {
  const res = await fetch(apiUrl(`/api/auth/usuarios/${usuarioId}/reuniones`), {
    headers: authHeaders(),
  })
  return parseJson<ReunionListItem[]>(res)
}

export async function crearUsuario(body: {
  email: string
  password: string
  nombre?: string
  rol?: 'admin' | 'usuario'
}): Promise<UsuarioListItem> {
  const res = await fetch(apiUrl('/api/auth/usuarios'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  return parseJson<UsuarioListItem>(res)
}
export async function listReunionUsuarios(
  reunionId: number,
): Promise<ReunionUsuariosResponse> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/usuarios`), {
    headers: authHeaders(),
  })
  return parseJson<ReunionUsuariosResponse>(res)
}

export async function asignarUsuarioReunion(
  reunionId: number,
  usuarioId: number,
): Promise<ReunionUsuariosResponse['asignados']> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/usuarios`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ usuarioId }),
  })
  const data = await parseJson<{ ok: boolean; asignados: ReunionUsuariosResponse['asignados'] }>(res)
  return data.asignados
}

export async function quitarUsuarioReunion(
  reunionId: number,
  usuarioId: number,
): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/usuarios/${usuarioId}`),
    { method: 'DELETE', headers: authHeaders() },
  )
  if (!res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function listRegistros(filtros: RegistrosFiltros = {}): Promise<Registro[]> {
  const params = new URLSearchParams()
  if (filtros.limit != null) params.set('limit', String(filtros.limit))
  if (filtros.offset != null) params.set('offset', String(filtros.offset))
  if (filtros.reunionId != null) params.set('reunionId', String(filtros.reunionId))
  if (filtros.usuarioId != null) params.set('usuarioId', String(filtros.usuarioId))
  if (filtros.accion?.trim()) params.set('accion', filtros.accion.trim())
  if (filtros.desde?.trim()) params.set('desde', filtros.desde.trim())
  if (filtros.hasta?.trim()) params.set('hasta', filtros.hasta.trim())
  const q = params.toString()
  const res = await fetch(apiUrl(`/api/registros${q ? `?${q}` : ''}`), {
    headers: authHeaders(),
  })
  return parseJson<Registro[]>(res)
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/health'))
    const data = (await res.json()) as { ok?: boolean }
    return res.ok && data.ok === true
  } catch {
    return false
  }
}

export async function listReuniones(): Promise<ReunionListItem[]> {
  const res = await fetch(apiUrl('/api/reuniones'), { headers: authHeaders() })
  return parseJson<ReunionListItem[]>(res)
}

export async function listReunionesPorHablanteUsuario(
  usuarioId: number,
): Promise<ReunionListItem[]> {
  const res = await fetch(apiUrl(`/api/reuniones?hablanteUsuarioId=${encodeURIComponent(String(usuarioId))}`), {
    headers: authHeaders(),
  })
  return parseJson<ReunionListItem[]>(res)
}

export async function getReunion(id: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${id}`), { headers: authHeaders() })
  return parseJson<Reunion>(res)
}

export async function createReunion(titulo: string): Promise<Reunion> {
  const res = await fetch(apiUrl('/api/reuniones'), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ titulo }),
  })
  return parseJson<Reunion>(res)
}

export async function uploadAudio(reunionId: number, file: File): Promise<Reunion> {
  const url = apiUrl(`/api/reuniones/${reunionId}/audio`)
  console.log('[api] POST uploadAudio →', url, `(${file.name}, ${file.size} bytes)`)
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  await parseJson<unknown>(res)
  console.log('[api] uploadAudio OK reunion=', reunionId)
  return getReunion(reunionId)
}
export async function uploadArchivo(reunionId: number, file: File): Promise<Reunion> {
  const url = apiUrl(`/api/reuniones/${reunionId}/archivo`)
  console.log('[api] POST uploadArchivo →', url, `(${file.name}, ${file.size} bytes)`)
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}
export async function transcribirReunion(
  reunionId: number,
  options?: { archivoId?: number; todos?: boolean },
  signal?: AbortSignal,
): Promise<Reunion> {
  const body: { archivoId?: number; todos?: boolean } = {}
  if (options?.archivoId != null) body.archivoId = options.archivoId
  if (options?.todos) body.todos = true

  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/transcribir`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}

export async function cancelarTranscripcion(reunionId: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/transcribir/cancelar`), {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseJson<Reunion>(res)
}

export async function eliminarArchivo(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}`), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return parseJson<Reunion>(res)
}

export async function eliminarReunion(reunionId: number): Promise<void> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}`), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function resumirReunion(reunionId: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/resumir`), {
    method: 'POST',
    headers: authHeaders(),
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}

export function archivoUrl(reunionId: number, archivoId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}`)
}

/** Carga archivo con JWT (para img/audio/video; el href directo no envía token). */
export async function fetchArchivoBlob(
  reunionId: number,
  archivoId: number,
): Promise<Blob> {
  const res = await fetch(archivoUrl(reunionId, archivoId), {
    headers: authHeaders(),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
  return res.blob()
}

export async function downloadUrlAutenticada(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
  const blob = await res.blob()
  const enlace = document.createElement('a')
  const objectUrl = URL.createObjectURL(blob)
  enlace.href = objectUrl
  enlace.download = filename
  document.body.appendChild(enlace)
  enlace.click()
  enlace.remove()
  URL.revokeObjectURL(objectUrl)
}

export function nombreArchivoDescarga(storageKey: string): string {
  const sinPrefijo = storageKey.replace(/^\d+-/, '')
  return sinPrefijo || storageKey
}

export async function downloadArchivo(
  reunionId: number,
  archivoId: number,
  storageKey: string,
): Promise<void> {
  const res = await fetch(
    `${archivoUrl(reunionId, archivoId)}?download=1`,
    { headers: authHeaders() },
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
  const blob = await res.blob()
  const enlace = document.createElement('a')
  const url = URL.createObjectURL(blob)
  enlace.href = url
  enlace.download = nombreArchivoDescarga(storageKey)
  document.body.appendChild(enlace)
  enlace.click()
  enlace.remove()
  URL.revokeObjectURL(url)
}

export async function extraerTextoImagen(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/ocr`), {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseJson<Reunion>(res)
}

export async function interpretarImagen(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/interpretar`),
    { method: 'POST', headers: authHeaders() },
  )
  return parseJson<Reunion>(res)
}

export async function setIncluirImagenActa(
  reunionId: number,
  archivoId: number,
  incluir: boolean,
): Promise<Reunion> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/incluir-imagen-acta`),
    {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ incluirImagenActa: incluir }),
    },
  )
  return parseJson<Reunion>(res)
}
export async function guardarNombresHablantes(
  reunionId: number,
  hablantes: Record<string, string>,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/hablantes`), {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ hablantes }),
  })
  return parseJson<Reunion>(res)
}
export async function getReunionParticipantes(reunionId: number): Promise<ReunionUsuariosResponse> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/participantes`), {
    headers: authHeaders(),
  })
  return parseJson<ReunionUsuariosResponse>(res)
}

export async function listInvitacionesReunion(
  reunionId: number,
): Promise<ReunionInvitacion[]> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/invitaciones`), {
    headers: authHeaders(),
  })
  return parseJson<ReunionInvitacion[]>(res)
}

export async function getConvocatoriaReunion(reunionId: number): Promise<{
  join_url: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
}> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/convocatoria`), {
    headers: authHeaders(),
  })
  return parseJson(res)
}

export async function enviarInvitacionesReunion(
  reunionId: number,
  body: {
    emails: string[]
    mensaje?: string
    teamsJoinUrl?: string
    fechaInicio?: string
    fechaFin?: string
  },
): Promise<EnviarInvitacionesResponse> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/invitaciones`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as EnviarInvitacionesResponse | ApiError
  if (!res.ok) {
    throw new Error((data as ApiError).error ?? `Error ${res.status}`)
  }
  return data as EnviarInvitacionesResponse
}

export async function getHablantesUsuarios(reunionId: number): Promise<Record<string, number>> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/hablantes-usuarios`), {
    headers: authHeaders(),
  })
  return parseJson<Record<string, number>>(res)
}

export async function setHablanteUsuario(
  reunionId: number,
  hablanteKey: string,
  usuarioId: number,
): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/hablantes-usuarios/${encodeURIComponent(hablanteKey)}`),
    {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ usuarioId }),
    },
  )
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function deleteHablanteUsuario(reunionId: number, hablanteKey: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/hablantes-usuarios/${encodeURIComponent(hablanteKey)}`),
    { method: 'DELETE', headers: authHeaders() },
  )
  if (!res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function setActaOpciones(
  reunionId: number,
  opciones: {
    incluirTranscripcionActa?: boolean
    incluirResumenActa?: boolean
  },
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/acta-opciones`), {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      incluirTranscripcionActa: opciones.incluirTranscripcionActa,
      incluirResumenActa: opciones.incluirResumenActa,
    }),
  })
  return parseJson<Reunion>(res)
}
export async function guardarFirmaActaSimulada(
  reunionId: number,
  firmaPng: Blob,
  firmante?: string,
): Promise<Reunion> {
  const form = new FormData()
  form.append('firma', firmaPng, 'firma.png')
  if (firmante?.trim()) {
    form.append('firmante', firmante.trim())
  }

  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/acta/firma-simulada`), {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  return parseJson<Reunion>(res)
}
export async function extraerTextoDocumento(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/texto`), {
    method: 'POST',
    headers: authHeaders(),
  })
  return parseJson<Reunion>(res)
}
export function transcripcionTxtUrl(reunionId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/transcripcion.txt`)
}

export function transcripcionPdfUrl(reunionId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/transcripcion.pdf`)
}
export function actaPdfUrl(reunionId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/acta.pdf`)
}
export function resumenPdfUrl(reunionId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/resumen.pdf`)
}

/** Texto para la UI (pill de conexión, mensajes de error). */
export const API_BASE_DISPLAY =
  API_BASE || 'http://127.0.0.1:3001 (proxy Vite en desarrollo)'

export { API_BASE }
