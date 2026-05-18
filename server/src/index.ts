import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import multer from 'multer'
import mysql from 'mysql2/promise'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import PDFDocument from 'pdfkit'
import { etiquetaEstado } from './estados'

const PORT = Number(process.env.PORT) || 3001

function parseId(raw: string | string[]): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}
function nombreArchivoDescarga(titulo: string, id: number, ext: string): string {
  const base =
    titulo
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'reunion'
  return `${base}_${id}.${ext}`
}
const uploadsDir = path.join(__dirname, '..', 'uploads')

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}
function whisperTxtPath(storageKey: string): string {
  const base = path.parse(storageKey).name
  return path.join(uploadsDir, `${base}.txt`)
}

function runWhisper(audioPath: string): Promise<void> {
  const python = process.env.PYTHON_CMD ?? 'py'
  const model = process.env.WHISPER_MODEL ?? 'base'
  return new Promise((resolve, reject) => {
    const args = [
      '-m',
      'whisper',
      audioPath,
      '--language',
      'Spanish',
      '--model',
      model,
      '--output_dir',
      uploadsDir,
      '--output_format',
      'txt',
    ]
    const child = spawn(python, args, {
      cwd: uploadsDir,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `Whisper terminó con código ${code}`))
    })
  })
}
function generarResumenDesdeTranscripcion(transcripcion: string): string {
  const limpio = transcripcion.replace(/\s+/g, ' ').trim()
  if (!limpio) return ''

  const oraciones = limpio.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
  const maxOraciones = Number(process.env.RESUMEN_MAX_ORACIONES ?? 4)
  const porOraciones = oraciones.slice(0, maxOraciones).join(' ').trim()

  if (porOraciones.length >= 40) return porOraciones

  const maxChars = Number(process.env.RESUMEN_MAX_CHARS ?? 500)
  if (limpio.length <= maxChars) return limpio
  return `${limpio.slice(0, maxChars).trim()}…`
}

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'actalia_reuniones',
  waitForConnections: true,
  connectionLimit: 10,
})

function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  const configured = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
  const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.includes(origin)) return true
  // Vite puede usar 5174, 5175… si el puerto por defecto está ocupado
  if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost:517\d+$/.test(origin)) {
    return true
  }
  return false
}

const app = express()
app.use(
  cors({
    origin(origin, callback) {
      if (isCorsOriginAllowed(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)
app.use(express.json())

app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Actalia reuniones — API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
    h1 { font-size: 1.25rem; }
    a { color: #2563eb; }
    code { background: #f1f5f9; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    ul { padding-left: 1.25rem; }
  </style>
</head>
<body>
  <h1>API Actalia reuniones</h1>
  <p>Servidor en marcha. Rutas útiles:</p>
  <ul>
    <li><a href="/health"><code>GET /health</code></a> — comprobar conexión a la base de datos</li>
    <li><code>GET /api/reuniones</code> — listar reuniones</li>
    <li><code>POST /api/reuniones</code> — crear reunión (JSON: <code>{"titulo":"..."}</code>)</li>
    <li><code>GET /api/reuniones/:id</code> — obtener una reunión (con archivos)</li>
        <li><code>GET /api/reuniones/:id/archivos/:archivoId</code> — descargar o reproducir archivo</li>
  </ul>
</body>
</html>`)
})

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_')
    cb(null, `${Date.now()}-${safe}`)
  },
})

const upload = multer({ storage })

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1 AS ok')
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: message })
  }
})

app.get('/api/reuniones', async (_req: Request, res: Response) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, titulo, estado, creado_en, actualizado_en
       FROM reuniones
       ORDER BY creado_en DESC`,
    )
    res.json(
      rows.map((row) => ({
        ...row,
        estado_etiqueta: etiquetaEstado(String(row.estado)),
      })),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.post('/api/reuniones', async (req: Request, res: Response) => {
  const titulo = typeof req.body?.titulo === 'string' ? req.body.titulo.trim() : ''
  if (!titulo) {
    res.status(400).json({ error: 'titulo requerido' })
    return
  }
  try {
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO reuniones (titulo, estado) VALUES (?, ?)',
      [titulo, 'borrador'],
    )
    const id = result.insertId
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(500).json({ error: 'no se pudo leer la reunión creada' })
      return
    }
    res.status(201).json(row)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/reuniones/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'no encontrado' })
      return
    }
    const [archivos] = await pool.query<RowDataPacket[]>(
      `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en
       FROM archivos_reunion
       WHERE reunion_id = ?
       ORDER BY creado_en DESC`,
      [id],
    )
    res.json({
      ...row,
      estado_etiqueta: etiquetaEstado(String(row.estado)),
      archivos,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})
app.get('/api/reuniones/:id/transcripcion.txt', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT titulo, transcripcion FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    const transcripcion = String(row.transcripcion ?? '').trim()
    if (!transcripcion) {
      res.status(404).json({ error: 'no hay transcripción' })
      return
    }

    const titulo = String(row.titulo ?? 'reunion')
    const filename = nombreArchivoDescarga(titulo, id, 'txt')

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(transcripcion)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/reuniones/:id/transcripcion.pdf', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT titulo, transcripcion, creado_en FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    const transcripcion = String(row.transcripcion ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    if (!transcripcion) {
      res.status(404).json({ error: 'no hay transcripción' })
      return
    }

    const titulo = String(row.titulo ?? 'Reunión')
    const filename = nombreArchivoDescarga(titulo, id, 'pdf')
    const fecha = row.creado_en
      ? new Date(String(row.creado_en)).toLocaleString('es-ES')
      : ''

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    const doc = new PDFDocument({ margin: 50 })
    doc.pipe(res)

    doc.fontSize(16).text(titulo, { underline: true })
    doc.moveDown(0.5)
    if (fecha) {
      doc.fontSize(10).fillColor('#444444').text(fecha)
    }
    doc.moveDown()
    doc.fontSize(11).fillColor('#000000').text('Transcripción', { underline: true })
    doc.moveDown(0.5)
    doc.text(transcripcion, { align: 'left', lineGap: 4 })

    doc.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) {
      res.status(500).json({ error: message })
    }
  }
})

app.delete('/api/reuniones/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [archivos] = await pool.query<RowDataPacket[]>(
      'SELECT id, storage_key FROM archivos_reunion WHERE reunion_id = ?',
      [id],
    )

    for (const a of archivos) {
      const storageKey = String(a.storage_key ?? '')
      if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) continue

      const filePath = path.join(uploadsDir, storageKey)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

      const txtPath = whisperTxtPath(storageKey)
      if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath)
    }

    await pool.query('DELETE FROM archivos_reunion WHERE reunion_id = ?', [id])
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM reuniones WHERE id = ?',
      [id],
    )

    if (result.affectedRows === 0) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    res.status(204).send()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})


