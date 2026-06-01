import './loadEnv'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { PDFParse } from 'pdf-parse'
import JSZip from 'jszip'
import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import multer from 'multer'
import mysql from 'mysql2/promise'
import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import PDFDocument from 'pdfkit'
import { etiquetaEstado } from './estados'
import { whisperTxtPath } from './transcripcion'
import {
  limpiarTemporales,
  transcribirAudioConPipeline,
} from './audioPipeline'
import {
  normalizarMapaHablantes,
  parseTranscripcionJsonAlmacenado,
  segmentosATextoPlano,
} from './hablantes'
import {
  formatearResumenParaDescarga,
  leerResumenAlmacenado,
  type ResumenAlmacenado,
} from './resumen'
import { escribirPdfActa } from './pdfActa'
import {
  OPENAI_MAX_AUDIO_BYTES,
  interpretarImagenOpenAi,
  openAiConfigured,
  resumirTranscripcionOpenAi,
  useOpenAiSummary,
  useOpenAiTranscription,
  type SegmentoDiarizado,
} from './openai'
import { registerAuthRoutes } from './authRoutes'
import { apiRequiresAuth, requireAuth } from './authMiddleware'
import {
  ensureRegistrosTable,
  ensureReunionesUsuarioId,
  ensureReunionInvitacionesTable,
  ensureReunionTeamsTable,
  ensureReunionUsuariosTable,
  ensureUsuariosMicrosoftColumns,
  ensureUsuariosTable,
} from './ensureAuthSchema'
import { enviarInvitacionReunion, isSmtpConfigured } from './email'
import { registrar } from './registros'
import { registerRegistrosRoutes } from './registrosRoutes'
import { requireAdmin } from './authMiddleware'
import {
  archivoPerteneceAReunionVisible,
  esAdmin,
  fetchReunionForUser,
  listReunionesForUser,
  type AuthUser,
} from './reunionAccess'

const PORT = Number(process.env.PORT) || 3001
/** Reuniones cuya transcripción debe abortarse (Parar en el front). */
const transcripcionCanceladas = new Set<number>()

class TranscripcionCanceladaError extends Error {
  constructor() {
    super('Transcripción cancelada')
    this.name = 'TranscripcionCanceladaError'
  }
}

async function aplicarCancelacionTranscripcionEnBd(reunionId: number): Promise<void> {
  await pool.query(
    `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
    ['audio_listo', reunionId],
  )
}

function comprobarCancelacionTranscripcion(reunionId: number): void {
  if (!transcripcionCanceladas.has(reunionId)) return
  transcripcionCanceladas.delete(reunionId)
  throw new TranscripcionCanceladaError()
}

function parseEmailsInvitacion(raw: unknown): string[] {
  let list: string[] = []
  if (Array.isArray(raw)) {
    list = raw.map((x) => String(x).trim().toLowerCase())
  } else if (typeof raw === 'string') {
    list = raw.split(/[,;]+/).map((s) => s.trim().toLowerCase())
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return [...new Set(list.filter((e) => emailRe.test(e)))]
}
function toMysqlDatetime(iso: string | null): string | null {
  if (!iso?.trim()) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function parseId(raw: string | string[]): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}

function authUser(req: Request): AuthUser {
  return req.authUser!
}

function logRegistro(
  req: Request,
  data: {
    accion: string
    reunionId?: number | null
    entidadTipo?: string | null
    entidadId?: number | null
    detalle?: Record<string, unknown> | null
    usuarioId?: number | null
    email?: string | null
  },
): void {
  const u = req.authUser
  void registrar(pool, {
    usuarioId: data.usuarioId ?? u?.id ?? null,
    email: data.email ?? u?.email ?? null,
    accion: data.accion,
    reunionId: data.reunionId ?? null,
    entidadTipo: data.entidadTipo ?? null,
    entidadId: data.entidadId ?? null,
    detalle: data.detalle ?? null,
    req,
  })
}

async function reunionVisibleOr404(
  req: Request,
  res: Response,
  reunionId: number,
): Promise<RowDataPacket | null> {
  const row = await fetchReunionForUser(pool, reunionId, authUser(req))
  if (!row) {
    res.status(404).json({ error: 'no encontrado' })
    return null
  }
  return row
}
async function reunionExistsForAdminOr404(
  res: Response,
  reunionId: number,
): Promise<RowDataPacket | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, usuario_id FROM reuniones WHERE id = ? LIMIT 1',
    [reunionId],
  )
  const row = rows[0]
  if (!row) {
    res.status(404).json({ error: 'no encontrado' })
    return null
  }
  return row
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
function clasificarTipoArchivo(mime: string, originalname: string): string {
  const lower = originalname.toLowerCase()
  if (mime.startsWith('image/')) return 'imagen'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (
    lower.endsWith('.pptx') ||
    lower.endsWith('.ppt') ||
    lower.endsWith('.pdf') ||
    lower.endsWith('.odp') ||
    mime.includes('presentation') ||
    mime === 'application/pdf'
  ) {
    return 'documento'
  }
  return 'documento'
}

const serverRoot = path.join(__dirname, '..')

const uploadsDir = path.join(serverRoot, 'uploads')
const projectTessdataDir = path.join(serverRoot, 'tessdata')

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}
const firmasDir = path.join(uploadsDir, 'firmas')
if (!fs.existsSync(firmasDir)) {
  fs.mkdirSync(firmasDir, { recursive: true })
}
if (!fs.existsSync(projectTessdataDir)) {
  fs.mkdirSync(projectTessdataDir, { recursive: true })
}

/** Rutas para Tesseract: en Windows el prefijo suele ser la carpeta tessdata (archivos .traineddata dentro). */
function resolveOcrTessdata(language: string): { langFile: string; tessdataPrefix: string } {
  const prefixes: string[] = []
  const envPrefix = process.env.TESSDATA_PREFIX?.trim()
  if (envPrefix) prefixes.push(envPrefix)
  prefixes.push(projectTessdataDir, serverRoot)
  const tesseractCmd = process.env.TESSERACT_CMD?.trim()
  if (tesseractCmd) {
    prefixes.push(path.join(path.dirname(tesseractCmd), 'tessdata'))
    prefixes.push(path.dirname(tesseractCmd))
  }

  const seen = new Set<string>()
  for (const prefix of prefixes) {
    const key = path.resolve(prefix)
    if (seen.has(key)) continue
    seen.add(key)

    const directFile = path.join(prefix, `${language}.traineddata`)
    if (fs.existsSync(directFile)) {
      return { langFile: directFile, tessdataPrefix: prefix }
    }

    const nestedFile = path.join(prefix, 'tessdata', `${language}.traineddata`)
    if (fs.existsSync(nestedFile)) {
      return { langFile: nestedFile, tessdataPrefix: path.join(prefix, 'tessdata') }
    }
  }

  const expected = path.join(projectTessdataDir, `${language}.traineddata`)
  throw new Error(
    `Falta el idioma OCR "${language}" en ${expected}. Descarga ${language}.traineddata en server/tessdata.`,
  )
}
function encabezadoTranscripcionArchivo(storageKey: string): string {
  const nombre = storageKey.replace(/^\d+-/, '') || storageKey
  return `========== Audio: ${nombre} ==========`
}
interface TranscripcionResult {
  texto: string
  segmentos: SegmentoDiarizado[]
  diarizada: boolean
  aviso?: string
}

interface TranscripcionJsonAlmacenada {
  diarizada: boolean
  segmentos: SegmentoDiarizado[]
  hablantes?: Record<string, string>
}

async function transcribirStorageKey(storageKey: string): Promise<TranscripcionResult> {
  console.log(`[transcripcion] entrada storageKey=${storageKey}`)
  if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
    throw new Error('archivo de audio inválido')
  }
  const audioPath = path.join(uploadsDir, storageKey)
  if (!fs.existsSync(audioPath)) {
    throw new Error(`archivo de audio no encontrado: ${storageKey}`)
  }

  const stat = fs.statSync(audioPath)
  const tamanoMb = stat.size / (1024 * 1024)
  const demasiadoGrande = stat.size > OPENAI_MAX_AUDIO_BYTES
  const avisoTamano = demasiadoGrande
    ? `Este audio pesa ${tamanoMb.toFixed(1)} MB. Se procesará con compresión y/o fragmentos antes de transcribir.`
    : undefined

  if (!useOpenAiTranscription() || !openAiConfigured()) {
    throw new Error(
      'Transcripción no disponible: configura TRANSCRIPTION_PROVIDER=openai y OPENAI_API_KEY en server/.env',
    )
  }

  const temporales: string[] = []
  try {
    console.log(`[transcripcion] pipeline OpenAI (comprimir/trocear/diarize): ${storageKey}`)
    const resultado = await transcribirAudioConPipeline(audioPath, uploadsDir)
    temporales.push(...resultado.temporales)
    const txtPath = whisperTxtPath(uploadsDir, storageKey)
    fs.writeFileSync(txtPath, resultado.texto, 'utf8')
    console.log(`[transcripcion] pipeline terminó: ${storageKey}`)
    const aviso = [avisoTamano, resultado.aviso].filter(Boolean).join(' ') || undefined
    return {
      texto: resultado.texto,
      segmentos: resultado.segmentos,
      diarizada: resultado.diarizada,
      aviso,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[transcripcion] pipeline OpenAI falló (${storageKey}):`, msg)
    if (msg.includes('ffmpeg') || msg.includes('FFmpeg')) {
      throw new Error(
        'FFmpeg no está disponible en el servidor. Ejecuta npm install en server/ o define FFMPEG_PATH en server/.env',
      )
    }
    throw new Error(`Transcripción OpenAI falló: ${msg}`)
  } finally {
    limpiarTemporales(temporales)
  }
}
async function generarResumenCompletoAsync(
  transcripcion: string,
  tituloReunion?: string,
): Promise<ResumenAlmacenado> {
  if (useOpenAiSummary()) {
    try {
      console.log('[resumen] OpenAI')
      const data = await resumirTranscripcionOpenAi(transcripcion, tituloReunion)
      const porAudio: Record<string, string> = {}
      for (const [k, v] of Object.entries(data.porAudio)) {
        porAudio[nombreVisibleArchivo(k)] = v
      }
      let global = data.global.trim()
      if (!global && Object.keys(porAudio).length === 1) {
        global = Object.values(porAudio)[0] ?? ''
      }
      if (!global && Object.keys(porAudio).length > 1) {
        global = Object.entries(porAudio)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n\n')
      }
      return {
        global,
        temas: data.temas,
        porAudio,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[resumen] OpenAI falló, usando resumen local:', msg)
    }
  }
  return generarResumenCompleto(transcripcion)
}

function runOcr(imagePath: string): Promise<string> {
  const tesseract = process.env.TESSERACT_CMD ?? 'tesseract'
  const lang = process.env.OCR_LANG ?? 'spa'
  let tessdataPrefix: string
  try {
    ; ({ tessdataPrefix } = resolveOcrTessdata(lang))
  } catch (err) {
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(tesseract, [imagePath, 'stdout', '-l', lang], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TESSDATA_PREFIX: tessdataPrefix,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        const texto = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
        resolve(texto)
      } else {
        reject(new Error(stderr.trim() || `OCR terminó con código ${code}`))
      }
    })
  })
}
function esArchivoPdf(mime: string | null, storageKey: string): boolean {
  const lower = storageKey.toLowerCase()
  return lower.endsWith('.pdf') || mime === 'application/pdf'
}

