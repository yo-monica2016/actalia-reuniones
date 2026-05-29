import type { Request, Response, NextFunction } from 'express'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { parseBearerToken, verifyToken } from './auth'
import type { AuthUser, RolUsuario } from './reunionAccess'

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: AuthUser
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = parseBearerToken(req.headers.authorization)
  if (!token) {
    res.status(401).json({ error: 'no autorizado: inicia sesión' })
    return
  }
  try {
    const payload = verifyToken(token)
    req.authUser = {
      id: payload.sub,
      email: payload.email,
      rol: payload.rol,
      nombre: null,
    }
    next()
  } catch {
    res.status(401).json({ error: 'sesión inválida o expirada' })
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'no autorizado' })
    return
  }
  if (req.authUser.rol !== 'admin') {
    res.status(403).json({ error: 'solo administradores' })
    return
  }
  next()
}

/** Enriquece req.authUser con nombre desde BD (opcional, tras verifyToken). */
export async function hydrateAuthUser(pool: Pool, req: Request): Promise<void> {
  if (!req.authUser) return
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, email, nombre, rol FROM usuarios WHERE id = ? LIMIT 1',
    [req.authUser.id],
  )
  const row = rows[0]
  if (!row) return
  req.authUser = {
    id: Number(row.id),
    email: String(row.email),
    nombre: row.nombre != null ? String(row.nombre) : null,
    rol: String(row.rol) as RolUsuario,
  }
}

export function apiRequiresAuth(path: string): boolean {
  if (!path.startsWith('/api')) return false
  if (path.startsWith('/api/auth/login')) return false
  return true
}
