import type { Request } from 'express'
import type { Pool } from 'mysql2/promise'

export type AccionRegistro =
  | 'login_ok'
  | 'login_fallido'
  | 'usuario_creado'
  | 'reunion_creada'
  | 'reunion_eliminada'
  | 'archivo_subido'
  | 'archivo_eliminado'
  | 'usuario_asignado'
  | 'usuario_quitado'
  | 'transcripcion_iniciada'
  | 'transcripcion_cancelada'
  | 'resumen_generado'

export interface RegistrarInput {
  usuarioId?: number | null
  email?: string | null
  accion: AccionRegistro | string
  reunionId?: number | null
  entidadTipo?: string | null
  entidadId?: number | null
  detalle?: Record<string, unknown> | null
  req?: Request
}

function clientIp(req?: Request): string | null {
  if (!req) return null
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string') return xf.split(',')[0]?.trim() ?? null
  return req.socket?.remoteAddress ?? null
}

/** Inserta un registro; no lanza error al caller si falla. */
export async function registrar(pool: Pool, input: RegistrarInput): Promise<void> {
  try {
    const detalleJson =
      input.detalle != null ? JSON.stringify(input.detalle) : null
    await pool.query(
      `INSERT INTO registros
        (usuario_id, email, accion, reunion_id, entidad_tipo, entidad_id, detalle, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.usuarioId ?? null,
        input.email ?? null,
        input.accion,
        input.reunionId ?? null,
        input.entidadTipo ?? null,
        input.entidadId ?? null,
        detalleJson,
        clientIp(input.req),
      ],
    )
  } catch (err) {
    console.error('[registros] no se pudo guardar:', err)
  }
}