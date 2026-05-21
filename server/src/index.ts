import dotenv from 'dotenv'
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
import sharp from 'sharp'
import { etiquetaEstado } from './estados'
import {
  transcribirStorageKey as transcribirArchivoLocal,
  whisperTxtPath,
} from './transcripcion'
import {
  resumirTranscripcionOpenAi,
  transcribirAudioOpenAi,
  useOpenAiSummary,
  useOpenAiTranscription,
} from './openai'

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
dotenv.config({ path: path.join(serverRoot, '.env') })

const uploadsDir = path.join(serverRoot, 'uploads')
const projectTessdataDir = path.join(serverRoot, 'tessdata')

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
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

async function transcribirStorageKey(storageKey: string): Promise<string> {
  if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
    throw new Error('archivo de audio inválido')
  }
  const audioPath = path.join(uploadsDir, storageKey)
  if (!fs.existsSync(audioPath)) {
    throw new Error(`archivo de audio no encontrado: ${storageKey}`)
  }

  if (useOpenAiTranscription()) {
    try {
      console.log(`[transcripcion] OpenAI: ${storageKey}`)
      const texto = await transcribirAudioOpenAi(audioPath)
      const txtPath = whisperTxtPath(uploadsDir, storageKey)
      fs.writeFileSync(txtPath, texto, 'utf8')
      console.log(`[transcripcion] OpenAI terminó: ${storageKey}`)
      return texto
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[transcripcion] OpenAI falló (${storageKey}), usando Whisper local:`, msg)
    }
  }

  return transcribirArchivoLocal(uploadsDir, storageKey)
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
      return { global, porAudio }
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
    ;({ tessdataPrefix } = resolveOcrTessdata(lang))
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

interface ResumenAlmacenado {
  global: string
  porAudio: Record<string, string>
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

  return { global, porAudio }
}

function leerResumenAlmacenado(raw: string | null | undefined): ResumenAlmacenado {
  const t = String(raw ?? '').trim()
  if (!t) return { global: '', porAudio: {} }
  if (t.startsWith('{')) {
    try {
      const p = JSON.parse(t) as ResumenAlmacenado
      return {
        global: String(p.global ?? '').trim(),
        porAudio:
          p.porAudio && typeof p.porAudio === 'object' ? p.porAudio : {},
      }
    } catch {
      return { global: t, porAudio: {} }
    }
  }
  return {
    global: t.replace(/========== Audio:\s*.+?\s*==========\s*/g, '').trim(),
    porAudio: {},
  }
}

function formatearResumenParaDescarga(data: ResumenAlmacenado): string {
  const partes: string[] = []
  for (const nombre of Object.keys(data.porAudio)) {
    const texto = data.porAudio[nombre]?.trim()
    if (texto) {
      partes.push(`========== ${nombre} ==========\n\n${texto}`)
    }
  }
  if (data.global.trim() && Object.keys(data.porAudio).length > 1) {
    partes.push(`========== Resumen de la reunión ==========\n\n${data.global.trim()}`)
  } else if (data.global.trim() && partes.length === 0) {
    partes.push(data.global.trim())
  }
  return partes.join('\n\n')
}

function nombreVisibleArchivo(storageKey: string): string {
  const sinPrefijo = storageKey.replace(/^\d+-/, '')
  return sinPrefijo || storageKey
}

function etiquetaTipoArchivoActa(tipo: string): string {
  if (tipo === 'imagen') return 'Imagen'
  if (tipo === 'documento') return 'Documento'
  if (tipo === 'audio') return 'Audio'
  if (tipo === 'video') return 'Vídeo'
  return tipo
}

const ARCHIVOS_LIST_SELECT = `SELECT id, reunion_id, tipo, storage_key, mime, tamano_bytes, duracion_segundos, creado_en, texto_ocr, incluir_imagen_acta
       FROM archivos_reunion`

function incluirImagenActaActivo(archivo: RowDataPacket): boolean {
  const v = archivo.incluir_imagen_acta
  if (v === null || v === undefined) return true
  return v !== 0 && v !== false && v !== '0'
}
function incluirTranscripcionActaActivo(reunion: RowDataPacket): boolean {
  return Number(reunion.incluir_transcripcion_acta) === 1
}

function incluirResumenActaActivo(reunion: RowDataPacket): boolean {
  return Number(reunion.incluir_resumen_acta) === 1
}
/** Imagen en PDF solo si el usuario la marcó (incluir_imagen_acta). */
function debeIncrustarImagenEnActa(archivo: RowDataPacket): boolean {
  if (String(archivo.tipo ?? '') !== 'imagen') return false
  const storageKey = String(archivo.storage_key ?? '')
  if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) return false
  return incluirImagenActaActivo(archivo)
}

const ACTA_IMAGEN_FIT: [number, number] = [450, 280]
const ACTA_IMAGEN_ALTO_APROX = ACTA_IMAGEN_FIT[1] + 24

const PDFKIT_IMAGEN_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif'])

async function prepararImagenParaPdf(filePath: string): Promise<string | Buffer | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (PDFKIT_IMAGEN_EXT.has(ext)) return filePath
  try {
    return await sharp(filePath).png().toBuffer()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[acta.pdf] conversión sharp ${filePath}:`, msg)
    return null
  }
}

