import type { ApiError, Reunion, ReunionListItem } from './types'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

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
    const res = await fetch(`${API_BASE}/health`)
    const data = (await res.json()) as { ok?: boolean }
    return res.ok && data.ok === true
  } catch {
    return false
  }
}

export async function listReuniones(): Promise<ReunionListItem[]> {
  const res = await fetch(`${API_BASE}/api/reuniones`)
  return parseJson<ReunionListItem[]>(res)
}

export async function getReunion(id: number): Promise<Reunion> {
  const res = await fetch(`${API_BASE}/api/reuniones/${id}`)
  return parseJson<Reunion>(res)
}

export async function createReunion(titulo: string): Promise<Reunion> {
  const res = await fetch(`${API_BASE}/api/reuniones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titulo }),
  })
  return parseJson<Reunion>(res)
}

export async function uploadAudio(reunionId: number, file: File): Promise<Reunion> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API_BASE}/api/reuniones/${reunionId}/audio`, {
    method: 'POST',
    body: form,
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}
export async function uploadArchivo(reunionId: number, file: File): Promise<Reunion> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API_BASE}/api/reuniones/${reunionId}/archivo`, {
    method: 'POST',
    body: form,
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}
export async function transcribirReunion(
  reunionId: number,
  options?: { archivoId?: number; todos?: boolean },
): Promise<Reunion> {
  const body: { archivoId?: number; todos?: boolean } = {}
  if (options?.archivoId != null) body.archivoId = options.archivoId
  if (options?.todos) body.todos = true

  const res = await fetch(`${API_BASE}/api/reuniones/${reunionId}/transcribir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}

export async function eliminarArchivo(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(
    `${API_BASE}/api/reuniones/${reunionId}/archivos/${archivoId}`,
    { method: 'DELETE' },
  )
  return parseJson<Reunion>(res)
}

export async function eliminarReunion(reunionId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/reuniones/${reunionId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as ApiError
    throw new Error(data.error ?? `Error ${res.status}`)
  }
}

export async function resumirReunion(reunionId: number): Promise<Reunion> {
  const res = await fetch(`${API_BASE}/api/reuniones/${reunionId}/resumir`, {
    method: 'POST',
  })
  await parseJson<unknown>(res)
  return getReunion(reunionId)
}
export function archivoUrl(reunionId: number, archivoId: number): string {
  return `${API_BASE}/api/reuniones/${reunionId}/archivos/${archivoId}`
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
  const res = await fetch(
    `${API_BASE}/api/reuniones/${reunionId}/archivos/${archivoId}/ocr`,
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
    `${API_BASE}/api/reuniones/${reunionId}/archivos/${archivoId}/incluir-imagen-acta`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incluirImagenActa: incluir }),
    },
  )
  return parseJson<Reunion>(res)
}
export async function extraerTextoDocumento(
  reunionId: number,
  archivoId: number,
): Promise<Reunion> {
  const res = await fetch(
    `${API_BASE}/api/reuniones/${reunionId}/archivos/${archivoId}/texto`,
    { method: 'POST' },
  )
  return parseJson<Reunion>(res)
}
export function transcripcionTxtUrl(reunionId: number): string {
  return `${API_BASE}/api/reuniones/${reunionId}/transcripcion.txt`
}

export function transcripcionPdfUrl(reunionId: number): string {
  return `${API_BASE}/api/reuniones/${reunionId}/transcripcion.pdf`
}
export function actaPdfUrl(reunionId: number): string {
  return `${API_BASE}/api/reuniones/${reunionId}/acta.pdf`
}
export function resumenTxtUrl(reunionId: number): string {
  return `${API_BASE}/api/reuniones/${reunionId}/resumen.txt`
}


export { API_BASE }
