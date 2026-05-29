import type { Express, Request, Response } from 'express'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import { requireAdmin, requireAuth } from './authMiddleware'

function parseOptionalId(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

function parseDetalle(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

export function registerRegistrosRoutes(app: Express, pool: Pool): void {
  app.get('/api/registros', requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const limitRaw = Number(req.query.limit ?? 100)
      const offsetRaw = Number(req.query.offset ?? 0)
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500)
      const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0)

      const reunionId = parseOptionalId(req.query.reunionId)
      const usuarioId = parseOptionalId(req.query.usuarioId)
      const accion =
        typeof req.query.accion === 'string' && req.query.accion.trim()
          ? req.query.accion.trim()
          : null
      const desde =
        typeof req.query.desde === 'string' && req.query.desde.trim()
          ? req.query.desde.trim()
          : null
      const hasta =
        typeof req.query.hasta === 'string' && req.query.hasta.trim()
          ? req.query.hasta.trim()
          : null

      const conditions: string[] = []
      const params: unknown[] = []

      if (reunionId != null) {
        conditions.push('r.reunion_id = ?')
        params.push(reunionId)
      }
      if (usuarioId != null) {
        conditions.push('r.usuario_id = ?')
        params.push(usuarioId)
      }
      if (accion) {
        conditions.push('r.accion = ?')
        params.push(accion)
      }
      if (desde) {
        conditions.push('r.creado_en >= ?')
        params.push(desde)
      }
      if (hasta) {
        conditions.push('r.creado_en <= ?')
        params.push(hasta.length <= 10 ? `${hasta} 23:59:59.999999` : hasta)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT r.id, r.usuario_id, r.email, r.accion, r.reunion_id, r.entidad_tipo, r.entidad_id,
                r.detalle, r.ip, r.creado_en,
                rev.titulo AS reunion_titulo
         FROM registros r
         LEFT JOIN reuniones rev ON rev.id = r.reunion_id
         ${where}
         ORDER BY r.creado_en DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )

      res.json(
        rows.map((row) => ({
          id: Number(row.id),
          usuario_id: row.usuario_id != null ? Number(row.usuario_id) : null,
          email: row.email != null ? String(row.email) : null,
          accion: String(row.accion),
          reunion_id: row.reunion_id != null ? Number(row.reunion_id) : null,
          reunion_titulo: row.reunion_titulo != null ? String(row.reunion_titulo) : null,
          entidad_tipo: row.entidad_tipo != null ? String(row.entidad_tipo) : null,
          entidad_id: row.entidad_id != null ? Number(row.entidad_id) : null,
          detalle: parseDetalle(row.detalle),
          ip: row.ip != null ? String(row.ip) : null,
          creado_en: String(row.creado_en),
        })),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })
}