function esArchivoPptx(mime: string | null, storageKey: string): boolean {
  const lower = storageKey.toLowerCase()
  return (
    lower.endsWith('.pptx') ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  )
}

function esArchivoPptAntiguo(storageKey: string): boolean {
  return storageKey.toLowerCase().endsWith('.ppt')
}

async function extractTextFromPdf(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return (result.text ?? '').replace(/\r\n/g, '\n').trim()
  } finally {
    await parser.destroy()
  }
}

async function extractTextFromPptx(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(buffer)
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)?.[1] ?? 0)
      const nb = Number(b.match(/slide(\d+)/)?.[1] ?? 0)
      return na - nb
    })

  const bloques: string[] = []
  for (const name of slideNames) {
    const entry = zip.file(name)
    if (!entry) continue
    const xml = await entry.async('string')
    const textos = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]?.trim() ?? '')
    const linea = textos.filter(Boolean).join(' ')
    if (linea) bloques.push(linea)
  }
  return bloques.join('\n\n').trim()
}

async function extractTextFromDocument(
  filePath: string,
  mime: string | null,
  storageKey: string,
): Promise<string> {
  if (esArchivoPptAntiguo(storageKey)) {
    throw new Error('El formato .ppt antiguo no está soportado. Guarda la presentación como .pptx.')
  }
  if (esArchivoPdf(mime, storageKey)) {
    return extractTextFromPdf(filePath)
  }
  if (esArchivoPptx(mime, storageKey)) {
    return extractTextFromPptx(filePath)
  }
  throw new Error('Solo se puede extraer texto de PDF o PowerPoint (.pptx)')
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

function extraerBloquesTranscripcion(transcripcion: string): { nombre: string; cuerpo: string }[] {
  const t = transcripcion.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!t) return []

  const bloques: { nombre: string; cuerpo: string }[] = []
  const re = /========== Audio:\s*(.+?)\s*==========\n*/g
  let m: RegExpExecArray | null
  let lastIndex = 0
  while ((m = re.exec(t)) !== null) {
    if (m.index > lastIndex) {
      const prev = t.slice(lastIndex, m.index).trim()
      if (prev) bloques.push({ nombre: 'Intro', cuerpo: prev })
    }
    const start = m.index + m[0].length
    const rest = t.slice(start)
    const nextMatch = rest.search(/\n========== Audio:/)
    const cuerpo = (nextMatch === -1 ? rest : rest.slice(0, nextMatch)).trim()
    bloques.push({ nombre: m[1].trim(), cuerpo })
    lastIndex = nextMatch === -1 ? t.length : start + nextMatch
  }

  if (bloques.length === 0) {
    return [{ nombre: 'Transcripción', cuerpo: t }]
  }
  return bloques
}

function generarResumenCompleto(transcripcion: string): ResumenAlmacenado {
  const bloques = extraerBloquesTranscripcion(transcripcion)
  const porAudio: Record<string, string> = {}

  for (const b of bloques) {
    const cuerpo = b.cuerpo.trim()
    if (!cuerpo) continue
    const nombre = nombreVisibleArchivo(b.nombre)
    const mini = generarResumenDesdeTranscripcion(cuerpo)
    if (mini) porAudio[nombre] = mini
  }

  const keys = Object.keys(porAudio)
  let global = ''
  if (keys.length === 0) {
    global = generarResumenDesdeTranscripcion(transcripcion)
  } else if (keys.length === 1) {
    global = porAudio[keys[0]] ?? ''
  } else {
    const textoParaGlobal = keys.map((k) => `${k}: ${porAudio[k]}`).join('\n\n')
    global =
      generarResumenDesdeTranscripcion(textoParaGlobal) || textoParaGlobal.slice(0, 500)
  }

  return { global, temas: [], porAudio }
}

function nombreVisibleArchivo(storageKey: string): string {
  const sinPrefijo = storageKey.replace(/^\d+-/, '')
  return sinPrefijo || storageKey
}

const ARCHIVOS_LIST_SELECT = `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en, texto_ocr, incluir_imagen_acta
       FROM archivos_reunion`

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'actalia_reuniones',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  connectTimeout: 10_000,
})

