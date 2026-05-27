import type { ApiError, Reunion, ReunionListItem } from './types'

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

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T | ApiError
  if (!res.ok) {
    const err = data as ApiError
    throw new Error(err.error ?? `Error ${res.status}`)
  }
  return data as T
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
  const res = await fetch(apiUrl('/api/reuniones'))
  return parseJson<ReunionListItem[]>(res)
}

export async function getReunion(id: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${id}`))
  return parseJson<Reunion>(res)
}

export async function createReunion(titulo: string): Promise<Reunion> {
  const res = await fetch(apiUrl('/api/reuniones'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}

export async function cancelarTranscripcion(reunionId: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/transcribir/cancelar`), {
    method: 'POST',
  })
  return parseJson<Reunion>(res)
}

export async function eliminarArchivo(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}`), {
    method: 'DELETE',
  })
  return parseJson<Reunion>(res)
}

export async function eliminarReunion(reunionId: number): Promise<void> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}`), {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function resumirReunion(reunionId: number): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/resumir`), {
    method: 'POST',
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}
export function archivoUrl(reunionId: number, archivoId: number): string {
  return apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}`)
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
  })
  return parseJson<Reunion>(res)
}

export async function interpretarImagen(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(
    apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/interpretar`),
    { method: 'POST' },
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
      headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hablantes }),
  })
  return parseJson<Reunion>(res)
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      incluirTranscripcionActa: opciones.incluirTranscripcionActa,
      incluirResumenActa: opciones.incluirResumenActa,
    }),
  })
  return parseJson<Reunion>(res)
}
export async function extraerTextoDocumento(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(apiUrl(`/api/reuniones/${reunionId}/archivos/${archivoId}/texto`), {
    method: 'POST',
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