function asegurarEspacioImagenEnPagina(doc: InstanceType<typeof PDFDocument>): void {
  const margenInf = doc.page.margins.bottom ?? 50
  const limiteY = doc.page.height - margenInf
  if (doc.y + ACTA_IMAGEN_ALTO_APROX > limiteY) {
    doc.addPage()
  }
}

async function incrustarImagenEnActaPdf(
  doc: InstanceType<typeof PDFDocument>,
  archivo: RowDataPacket,
  uploadsDirPath: string,
): Promise<void> {
  if (!debeIncrustarImagenEnActa(archivo)) return
  const storageKey = String(archivo.storage_key ?? '')
  const filePath = path.join(uploadsDirPath, storageKey)
  if (!fs.existsSync(filePath)) return

  const imageSource = await prepararImagenParaPdf(filePath)
  if (!imageSource) {
    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(
        `(No se pudo preparar la imagen ${path.extname(filePath)} para el PDF.)`,
      )
    doc.moveDown(0.5)
    doc.fillColor('#000000')
    return
  }

  asegurarEspacioImagenEnPagina(doc)

  try {
    doc.image(imageSource, { fit: ACTA_IMAGEN_FIT })
    doc.moveDown(0.5)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[acta.pdf] no se pudo incrustar ${storageKey}:`, msg)
    doc.fontSize(9).fillColor('#666666').text('(No se pudo incrustar esta imagen en el PDF.)')
    doc.moveDown(0.5)
    doc.fillColor('#000000')
  }
}

async function escribirPdfActa(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
  archivos: RowDataPacket[],
  uploadsDirPath: string,
): Promise<void> {
  const titulo = String(reunion.titulo ?? 'Reunión')
  const fecha = reunion.creado_en
    ? new Date(String(reunion.creado_en)).toLocaleString('es-ES')
    : ''

  const transcripcion = String(reunion.transcripcion ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()

  doc.fontSize(18).fillColor('#000000').text('Acta de reunión', { align: 'center' })
  doc.moveDown(0.5)
  doc.fontSize(16).text(titulo, { underline: true })
  doc.moveDown(0.5)
  if (fecha) {
    doc.fontSize(10).fillColor('#444444').text(fecha)
  }
  doc.moveDown()

  if (incluirResumenActaActivo(reunion)) {
    const resumenRaw = String(reunion.resumen ?? '').trim()
    if (resumenRaw) {
      const textoResumen = formatearResumenParaDescarga(
        leerResumenAlmacenado(resumenRaw),
      )
      if (textoResumen) {
        doc.fontSize(12).text('Resumen', { underline: true })
        doc.moveDown(0.5)
        doc.fontSize(11).text(textoResumen, { align: 'left', lineGap: 4 })
        doc.moveDown()
      }
    }
  }

  if (incluirTranscripcionActaActivo(reunion) && transcripcion) {
    doc.fontSize(12).text('Transcripción', { underline: true })
    doc.moveDown(0.5)
    doc.fontSize(11).text(transcripcion, { align: 'left', lineGap: 4 })
    doc.moveDown()
  }
 

  const conTexto = archivos.filter((a) => String(a.texto_ocr ?? '').trim())
  if (conTexto.length > 0) {
    doc.fontSize(12).text('Textos extraídos de adjuntos', { underline: true })
    doc.moveDown(0.5)
    doc.fontSize(11)
    for (const archivo of conTexto) {
      const storageKey = String(archivo.storage_key ?? '')
      const nombre = nombreVisibleArchivo(storageKey)
      const tipo = String(archivo.tipo ?? '')
      const texto = String(archivo.texto_ocr ?? '').trim()
      doc.fillColor('#000000').text(`${nombre} (${etiquetaTipoArchivoActa(tipo)})`)
      doc.moveDown(0.25)
      await incrustarImagenEnActaPdf(doc, archivo, uploadsDirPath)
      doc.text(texto, { align: 'left', lineGap: 3 })
      doc.moveDown()
    }
  }

  const otros = archivos.filter((a) => {
    if (String(a.texto_ocr ?? '').trim()) return false
    if (String(a.tipo ?? '') === 'imagen' && !incluirImagenActaActivo(a)) return false
    return true
  })
  if (otros.length > 0) {
    doc.fontSize(12).text('Otros adjuntos (sin texto extraído)', { underline: true })
    doc.moveDown(0.5)
    doc.fontSize(10).fillColor('#444444')
    for (const archivo of otros) {
      const storageKey = String(archivo.storage_key ?? '')
      const nombre = nombreVisibleArchivo(storageKey)
      const tipoRaw = String(archivo.tipo ?? '')
      const tipo = etiquetaTipoArchivoActa(tipoRaw)
      doc.text(`• ${nombre} (${tipo})`)
      if (tipoRaw === 'imagen') {
        doc.moveDown(0.25)
        await incrustarImagenEnActaPdf(doc, archivo, uploadsDirPath)
      }
    }
    doc.fillColor('#000000')
  }
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

app.get('/api/reuniones/:id/resumen.txt', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT titulo, resumen FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    const cuerpo = formatearResumenParaDescarga(leerResumenAlmacenado(row.resumen))
    if (!cuerpo) {
      res.status(404).json({ error: 'no hay resumen' })
      return
    }

    const titulo = String(row.titulo ?? 'reunion')
    const filename = `resumen_${nombreArchivoDescarga(titulo, id, 'txt')}`

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(cuerpo)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message })
  }
})

app.get('/api/reuniones/:id/acta.pdf', async (req: Request, res: Response) => {
  const id = parseId(req.params.id)
  if (id === null) {
    res.status(400).json({ error: 'id inválido' })
    return
  }

  try {
    const [reunionRows] = await pool.query<RowDataPacket[]>(
      'SELECT titulo, resumen, transcripcion, creado_en, incluir_transcripcion_acta, incluir_resumen_acta FROM reuniones WHERE id = ? LIMIT 1',
      [id],
    )
    const reunion = reunionRows[0]
    if (!reunion) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

    const [archivos] = await pool.query<RowDataPacket[]>(
      `SELECT id, tipo, storage_key, texto_ocr, incluir_imagen_acta FROM archivos_reunion
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

    const doc = new PDFDocument({ margin: 50 })
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
  try {
    const [existing] = await pool.query<RowDataPacket[]>(
      'SELECT id, estado FROM reuniones WHERE id = ? LIMIT 1',
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
    const tipo = clasificarTipoArchivo(mime, req.file.originalname)

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
    res.status(500).json({ error: message })
  }
}

app.post('/api/reuniones/:id/audio', upload.single('file'), handleSubirArchivoReunion)
app.post('/api/reuniones/:id/archivo', upload.single('file'), handleSubirArchivoReunion)
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

    await pool.query(
      `UPDATE reuniones SET estado = ?, error_mensaje = NULL, actualizado_en = CURRENT_TIMESTAMP(6) WHERE id = ?`,
      ['transcribiendo', id],
    )

    let transcripcion = ''
    const partes: string[] = []
    for (const storageKey of storageKeys) {
      const texto = await transcribirStorageKey(storageKey)
      if (storageKeys.length > 1) {
        partes.push(`${encabezadoTranscripcionArchivo(storageKey)}\n\n${texto}`)
      } else {
        transcripcion = texto
      }
    }
    if (partes.length > 0) {
      transcripcion = partes.join('\n\n').trim()
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
      'SELECT id, titulo, transcripcion FROM reuniones WHERE id = ? LIMIT 1',
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

    const resumenData = await generarResumenCompletoAsync(
      transcripcion,
      String(reunion.titulo ?? ''),
    )
    if (!resumenData.global && Object.keys(resumenData.porAudio).length === 0) {
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
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM reuniones WHERE id = ? LIMIT 1',
      [reunionId],
    )
    if (!rows[0]) {
      res.status(404).json({ error: 'reunión no encontrada' })
      return
    }

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

void Promise.all([ensureIncluirImagenActaColumn(), ensureActaOpcionesColumn()])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API http://localhost:${PORT}`)
    })
  })
  .catch((err) => {
    console.error('[db] no se pudieron preparar columnas del acta:', err)
    process.exit(1)
  })