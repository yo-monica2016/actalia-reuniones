import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'

export type RolUsuario = 'admin' | 'usuario'

export interface AuthUser {
  id: number
  email: string
  nombre: string | null
  rol: RolUsuario
}

export function esAdmin(user: AuthUser): boolean {
  return user.rol === 'admin'
}

export async function fetchReunionForUser(
  pool: Pool,
  reunionId: number,
  user: AuthUser,
): Promise<RowDataPacket | null> {
  if (esAdmin(user)) {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [reunionId],
    )
    return rows[0] ?? null
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.*
     FROM reuniones r
     LEFT JOIN reunion_usuarios ru ON ru.reunion_id = r.id AND ru.usuario_id = ?
     WHERE r.id = ? AND (r.usuario_id = ? OR ru.usuario_id = ?)
     LIMIT 1`,
    [user.id, reunionId, user.id, user.id],
  )
  return rows[0] ?? null
}

export async function listReunionesForUser(
  pool: Pool,
  user: AuthUser,
): Promise<RowDataPacket[]> {
  if (esAdmin(user)) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, titulo, estado, creado_en, actualizado_en, usuario_id
       FROM reuniones
       ORDER BY creado_en DESC`,
    )
    return rows
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT r.id, r.titulo, r.estado, r.creado_en, r.actualizado_en, r.usuario_id
     FROM reuniones r
     LEFT JOIN reunion_usuarios ru ON ru.reunion_id = r.id AND ru.usuario_id = ?
     WHERE r.usuario_id = ? OR ru.usuario_id = ?
     ORDER BY r.creado_en DESC`,
    [user.id, user.id, user.id],
  )
  return rows
}

export async function archivoPerteneceAReunionVisible(
  pool: Pool,
  reunionId: number,
  archivoId: number,
  user: AuthUser,
): Promise<boolean> {
  const reunion = await fetchReunionForUser(pool, reunionId, user)
  if (!reunion) return false
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM archivos_reunion WHERE id = ? AND reunion_id = ? LIMIT 1',
    [archivoId, reunionId],
  )
  return Boolean(rows[0])
}
export async function listReunionesForUsuarioId(
  pool: Pool,
  usuarioId: number,
): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT r.id, r.titulo, r.estado, r.creado_en, r.actualizado_en, r.usuario_id
     FROM reuniones r
     LEFT JOIN reunion_usuarios ru ON ru.reunion_id = r.id AND ru.usuario_id = ?
     WHERE r.usuario_id = ? OR ru.usuario_id = ?
     ORDER BY r.creado_en DESC`,
    [usuarioId, usuarioId, usuarioId],
  )
  return rows
}