function isUnknownColumnError(err: unknown, column: string): boolean {
  const e = err as { code?: string; errno?: number; sqlMessage?: string }
  if (e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054) return true
  const msg = String(e?.sqlMessage ?? err ?? '')
  return msg.includes(column) && msg.includes('Unknown column')
}

async function ensureIncluirImagenActaColumn(): Promise<void> {
  try {
    await pool.query('SELECT incluir_imagen_acta FROM archivos_reunion LIMIT 0')
    return
  } catch (err) {
    if (!isUnknownColumnError(err, 'incluir_imagen_acta')) throw err
  }
  await pool.query(`
    ALTER TABLE archivos_reunion
      ADD COLUMN incluir_imagen_acta TINYINT(1) NOT NULL DEFAULT 1
      COMMENT '1=incluir foto en acta PDF'
      AFTER texto_ocr
  `)
  console.log('[db] columna incluir_imagen_acta creada')
}
async function ensureActaOpcionesColumn(): Promise<void> {
  try {
    await pool.query(
      'SELECT incluir_transcripcion_acta, incluir_resumen_acta FROM reuniones LIMIT 0',
    )
    return
  } catch (err) {
    if (!isUnknownColumnError(err, 'incluir_transcripcion_acta')) throw err
  }
  await pool.query(`
    ALTER TABLE reuniones
      ADD COLUMN incluir_transcripcion_acta TINYINT(1) NOT NULL DEFAULT 1,
      ADD COLUMN incluir_resumen_acta TINYINT(1) NOT NULL DEFAULT 1
  `)
  console.log('[db] columnas incluir_transcripcion_acta e incluir_resumen_acta creadas')
}

async function ensureFirmaActaSimuladaColumns(): Promise<void> {
  try {
    await pool.query(
      'SELECT firma_acta_tipo, firma_acta_png, firma_acta_firmada_en, firma_acta_firmante FROM reuniones LIMIT 0',
    )
    return
  } catch (err) {
    if (!isUnknownColumnError(err, 'firma_acta_tipo')) throw err
  }
  await pool.query(`
    ALTER TABLE reuniones
      ADD COLUMN firma_acta_tipo VARCHAR(20) NULL,
      ADD COLUMN firma_acta_png VARCHAR(500) NULL,
      ADD COLUMN firma_acta_firmada_en DATETIME(6) NULL,
      ADD COLUMN firma_acta_firmante VARCHAR(200) NULL
  `)
  console.log('[db] columnas firma_acta_* creadas')
}

async function ensureTranscripcionDiarizacionColumn(): Promise<void> {
  try {
    await pool.query(
      'SELECT transcripcion_json, transcripcion_aviso FROM reuniones LIMIT 0',
    )
    return
  } catch (err) {
    if (!isUnknownColumnError(err, 'transcripcion_json')) throw err
  }
  await pool.query(`
    ALTER TABLE reuniones
      ADD COLUMN transcripcion_json LONGTEXT NULL,
      ADD COLUMN transcripcion_aviso VARCHAR(600) NULL
  `)
  console.log('[db] columnas transcripcion_json y transcripcion_aviso creadas')
}

function isCorsOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  const configured =
    process.env.CORS_ORIGIN ??
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:5175,http://127.0.0.1:5175'
  const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowed.includes(origin)) return true
  // Desarrollo: cualquier puerto de Vite en localhost (5173, 5174, 5175…)
  if (
    process.env.NODE_ENV !== 'production' &&
    /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
  ) {
    return true
  }
  return false
}

const app = express()
app.use(
  cors({
    origin(origin, callback) {
      if (isCorsOriginAllowed(origin)) {
        callback(null, origin ?? true)
      } else {
        console.warn(`[cors] origen rechazado: ${origin ?? '(vacío)'}`)
        callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
)
app.use(express.json())

app.use((req: Request, res: Response, next: NextFunction) => {
  const inicio = Date.now()
  const cl = req.headers['content-length'] ?? '-'
  console.log(`[http] --> ${req.method} ${req.originalUrl} content-length=${cl}`)
  res.on('finish', () => {
    console.log(
      `[http] <-- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - inicio}ms`,
    )
  })
  next()
})

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

const UPLOAD_MAX_BYTES = 100 * 1024 * 1024
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_BYTES },
})
const FIRMA_MAX_BYTES = 2 * 1024 * 1024

const uploadFirma = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, firmasDir)
    },
    filename: (req, _file, cb) => {
      const reunionId = parseId(req.params.id) ?? 0
      cb(null, `firma-${reunionId}-${Date.now()}.png`)
    },
  }),
  limits: { fileSize: FIRMA_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') {
      cb(null, true)
      return
    }
    cb(new Error('la firma debe ser PNG o JPEG'))
  },
})

function multerFirmaSingle(campo: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    uploadFirma.single(campo)(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err)
        res.status(400).json({ error: msg })
        return
      }
      next()
    })
  }
}

/** Logs por paso: si se congela, la última línea indica dónde. */
function multerSingle(campo: string, ruta: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const reunionId = req.params.id
    const cl = req.headers['content-length'] ?? '?'
    console.log(
      `[upload] 1/5 ${ruta} reunion=${reunionId} — esperando multipart (${cl} bytes máx ${UPLOAD_MAX_BYTES})`,
    )
    upload.single(campo)(req, res, (err: unknown) => {
      if (err) {
        console.error(`[upload] multer ERROR reunion=${reunionId}:`, err)
        const msg = err instanceof Error ? err.message : String(err)
        res.status(400).json({ error: msg })
        return
      }
      if (req.file) {
        console.log(
          `[upload] 2/5 multer OK reunion=${reunionId} → ${req.file.filename} (${req.file.size} bytes, ${req.file.mimetype})`,
        )
      } else {
        console.warn(`[upload] 2/5 multer sin archivo en campo "${campo}" reunion=${reunionId}`)
      }
      next()
    })
  }
}

app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1 AS ok')
    res.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ ok: false, error: message })
  }
})

registerAuthRoutes(app, pool)
registerRegistrosRoutes(app, pool)

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!apiRequiresAuth(req.path)) {
    next()
    return
  }
  requireAuth(req, res, next)
})