app.post(
  '/api/reuniones/:id/audio',
  upload.single('file'),
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }
    try {
      const [existing] = await pool.query<RowDataPacket[]>(
        'SELECT id FROM reuniones WHERE id = ? LIMIT 1',
        [id],
      )
      if (!existing[0]) {
        res.status(404).json({ error: 'reunión no encontrada' })
        return
      }
      if (!req.file) {
        res.status(400).json({ error: 'falta archivo (campo multipart: file)' })
        return
      }
      const storageKey = req.file.filename
      const mime = req.file.mimetype
      const tamanoBytes = req.file.size
      const isVideo = mime.startsWith('video/')
      const tipo = isVideo ? 'video' : 'audio'

      const [insertFile] = await pool.query<ResultSetHeader>(
        `INSERT INTO archivos_reunion (reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [id, tipo, storageKey, mime, tamanoBytes],
      )

      await pool.query(
        `UPDATE reuniones SET estado = ?, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
        ['audio_listo', id],
      )

      res.status(201).json({
        reunion_id: id,
        archivo_id: insertFile.insertId,
        storage_key: storageKey,
        mime,
        tamano_bytes: tamanoBytes,
        tipo,
        estado: 'audio_listo',
        estado_etiqueta: etiquetaEstado('audio_listo'),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)
app.post('/api/reuniones/:id/transcribir', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [reunionRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    if (!reunionRows[0]) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    
    const archivoIdRaw = req.body?.archivoId
    let storageKey = ''

    if (archivoIdRaw != null && archivoIdRaw !== '') {
      const archivoId = parseId(String(archivoIdRaw))
      if (archivoId === null) {
        res.status(400).json({ error: 'archivoId inválido' })
        return
      }
      const [archivoRows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, id],
      )
      if (!archivoRows[0]) {
        res.status(404).json({ error: 'archivo no encontrado para esta reunión' })
        return
      }
      storageKey = String(archivoRows[0].storage_key ?? '')
    } else {
      const [archivoRows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key FROM archivos_reunion
         WHERE reunion_id = ?
         ORDER BY creado_en DESC
         LIMIT 1`,
        [id],
      )
      storageKey = archivoRows[0] ? String(archivoRows[0].storage_key ?? '') : ''
    }
    if (!storageKey) {
      res.status(400).json({ error: 'no hay audio subido para esta reunión' })
      return
    }

    const audioPath = path.join(uploadsDir, storageKey)
    if (!fs.existsSync(audioPath)) {
      res.status(404).json({ error: 'archivo de audio no encontrado en disco' })
      return
    }

    await pool.query(
      `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['transcribiendo', id],
    )

    await runWhisper(audioPath)

    const txtPath = whisperTxtPath(storageKey)
    if (!fs.existsSync(txtPath)) {
      throw new Error('Whisper no generó el archivo de texto')
    }
    const transcripcion = fs.readFileSync(txtPath, 'utf8').trim()
    if (!transcripcion) {
      throw new Error('la transcripción está vacía')
    }

    await pool.query(
      `UPDATE reuniones SET estado = ?, transcripcion = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['transcrito', transcripcion, id],
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en
       FROM archivos_reunion WHERE reunion_id = ? ORDER BY creado_en DESC`,
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(500).json({ error: 'no se pudo leer la reunión actualizada' })
      return
    }

    res.json({
      ...row,
      estado_etiqueta: etiquetaEstado(String(row.estado)),
      archivos,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await pool.query(
        `UPDATE reuniones SET estado = ?, error_mensaje = ?, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
        ['error', message.slice(0, 2000), id],
      )
    } catch {
      /* ignorar error al guardar estado error */
    }
    res.status(500).json({ error: message })
  }
})

app.post('/api/reuniones/:id/resumir', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [reunionRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, transcripcion FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const reunion = reunionRows[0]
    if (!reunion) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    const transcripcion = String(reunion.transcripcion ?? '').trim()
    if (!transcripcion) {
      res.status(400).json({ error: 'primero hay que transcribir el audio' })
      return
    }

    await pool.query(
      `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['resumiendo', id],
    )

    const resumen = generarResumenDesdeTranscripcion(transcripcion)
    if (!resumen) {
      throw new Error('no se pudo generar el resumen')
    }

    await pool.query(
      `UPDATE reuniones SET estado = ?, resumen = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['completado', resumen, id],
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en
       FROM archivos_reunion WHERE reunion_id = ? ORDER BY creado_en DESC`,
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(500).json({ error: 'no se pudo leer la reunión actualizada' })
      return
    }

    res.json({
      ...row,
      estado_etiqueta: etiquetaEstado(String(row.estado)),
      archivos,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      await pool.query(
        `UPDATE reuniones SET estado = ?, error_mensaje = ?, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
        ['error', message.slice(0, 2000), id],
      )
    } catch {
      /* ignorar */
    }
    res.status(500).json({ error: message })
  }
})
app.get('/api/reuniones/:reunionId/archivos/:archivoId', async (req: Request, res: Response) => {
  const reunionId = parseId(req.params.reunionId)
  const archivoId = parseId(req.params.archivoId)
  if (reunionId === null || archivoId === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT storage_key, mime, tipo
       FROM archivos_reunion
       WHERE id = ? AND reunion_id = ?
       LIMIT 1`,
      [archivoId, reunionId],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'archivo no encontrado' })
      return
    }
    const storageKey = String(row.storage_key ?? '')
    if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
      res.status(404).json({ error: 'archivo inválido' })
      return
    }
    const filePath = path.join(uploadsDir, storageKey)
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'archivo no encontrado en disco' })
      return
    }
    const mime = row.mime ? String(row.mime) : 'application/octet-stream'
    res.type(mime)
    res.sendFile(path.resolve(filePath))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})
app.delete(
  '/api/reuniones/:reunionId/archivos/:archivoId',
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.reunionId)
    const archivoId = parseId(req.params.archivoId)
    if (reunionId === null || archivoId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, reunionId],
      )
      const row = rows[0]
      if (!row) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }

      const storageKey = String(row.storage_key ?? '')
      if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
        res.status(404).json({ error: 'archivo inválido' })
        return
      }

      const filePath = path.join(uploadsDir, storageKey)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }

      const txtPath = whisperTxtPath(storageKey)
      if (fs.existsSync(txtPath)) {
        fs.unlinkSync(txtPath)
      }

      await pool.query('DELETE FROM archivos_reunion WHERE id = ? AND reunion_id = ?', [
        archivoId,
        reunionId,
      ])

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en
         FROM archivos_reunion WHERE reunion_id = ? ORDER BY creado_en DESC`,
        [reunionId],
      )
      const reunion = reunionRows[0]
      if (!reunion) {
        res.status(404).json({ error: 'reunión no encontrada' })
        return
      }

      res.json({
        ...reunion,
        estado_etiqueta: etiquetaEstado(String(reunion.estado)),
        archivos,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err)
  res.status(500).json({ error: message })
})

app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}`)
})
