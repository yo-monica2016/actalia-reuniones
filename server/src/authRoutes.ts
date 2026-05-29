import type { Express, Request, Response } from 'express'
import type { Pool } from 'mysql2/promise'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import { hashPassword, signToken, verifyPassword } from './auth'
import { hydrateAuthUser, requireAdmin, requireAuth } from './authMiddleware'
import { registrar } from './registros'
import { listReunionesForUsuarioId } from './reunionAccess'
import type { RolUsuario } from './reunionAccess'


export function registerAuthRoutes(app: Express, pool: Pool): void {
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!email || !password) {
      res.status(400).json({ error: 'email y contraseña requeridos' })
      return
    }
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT id, email, password_hash, nombre, rol FROM usuarios WHERE email = ? LIMIT 1',
        [email],
      )
      const row = rows[0]
      if (!row) {
        void registrar(pool, {
          email,
          accion: 'login_fallido',
          detalle: { motivo: 'email_desconocido' },
          req,
        })
        res.status(401).json({ error: 'credenciales incorrectas' })
        return
      }
      const ok = await verifyPassword(password, String(row.password_hash))
      if (!ok) {
        void registrar(pool, {
          email,
          accion: 'login_fallido',
          detalle: { motivo: 'password_incorrecta' },
          req,
        })
        res.status(401).json({ error: 'credenciales incorrectas' })
        return
      }
      const rol = String(row.rol) as RolUsuario
      const user = {
        id: Number(row.id),
        email: String(row.email),
        nombre: row.nombre != null ? String(row.nombre) : null,
        rol,
      }
      const token = signToken({ sub: user.id, email: user.email, rol: user.rol })
      void registrar(pool, {
        usuarioId: user.id,
        email: user.email,
        accion: 'login_ok',
        req,
      })
      res.json({ token, usuario: user })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })

  app.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
    try {
      await hydrateAuthUser(pool, req)
      if (!req.authUser) {
        res.status(401).json({ error: 'no autorizado' })
        return
      }
      res.json({ usuario: req.authUser })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  })

  app.get(
    '/api/auth/usuarios',
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
      try {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT id, email, nombre, rol, creado_en FROM usuarios ORDER BY creado_en DESC`,
        )
        res.json(rows)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.status(500).json({ error: message })
      }
    },
  )

  app.post(
    '/api/auth/usuarios',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const email =
        typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      const nombre =
        typeof req.body?.nombre === 'string' ? req.body.nombre.trim() || null : null
      const rolRaw = (typeof req.body?.rol === 'string' ? req.body.rol : 'usuario').toLowerCase()
      if (!email || !password) {
        res.status(400).json({ error: 'email y contraseña requeridos' })
        return
      }
      if (rolRaw !== 'admin' && rolRaw !== 'usuario') {
        res.status(400).json({ error: 'rol debe ser admin o usuario' })
        return
      }
      if (password.length < 6) {
        res.status(400).json({ error: 'contraseña mínimo 6 caracteres' })
        return
      }
      try {
        const passwordHash = await hashPassword(password)
        const [result] = await pool.query<ResultSetHeader>(
          `INSERT INTO usuarios (email, password_hash, nombre, rol) VALUES (?, ?, ?, ?)`,
          [email, passwordHash, nombre, rolRaw],
        )
        void registrar(pool, {
          usuarioId: req.authUser?.id,
          email: req.authUser?.email,
          accion: 'usuario_creado',
          entidadTipo: 'usuario',
          entidadId: result.insertId,
          detalle: { email, rol: rolRaw, nombre },
          req,
        })
        res.status(201).json({
          id: result.insertId,
          email,
          nombre,
          rol: rolRaw,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Duplicate') || msg.includes('duplicate')) {
          res.status(409).json({ error: 'ya existe ese email' })
          return
        }
        res.status(500).json({ error: msg })
      }
    },
  )
  app.get(
    '/api/auth/usuarios/:id/reuniones',
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'id inválido' })
        return
      }
      try {
        const [uRows] = await pool.query<RowDataPacket[]>(
          'SELECT id FROM usuarios WHERE id = ? LIMIT 1',
          [id],
        )
        if (!uRows[0]) {
          res.status(404).json({ error: 'usuario no encontrado' })
          return
        }
        const rows = await listReunionesForUsuarioId(pool, id)
        res.json(rows)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.status(500).json({ error: message })
      }
    },
  )
}