app.get('/api/reuniones', async (req: Request, res: Response) => {
  try {
    const hablanteUsuarioIdRaw = req.query.hablanteUsuarioId
    const hablanteUsuarioId = Number(hablanteUsuarioIdRaw)
    const u = authUser(req)

    if (Number.isInteger(hablanteUsuarioId) && hablanteUsuarioId > 0) {
      if (u.rol === 'admin') {
        const [rows] = await pool.query<RowDataPacket[]>(
          `SELECT DISTINCT r.id, r.titulo, r.estado, r.creado_en, r.actualizado_en, r.usuario_id
           FROM reuniones r
           INNER JOIN reunion_hablante_usuario rhu ON rhu.reunion_id = r.id
           WHERE rhu.usuario_id = ?
           ORDER BY r.creado_en DESC`,
          [hablanteUsuarioId],
        )
        res.json(
          rows.map((row) => ({
            ...row,
            estado_etiqueta: etiquetaEstado(String(row.estado)),
          })),
        )
        return
      }

      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT DISTINCT r.id, r.titulo, r.estado, r.creado_en, r.actualizado_en, r.usuario_id
         FROM reuniones r
         LEFT JOIN reunion_usuarios ru ON ru.reunion_id = r.id AND ru.usuario_id = ?
         INNER JOIN reunion_hablante_usuario rhu ON rhu.reunion_id = r.id AND rhu.usuario_id = ?
         WHERE r.usuario_id = ? OR ru.usuario_id = ?
         ORDER BY r.creado_en DESC`,
        [u.id, hablanteUsuarioId, u.id, u.id],
      )
      res.json(
        rows.map((row) => ({
          ...row,
          estado_etiqueta: etiquetaEstado(String(row.estado)),
        })),
      )
      return
    }

    const rows = await listReunionesForUser(pool, u)
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
      'INSERT INTO reuniones (titulo, estado, usuario_id) VALUES (?, ?, ?)',
      [titulo, 'borrador', authUser(req).id],
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
    logRegistro(req, {
      accion: 'reunion_creada',
      reunionId: id,
      entidadTipo: 'reunion',
      entidadId: id,
      detalle: { titulo },
    })
    res.status(201).json(row)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get(
  '/api/reuniones/:id/usuarios',
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }
    try {
      const reunion = await reunionExistsForAdminOr404(res, id)
      if (!reunion) return

      const [asignados] = await pool.query<RowDataPacket[]>(
        `SELECT u.id, u.email, u.nombre, ru.creado_en AS asignado_en
         FROM reunion_usuarios ru
         INNER JOIN usuarios u ON u.id = ru.usuario_id
         WHERE ru.reunion_id = ?
         ORDER BY u.email`,
        [id],
      )

      let dueno: RowDataPacket | null = null
      const duenoId = reunion.usuario_id != null ? Number(reunion.usuario_id) : null
      if (duenoId) {
        const [duenoRows] = await pool.query<RowDataPacket[]>(
          'SELECT id, email, nombre FROM usuarios WHERE id = ? LIMIT 1',
          [duenoId],
        )
        dueno = duenoRows[0] ?? null
      }

      res.json({ dueno, asignados })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)

app.post(
  '/api/reuniones/:id/usuarios',
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }
    const usuarioId = Number(req.body?.usuarioId)
    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      res.status(400).json({ error: 'usuarioId inválido' })
      return
    }
    try {
      const reunion = await reunionExistsForAdminOr404(res, id)
      if (!reunion) return

      const [uRows] = await pool.query<RowDataPacket[]>(
        'SELECT id, email FROM usuarios WHERE id = ? LIMIT 1',
        [usuarioId],
      )
      if (!uRows[0]) {
        res.status(404).json({ error: 'usuario no encontrado' })
        return
      }

      await pool.query(
        'INSERT IGNORE INTO reunion_usuarios (reunion_id, usuario_id) VALUES (?, ?)',
        [id, usuarioId],
      )

      const [asignados] = await pool.query<RowDataPacket[]>(
        `SELECT u.id, u.email, u.nombre, ru.creado_en AS asignado_en
         FROM reunion_usuarios ru
         INNER JOIN usuarios u ON u.id = ru.usuario_id
         WHERE ru.reunion_id = ?
         ORDER BY u.email`,
        [id],
      )
      logRegistro(req, {
        accion: 'usuario_asignado',
        reunionId: id,
        entidadTipo: 'usuario',
        entidadId: usuarioId,
        detalle: { usuario_email: String(uRows[0].email) },
      })
      res.status(201).json({ ok: true, asignados })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)

app.delete(
  '/api/reuniones/:id/usuarios/:usuarioId',
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id)
    const usuarioId = parseId(req.params.usuarioId)
    if (id === null || usuarioId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }
    try {
      const reunion = await reunionExistsForAdminOr404(res, id)
      if (!reunion) return

      await pool.query(
        'DELETE FROM reunion_usuarios WHERE reunion_id = ? AND usuario_id = ?',
        [id, usuarioId],
      )
      logRegistro(req, {
        accion: 'usuario_quitado',
        reunionId: id,
        entidadTipo: 'usuario',
        entidadId: usuarioId,
      })
      res.status(204).send()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  },
)

app.get('/api/reuniones/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const row = await reunionVisibleOr404(req, res, id)
    if (!row) return
    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT}
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
    const row = await reunionVisibleOr404(req, res, id)
    if (!row) return

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
    const row = await reunionVisibleOr404(req, res, id)
    if (!row) return

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

app.get('/api/reuniones/:id/resumen.pdf', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const row = await reunionVisibleOr404(req, res, id)
    if (!row) return

    const cuerpo = formatearResumenParaDescarga(leerResumenAlmacenado(row.resumen))
    if (!cuerpo) {
      res.status(404).json({ error: 'no hay resumen' })
      return
    }

    const titulo = String(row.titulo ?? 'Reunión')
    const filename = `resumen_${nombreArchivoDescarga(titulo, id, 'pdf')}`
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
    doc.fontSize(11).fillColor('#000000').text('Resumen', { underline: true })
    doc.moveDown(0.5)
    doc.text(cuerpo, { align: 'left', lineGap: 4 })

    doc.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) {
      res.status(500).json({ error: message })
    }
  }
})

app.get('/api/reuniones/:id/acta.pdf', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const [archivos] = await pool.query<RowDataPacket[]>(
      `SELECT id, tipo, storage_key, duracion_segundos, texto_ocr, incluir_imagen_acta FROM archivos_reunion
       WHERE reunion_id = ? ORDER BY creado_en ASC`,
      [id],
    )

    const resumen = String(reunion.resumen ?? '').trim()
    const transcripcion = String(reunion.transcripcion ?? '').trim()
    const hayTextoAdjuntos = archivos.some((a) => String(a.texto_ocr ?? '').trim())

    if (!resumen && !transcripcion && !hayTextoAdjuntos && archivos.length === 0) {
      res.status(404).json({ error: 'no hay contenido para generar el acta' })
      return
    }

    const titulo = String(reunion.titulo ?? 'Reunión')
    const filename = `acta_${nombreArchivoDescarga(titulo, id, 'pdf')}`

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    const doc = new PDFDocument({ margin: 72, size: 'A4', bufferPages: true })
    doc.pipe(res)
    await escribirPdfActa(doc, reunion, archivos, uploadsDir)
    doc.end()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!res.headersSent) {
      res.status(500).json({ error: message })
    }
  }
})
app.post(
  '/api/reuniones/:id/acta/firma-simulada',
  multerFirmaSingle('firma'),
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.id)
    if (reunionId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    if (!req.file) {
      res.status(400).json({ error: 'falta el archivo de firma (campo "firma")' })
      return
    }

    try {
      const reunionCheck = await reunionVisibleOr404(req, res, reunionId)
      if (!reunionCheck) return

      const u = authUser(req)
      const firmanteRaw = String(req.body?.firmante ?? '').trim()
      const firmante =
        firmanteRaw ||
        String(u.nombre ?? '').trim() ||
        u.email ||
        'INPRO'

      const relPath = path.join('firmas', req.file.filename).replace(/\\/g, '/')

      const vieja = String(reunionCheck.firma_acta_png ?? '').trim()
      if (vieja) {
        const viejaAbs = path.join(uploadsDir, vieja.replace(/\//g, path.sep))
        if (viejaAbs.startsWith(firmasDir) && fs.existsSync(viejaAbs)) {
          try {
            fs.unlinkSync(viejaAbs)
          } catch {
            /* ignorar */
          }
        }
      }

      await pool.query(
        `UPDATE reuniones SET
          firma_acta_tipo = ?,
          firma_acta_png = ?,
          firma_acta_firmada_en = CURRENT_TIMESTAMP(6),
          firma_acta_firmante = ?,
          actualizado_en = CURRENT_TIMESTAMP(6)
        WHERE id = ?`,
        ['simulada', relPath, firmante.slice(0, 200), reunionId],
      )

      logRegistro(req, {
        accion: 'firma_acta_simulada',
        reunionId,
        entidadTipo: 'reunion',
        entidadId: reunionId,
        detalle: { firmante, path: relPath },
      })

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path)
        } catch {
          /* ignorar */
        }
      }
      res.status(500).json({ error: message })
    }
  },
)
app.delete('/api/reuniones/:id', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    if (!esAdmin(authUser(req))) {
      res.status(403).json({ error: 'solo administradores' })
      return
    }

    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const tituloReunion = String(reunion.titulo ?? '')

    const [archivos] = await pool.query<RowDataPacket[]>(
      'SELECT id, storage_key FROM archivos_reunion WHERE reunion_id = ?',
      [id],
    )

    for (const a of archivos) {
      const storageKey = String(a.storage_key ?? '')
      if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) continue

      const filePath = path.join(uploadsDir, storageKey)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

      const txtPath = whisperTxtPath(uploadsDir, storageKey)
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

    logRegistro(req, {
      accion: 'reunion_eliminada',
      reunionId: id,
      entidadTipo: 'reunion',
      entidadId: id,
      detalle: { titulo: tituloReunion },
    })
    res.status(204).send()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})


async function handleSubirArchivoReunion(req: Request, res: Response) {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  console.log(`[upload] 3/5 handler inicio reunion=${id}`)
  try {
    console.log(`[upload] 4/5 consultando reunión en BD reunion=${id}`)
    const existingRow = await reunionVisibleOr404(req, res, id)
    if (!existingRow) return
    const existing = [existingRow]
    if (!req.file) {
      res.status(400).json({ error: 'falta archivo (campo multipart: file)' })
      return
    }
    const storageKey = req.file.filename
    const mime = req.file.mimetype
    const tamanoBytes = req.file.size
    const tipo = clasificarTipoArchivo(mime, req.file.originalname)
    const diskPath = path.join(uploadsDir, storageKey)
    const enDisco = fs.existsSync(diskPath)
    console.log(
      `[upload] 4/5 archivo en disco=${enDisco} tipo=${tipo} path=${diskPath}`,
    )

    console.log(`[upload] 5/5 INSERT archivos_reunion reunion=${id}`)
    const insertSql =
      tipo === 'imagen'
        ? `INSERT INTO archivos_reunion (reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, incluir_imagen_acta)
           VALUES (?, ?, ?, ?, ?, NULL, 1)`
        : `INSERT INTO archivos_reunion (reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos)
           VALUES (?, ?, ?, ?, ?, NULL)`
    const [insertFile] = await pool.query<ResultSetHeader>(insertSql, [
      id,
      tipo,
      storageKey,
      mime,
      tamanoBytes,
    ])

    if (tipo === 'audio' || tipo === 'video') {
      await pool.query(
        `UPDATE reuniones SET estado = ?, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
        ['audio_listo', id],
      )
    } else {
      await pool.query(
        `UPDATE reuniones SET actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
        [id],
      )
    }

    const [reunionRows] = await pool.query<RowDataPacket[]>(
      'SELECT estado FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const estado = String(reunionRows[0]?.estado ?? existing[0].estado ?? 'borrador')

    console.log(
      `[upload] 5/5 OK reunion=${id} archivo_id=${insertFile.insertId} estado=${estado}`,
    )
    logRegistro(req, {
      accion: 'archivo_subido',
      reunionId: id,
      entidadTipo: 'archivo',
      entidadId: insertFile.insertId,
      detalle: { storage_key: storageKey, tipo, mime },
    })
    res.status(201).json({
      reunion_id: id,
      archivo_id: insertFile.insertId,
      storage_key: storageKey,
      mime,
      tamano_bytes: tamanoBytes,
      tipo,
      estado,
      estado_etiqueta: etiquetaEstado(estado),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[upload] ERROR reunion=${id}:`, message)
    res.status(500).json({ error: message })
  }
}

app.post(
  '/api/reuniones/:id/audio',
  multerSingle('file', 'POST /audio'),
  handleSubirArchivoReunion,
)
app.post(
  '/api/reuniones/:id/archivo',
  multerSingle('file', 'POST /archivo'),
  handleSubirArchivoReunion,
)
app.post('/api/reuniones/:id/transcribir/cancelar', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const row = await reunionVisibleOr404(req, res, id)
    if (!row) return

    transcripcionCanceladas.add(id)
    await aplicarCancelacionTranscripcionEnBd(id)
    console.log(`[transcribir] cancelación solicitada reunion=${id}`)
    logRegistro(req, {
      accion: 'transcripcion_cancelada',
      reunionId: id,
      entidadTipo: 'reunion',
      entidadId: id,
    })

    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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
app.post('/api/reuniones/:id/transcribir', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  console.log(`[transcribir] 1/6 inicio reunion=${id} body=${JSON.stringify(req.body ?? {})}`)

  try {
    console.log(`[transcribir] 2/6 comprobando reunión en BD reunion=${id}`)
    const reunionCheck = await reunionVisibleOr404(req, res, id)
    if (!reunionCheck) return

    transcripcionCanceladas.delete(id)

    const todos = req.body?.todos === true || req.body?.todos === 'true'
    const archivoIdRaw = req.body?.archivoId

    let storageKeys: string[] = []

    if (todos) {
      const [archivoRows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key FROM archivos_reunion
         WHERE reunion_id = ? AND tipo IN ('audio', 'video')
         ORDER BY creado_en ASC`,
        [id],
      )
      if (!archivoRows.length) {
        res.status(400).json({ error: 'no hay audio ni vídeo subido para esta reunión' })
        return
      }
      storageKeys = archivoRows.map((row) => String(row.storage_key ?? '')).filter(Boolean)
    } else {
      let storageKey = ''

      if (archivoIdRaw != null && archivoIdRaw !== '') {
        const archivoId = parseId(String(archivoIdRaw))
        if (archivoId === null) {
          res.status(400).json({ error: 'archivoId inválido' })
          return
        }
        const [archivoRows] = await pool.query<RowDataPacket[]>(
          `SELECT storage_key, tipo FROM archivos_reunion
           WHERE id = ? AND reunion_id = ?
           LIMIT 1`,
          [archivoId, id],
        )
        if (!archivoRows[0]) {
          res.status(404).json({ error: 'archivo no encontrado para esta reunión' })
          return
        }
        const tipoArchivo = String(archivoRows[0].tipo ?? '')
        if (tipoArchivo !== 'audio' && tipoArchivo !== 'video') {
          res.status(400).json({ error: 'solo se puede transcribir archivos de audio o vídeo' })
          return
        }
        storageKey = String(archivoRows[0].storage_key ?? '')
      } else {
        const [archivoRows] = await pool.query<RowDataPacket[]>(
          `SELECT storage_key FROM archivos_reunion
           WHERE reunion_id = ? AND tipo IN ('audio', 'video')
           ORDER BY creado_en DESC
           LIMIT 1`,
          [id],
        )
        storageKey = archivoRows[0] ? String(archivoRows[0].storage_key ?? '') : ''
      }

      if (!storageKey) {
        res.status(400).json({ error: 'no hay audio ni vídeo subido para esta reunión' })
        return
      }
      storageKeys = [storageKey]
    }

    console.log(
      `[transcribir] 3/6 archivos a procesar (${storageKeys.length}): ${storageKeys.join(', ')}`,
    )

    await pool.query(
      `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['transcribiendo', id],
    )
    logRegistro(req, {
      accion: 'transcripcion_iniciada',
      reunionId: id,
      entidadTipo: 'reunion',
      entidadId: id,
      detalle: {
        todos: req.body?.todos === true || req.body?.todos === 'true',
        archivoId: req.body?.archivoId ?? null,
        numArchivos: storageKeys.length,
      },
    })

    let transcripcion = ''
    const partes: string[] = []
    const avisos: string[] = []
    const jsonAlmacenado: TranscripcionJsonAlmacenada = {
      diarizada: false,
      segmentos: [],
    }

    for (const storageKey of storageKeys) {
      comprobarCancelacionTranscripcion(id)
      console.log(`[transcribir] 4/6 transcribiendo storageKey=${storageKey}`)
      const resultado = await transcribirStorageKey(storageKey)
      console.log(`[transcribir] 5/6 terminó storageKey=${storageKey} chars=${resultado.texto.length}`)
      if (resultado.aviso) avisos.push(resultado.aviso)
      if (resultado.diarizada && resultado.segmentos.length > 0) {
        jsonAlmacenado.diarizada = true
        jsonAlmacenado.segmentos.push(...resultado.segmentos)
      }
      const bloqueTexto = resultado.texto
      if (storageKeys.length > 1) {
        partes.push(`${encabezadoTranscripcionArchivo(storageKey)}\n\n${bloqueTexto}`)
      } else {
        transcripcion = bloqueTexto
      }
    }
    if (partes.length > 0) {
      transcripcion = partes.join('\n\n').trim()
    }

    comprobarCancelacionTranscripcion(id)

    const transcripcionAviso =
      [...new Set(avisos.map((a) => a.trim()).filter(Boolean))].join(' ') || null
    const transcripcionJson =
      jsonAlmacenado.segmentos.length > 0 || jsonAlmacenado.diarizada
        ? JSON.stringify(jsonAlmacenado)
        : null

    console.log(`[transcribir] 6/6 guardando en BD reunion=${id}`)
    await pool.query(
      `UPDATE reuniones SET estado = ?, transcripcion = ?, transcripcion_json = ?, transcripcion_aviso = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['transcrito', transcripcion, transcripcionJson, transcripcionAviso, id],
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(500).json({ error: 'no se pudo leer la reunión actualizada' })
      return
    }

    console.log(`[transcribir] 6/6 OK reunion=${id}`)
    res.json({
      ...row,
      estado_etiqueta: etiquetaEstado(String(row.estado)),
      archivos,
    })
  } catch (err) {
    if (err instanceof TranscripcionCanceladaError) {
      console.log(`[transcribir] cancelada reunion=${id}`)
      try {
        await aplicarCancelacionTranscripcionEnBd(id)
      } catch {
        /* ignorar */
      }
      if (!res.headersSent) {
        res.status(200).json({ ok: true, cancelada: true })
      }
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[transcribir] ERROR reunion=${id}:`, message)
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

app.patch('/api/reuniones/:id/hablantes', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  const hablantesEntrada = normalizarMapaHablantes(req.body?.hablantes)

  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const json = parseTranscripcionJsonAlmacenado(
      String(reunion.transcripcion_json ?? ''),
    )
    if (!json?.diarizada || json.segmentos.length === 0) {
      res.status(400).json({
        error: 'esta reunión no tiene transcripción diarizada con segmentos',
      })
      return
    }

    const speakers = new Set(
      json.segmentos.map((s) => s.speaker.trim() || '?'),
    )
    const hablantes: Record<string, string> = {}
    for (const [key, nombre] of Object.entries(hablantesEntrada)) {
      if (speakers.has(key)) hablantes[key] = nombre
    }

    const jsonActualizado: TranscripcionJsonAlmacenada = {
      diarizada: json.diarizada,
      segmentos: json.segmentos,
      ...(Object.keys(hablantes).length > 0 ? { hablantes } : {}),
    }
    const transcripcion = segmentosATextoPlano(json.segmentos, hablantes)
    const transcripcionJson = JSON.stringify(jsonActualizado)

    await pool.query(
      `UPDATE reuniones SET transcripcion = ?, transcripcion_json = ?, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      [transcripcion, transcripcionJson, id],
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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
    res.status(500).json({ error: message })
  }
})
async function usuarioTieneAccesoAReunion(reunionId: number, usuarioId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.id
     FROM reuniones r
     LEFT JOIN reunion_usuarios ru ON ru.reunion_id = r.id AND ru.usuario_id = ?
     WHERE r.id = ? AND (r.usuario_id = ? OR ru.usuario_id = ?)
     LIMIT 1`,
    [usuarioId, reunionId, usuarioId, usuarioId],
  )
  return Boolean(rows[0])
}

// Lista de participantes (dueño + asignados) accesible también para usuarios con acceso
app.get('/api/reuniones/:id/participantes', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const duenoId = reunion.usuario_id != null ? Number(reunion.usuario_id) : null
    let dueno: { id: number; email: string; nombre: string | null } | null = null

    if (duenoId != null && Number.isInteger(duenoId) && duenoId > 0) {
      const [duenoRows] = await pool.query<RowDataPacket[]>(
        'SELECT id, email, nombre FROM usuarios WHERE id = ? LIMIT 1',
        [duenoId],
      )
      if (duenoRows[0]) {
        dueno = {
          id: Number(duenoRows[0].id),
          email: String(duenoRows[0].email),
          nombre: duenoRows[0].nombre != null ? String(duenoRows[0].nombre) : null,
        }
      }
    }

    const [asignados] = await pool.query<RowDataPacket[]>(
      `SELECT u.id, u.email, u.nombre
       FROM reunion_usuarios ru
       INNER JOIN usuarios u ON u.id = ru.usuario_id
       WHERE ru.reunion_id = ?
       ORDER BY u.email`,
      [id],
    )

    res.json({
      dueno,
      asignados: asignados.map((u) => ({
        id: Number(u.id),
        email: String(u.email),
        nombre: u.nombre != null ? String(u.nombre) : null,
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// Listar invitaciones enviadas de una reunión
app.get('/api/reuniones/:id/invitaciones', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, reunion_id, email_invitado, mensaje, enviado_por_usuario_id,
              estado, error_mensaje, creado_en
       FROM reunion_invitaciones
       WHERE reunion_id = ?
       ORDER BY creado_en DESC
       LIMIT 200`,
      [id],
    )
    res.json(
      rows.map((r) => ({
        id: Number(r.id),
        reunion_id: Number(r.reunion_id),
        email_invitado: String(r.email_invitado),
        mensaje: r.mensaje != null ? String(r.mensaje) : null,
        enviado_por_usuario_id:
          r.enviado_por_usuario_id != null ? Number(r.enviado_por_usuario_id) : null,
        estado: String(r.estado),
        error_mensaje: r.error_mensaje != null ? String(r.error_mensaje) : null,
        creado_en: String(r.creado_en),
      })),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/reuniones/:id/convocatoria', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT join_url, titulo, fecha_inicio, fecha_fin FROM reunion_teams WHERE reunion_id = ? LIMIT 1',
      [id],
    )
    const r = rows[0]
    res.json({
      join_url: r?.join_url != null ? String(r.join_url) : null,
      fecha_inicio: r?.fecha_inicio != null ? String(r.fecha_inicio) : null,
      fecha_fin: r?.fecha_fin != null ? String(r.fecha_fin) : null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// Enviar invitaciones por correo
app.post('/api/reuniones/:id/invitaciones', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  if (!isSmtpConfigured()) {
    res.status(503).json({
      error: 'SMTP no configurado. Añade SMTP_HOST, SMTP_USER y SMTP_PASS en server/.env',
    })
    return
  }

  const emails = parseEmailsInvitacion(req.body?.emails)
  if (emails.length === 0) {
    res.status(400).json({ error: 'indica al menos un email válido en "emails"' })
    return
  }

  const mensaje =
    typeof req.body?.mensaje === 'string' ? req.body.mensaje.trim() || null : null

  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const u = authUser(req)
    const titulo = String(reunion.titulo ?? 'Reunión')

    const [senderRows] = await pool.query<RowDataPacket[]>(
      'SELECT nombre, email FROM usuarios WHERE id = ? LIMIT 1',
      [u.id],
    )
    const enviadoPorNombre =
      senderRows[0]?.nombre != null && String(senderRows[0].nombre).trim()
        ? String(senderRows[0].nombre).trim()
        : null

    const teamsJoinUrlRaw =
      typeof req.body?.teamsJoinUrl === 'string' ? req.body.teamsJoinUrl.trim() : ''
    const teamsJoinUrl =
      teamsJoinUrlRaw && /^https?:\/\//i.test(teamsJoinUrlRaw) ? teamsJoinUrlRaw : null

    const fechaInicio =
      typeof req.body?.fechaInicio === 'string' && req.body.fechaInicio.trim()
        ? req.body.fechaInicio.trim()
        : null
    const fechaFin =
      typeof req.body?.fechaFin === 'string' && req.body.fechaFin.trim()
        ? req.body.fechaFin.trim()
        : null

    if (teamsJoinUrl || fechaInicio || fechaFin) {
      await pool.query(
        `INSERT INTO reunion_teams (reunion_id, join_url, titulo, fecha_inicio, fecha_fin, creado_por_usuario_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           join_url = COALESCE(VALUES(join_url), join_url),
           titulo = VALUES(titulo),
           fecha_inicio = COALESCE(VALUES(fecha_inicio), fecha_inicio),
           fecha_fin = COALESCE(VALUES(fecha_fin), fecha_fin),
           creado_por_usuario_id = VALUES(creado_por_usuario_id)`,
        [id, teamsJoinUrl, titulo, toMysqlDatetime(fechaInicio), toMysqlDatetime(fechaFin), u.id],
      )
    }

    const resultados: Array<{
      email: string
      ok: boolean
      error?: string
    }> = []

    for (const emailInv of emails) {
      try {
        await enviarInvitacionReunion({
          para: emailInv,
          replyTo: u.email,
          reunionTitulo: titulo,
          reunionId: id,
          mensajeOpcional: mensaje,
          teamsJoinUrl,
          fechaInicio,
          fechaFin,
          enviadoPorNombre,
        })
        await pool.query(
          `INSERT INTO reunion_invitaciones
            (reunion_id, email_invitado, mensaje, enviado_por_usuario_id, estado)
           VALUES (?, ?, ?, ?, 'enviado')`,
          [id, emailInv, mensaje, u.id],
        )
        resultados.push({ email: emailInv, ok: true })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        await pool.query(
          `INSERT INTO reunion_invitaciones
            (reunion_id, email_invitado, mensaje, enviado_por_usuario_id, estado, error_mensaje)
           VALUES (?, ?, ?, ?, 'error', ?)`,
          [id, emailInv, mensaje, u.id, errMsg],
        )
        resultados.push({ email: emailInv, ok: false, error: errMsg })
      }
    }

    const okCount = resultados.filter((r) => r.ok).length
    if (okCount > 0) {
      logRegistro(req, {
        accion: 'invitacion_enviada',
        reunionId: id,
        entidadTipo: 'reunion',
        entidadId: id,
        detalle: { emails: resultados.filter((r) => r.ok).map((r) => r.email), titulo },
      })
    }

    res.json({
      enviados: okCount,
      fallidos: resultados.length - okCount,
      resultados,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// Lee el mapa { SPEAKER_00: 6, ... }
app.get('/api/reuniones/:id/hablantes-usuarios', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT hablante_key, usuario_id FROM reunion_hablante_usuario WHERE reunion_id = ?',
      [id],
    )
    const map: Record<string, number> = {}
    for (const r of rows) map[String(r.hablante_key)] = Number(r.usuario_id)
    res.json(map)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// Asigna/actualiza SPEAKER_00 -> usuarioId
app.put('/api/reuniones/:id/hablantes-usuarios/:hablanteKey', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  const hablanteKey = String(req.params.hablanteKey ?? '').trim()
  const usuarioId = Number(req.body?.usuarioId)

  if (id === null || !hablanteKey) {
    res.status(400).json({ error: 'parámetros inválidos' })
    return
  }
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    res.status(400).json({ error: 'usuarioId inválido' })
    return
  }

  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const json = parseTranscripcionJsonAlmacenado(String(reunion.transcripcion_json ?? ''))
    if (!json?.diarizada || json.segmentos.length === 0) {
      res.status(400).json({ error: 'esta reunión no tiene transcripción diarizada con segmentos' })
      return
    }
    const speakers = new Set(json.segmentos.map((s) => s.speaker.trim() || '?'))
    if (!speakers.has(hablanteKey)) {
      res.status(400).json({ error: 'hablanteKey no existe en esta reunión' })
      return
    }

    const ok = await usuarioTieneAccesoAReunion(id, usuarioId)
    if (!ok) {
      res.status(400).json({ error: 'ese usuario no tiene acceso a la reunión' })
      return
    }

    await pool.query(
      `INSERT INTO reunion_hablante_usuario (reunion_id, hablante_key, usuario_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id)`,
      [id, hablanteKey, usuarioId],
    )

    logRegistro(req, {
      accion: 'hablante_usuario_asignado',
      reunionId: id,
      entidadTipo: 'hablante',
      entidadId: usuarioId,
      detalle: { hablante_key: hablanteKey, usuario_id: usuarioId },
    })

    res.status(200).json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

// Quita la asignación
app.delete('/api/reuniones/:id/hablantes-usuarios/:hablanteKey', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  const hablanteKey = String(req.params.hablanteKey ?? '').trim()
  if (id === null || !hablanteKey) {
    res.status(400).json({ error: 'parámetros inválidos' })
    return
  }
  try {
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    await pool.query(
      'DELETE FROM reunion_hablante_usuario WHERE reunion_id = ? AND hablante_key = ?',
      [id, hablanteKey],
    )

    logRegistro(req, {
      accion: 'hablante_usuario_quitado',
      reunionId: id,
      entidadTipo: 'hablante',
      detalle: { hablante_key: hablanteKey },
    })

    res.status(204).send()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
    const reunion = await reunionVisibleOr404(req, res, id)
    if (!reunion) return

    const transcripcion = String(reunion.transcripcion ?? '').trim()
    if (!transcripcion) {
      res.status(400).json({ error: 'primero hay que transcribir el audio' })
      return
    }

    await pool.query(
      `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['resumiendo', id],
    )

    const resumenData = await generarResumenCompletoAsync(
      transcripcion,
      String(reunion.titulo ?? ''),
    )
    if (
      !resumenData.global &&
      resumenData.temas.length === 0 &&
      Object.keys(resumenData.porAudio).length === 0
    ) {
      throw new Error('no se pudo generar el resumen')
    }

    const resumenJson = JSON.stringify(resumenData)

    await pool.query(
      `UPDATE reuniones SET estado = ?, resumen = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['completado', resumenJson, id],
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(500).json({ error: 'no se pudo leer la reunión actualizada' })
      return
    }

    logRegistro(req, {
      accion: 'resumen_generado',
      reunionId: id,
      entidadTipo: 'reunion',
      entidadId: id,
      detalle: { titulo: String(reunion.titulo ?? '') },
    })
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
    if (
      !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
    ) {
      res.status(404).json({ error: 'archivo no encontrado' })
      return
    }
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
    const safeName = storageKey.replace(/[^\w.\-]+/g, '_')
    const forceDownload = req.query.download === '1'
    res.setHeader(
      'Content-Disposition',
      `${forceDownload ? 'attachment' : 'inline'}; filename="${safeName}"`,
    )
    res.type(mime)
    res.sendFile(path.resolve(filePath))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.post(
  '/api/reuniones/:reunionId/archivos/:archivoId/ocr',
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.reunionId)
    const archivoId = parseId(req.params.archivoId)
    if (reunionId === null || archivoId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    try {
      if (
        !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
      ) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key, tipo FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, reunionId],
      )
      const row = rows[0]
      if (!row) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      if (String(row.tipo) !== 'imagen') {
        res.status(400).json({ error: 'OCR solo está disponible para imágenes' })
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

      const textoOcr = await runOcr(path.resolve(filePath))
      if (!textoOcr) {
        res.status(400).json({ error: 'no se detectó texto en la imagen' })
        return
      }

      await pool.query(
        `UPDATE archivos_reunion SET texto_ocr = ?, incluir_imagen_acta = 1 WHERE id = ? AND reunion_id = ?`,
        [textoOcr, archivoId, reunionId],
      )

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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

app.post(
  '/api/reuniones/:reunionId/archivos/:archivoId/interpretar',
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.reunionId)
    const archivoId = parseId(req.params.archivoId)
    if (reunionId === null || archivoId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    if (!openAiConfigured()) {
      res.status(503).json({ error: 'OPENAI_API_KEY no configurada en server/.env' })
      return
    }

    try {
      if (
        !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
      ) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key, tipo FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, reunionId],
      )
      const row = rows[0]
      if (!row) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      if (String(row.tipo) !== 'imagen') {
        res.status(400).json({ error: 'la interpretación solo está disponible para imágenes' })
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

      console.log(`[vision] interpretando imagen reunión=${reunionId} archivo=${archivoId}`)
      const descripcion = await interpretarImagenOpenAi(path.resolve(filePath))

      await pool.query(
        `UPDATE archivos_reunion SET texto_ocr = ?, incluir_imagen_acta = 1 WHERE id = ? AND reunion_id = ?`,
        [descripcion, archivoId, reunionId],
      )

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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

app.patch('/api/reuniones/:id/acta-opciones', async (req: Request, res: Response) => {
  const reunionId = parseId(req.params.id)
  if (reunionId === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  function parseBool(raw: unknown): number | null {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') return 1
    if (raw === false || raw === 'false' || raw === 0 || raw === '0') return 0
    return null
  }

  const incTrans = parseBool(req.body?.incluirTranscripcionActa)
  const incResumen = parseBool(req.body?.incluirResumenActa)
  if (incTrans === null && incResumen === null) {
    res.status(400).json({
      error: 'indica incluirTranscripcionActa y/o incluirResumenActa (true/false)',
    })
    return
  }

  try {
    const reunionCheck = await reunionVisibleOr404(req, res, reunionId)
    if (!reunionCheck) return

    const sets: string[] = []
    const vals: number[] = []
    if (incTrans !== null) {
      sets.push('incluir_transcripcion_acta = ?')
      vals.push(incTrans)
    }
    if (incResumen !== null) {
      sets.push('incluir_resumen_acta = ?')
      vals.push(incResumen)
    }
    vals.push(reunionId)
    await pool.query(
      `UPDATE reuniones SET ${sets.join(', ')}, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      vals,
    )

    const [reunionRows] = await pool.query<RowDataPacket[]>(
      'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
      [reunionId],
    )
    const [archivos] = await pool.query<RowDataPacket[]>(
      `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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
    if (
      isUnknownColumnError(err, 'incluir_transcripcion_acta') ||
      isUnknownColumnError(err, 'incluir_resumen_acta')
    ) {
      res.status(500).json({
        error: 'Faltan columnas de opciones del acta. Reinicia el servidor API.',
      })
      return
    }
    res.status(500).json({ error: message })
  }
})

app.patch(
  '/api/reuniones/:reunionId/archivos/:archivoId/incluir-imagen-acta',
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.reunionId)
    const archivoId = parseId(req.params.archivoId)
    if (reunionId === null || archivoId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    const raw = req.body?.incluirImagenActa
    const incluir =
      raw === true || raw === 'true' || raw === 1 || raw === '1'
        ? 1
        : raw === false || raw === 'false' || raw === 0 || raw === '0'
          ? 0
          : null
    if (incluir === null) {
      res.status(400).json({ error: 'incluirImagenActa debe ser true o false' })
      return
    }

    try {
      if (
        !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
      ) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT id, tipo, texto_ocr FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, reunionId],
      )
      const row = rows[0]
      if (!row) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      if (String(row.tipo ?? '') !== 'imagen') {
        res.status(400).json({ error: 'solo aplica a imágenes' })
        return
      }
      await pool.query(
        `UPDATE archivos_reunion SET incluir_imagen_acta = ? WHERE id = ? AND reunion_id = ?`,
        [incluir, archivoId, reunionId],
      )

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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

app.post(
  '/api/reuniones/:reunionId/archivos/:archivoId/texto',
  async (req: Request, res: Response) => {
    const reunionId = parseId(req.params.reunionId)
    const archivoId = parseId(req.params.archivoId)
    if (reunionId === null || archivoId === null) {
      res.status(400).json({ error: 'id inválido' })
      return
    }

    try {
      if (
        !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
      ) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT storage_key, tipo, mime FROM archivos_reunion
         WHERE id = ? AND reunion_id = ?
         LIMIT 1`,
        [archivoId, reunionId],
      )
      const row = rows[0]
      if (!row) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
      if (String(row.tipo) !== 'documento') {
        res.status(400).json({ error: 'La extracción de texto solo está disponible para documentos (PDF, PPTX)' })
        return
      }

      const storageKey = String(row.storage_key ?? '')
      const mime = row.mime != null ? String(row.mime) : null
      if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
        res.status(404).json({ error: 'archivo inválido' })
        return
      }

      const filePath = path.join(uploadsDir, storageKey)
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'archivo no encontrado en disco' })
        return
      }

      const texto = await extractTextFromDocument(path.resolve(filePath), mime, storageKey)
      if (!texto) {
        res.status(400).json({ error: 'no se detectó texto en el documento' })
        return
      }

      await pool.query(
        `UPDATE archivos_reunion SET texto_ocr = ? WHERE id = ? AND reunion_id = ?`,
        [texto, archivoId, reunionId],
      )

      const [reunionRows] = await pool.query<RowDataPacket[]>(
        'SELECT * FROM reuniones WHERE id = ? LIMIT 1',
        [reunionId],
      )
      const [archivos] = await pool.query<RowDataPacket[]>(
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
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

      if (
        !(await archivoPerteneceAReunionVisible(pool, reunionId, archivoId, authUser(req)))
      ) {
        res.status(404).json({ error: 'archivo no encontrado' })
        return
      }
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

      const txtPath = whisperTxtPath(uploadsDir, storageKey)
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
        `${ARCHIVOS_LIST_SELECT} WHERE reunion_id = ? ORDER BY creado_en DESC`,
        [reunionId],
      )
      const reunion = reunionRows[0]
      if (!reunion) {
        res.status(404).json({ error: 'reunión no encontrada' })
        return
      }

      logRegistro(req, {
        accion: 'archivo_eliminado',
        reunionId,
        entidadTipo: 'archivo',
        entidadId: archivoId,
        detalle: { storage_key: storageKey },
      })
      res.json({
        ...reunion,
        estado_etiqueta: etiquetaEstado(String(reunion.estado)),
        archivos,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isUnknownColumnError(err, 'incluir_imagen_acta')) {
        res.status(500).json({
          error:
            'Falta la columna incluir_imagen_acta en la base de datos. Reinicia el servidor API.',
        })
        return
      }
      res.status(500).json({ error: message })
    }
  },
)

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err)
  res.status(500).json({ error: message })
})

void Promise.all([
  ensureUsuariosTable(pool),
  ensureReunionesUsuarioId(pool),
  ensureReunionUsuariosTable(pool),
  ensureRegistrosTable(pool),
  ensureReunionInvitacionesTable(pool),
  ensureReunionTeamsTable(pool),
  ensureUsuariosMicrosoftColumns(pool),
  ensureIncluirImagenActaColumn(),
  ensureActaOpcionesColumn(),
  ensureFirmaActaSimuladaColumns(),
  ensureTranscripcionDiarizacionColumn(),
])
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API http://127.0.0.1:${PORT} (también http://localhost:${PORT})`)
      console.log('[auth] login en POST /api/auth/login; reuniones requieren JWT')
      console.log(
        `[transcripcion] solo OpenAI (sin Whisper local); provider=${process.env.TRANSCRIPTION_PROVIDER ?? 'openai'}`,
      )
      console.log(`[upload] carpeta uploads: ${uploadsDir}`)
      console.log(`[upload] firmas simuladas: ${firmasDir}`)
      console.log('[http] logs activos: cada petición muestra --> al entrar y <-- al responder')
      console.log(`[cors] orígenes permitidos (dev): localhost/127.0.0.1 puertos 5173-5179 + ${process.env.CORS_ORIGIN ?? 'por defecto'}`)
    })
  })
  .catch((err) => {
    console.error('[db] no se pudieron preparar columnas del acta:', err)
    process.exit(1)
  })