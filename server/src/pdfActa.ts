import path from 'node:path'
import fs from 'node:fs'
import type { RowDataPacket } from 'mysql2'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import {
  nombreVisibleHablante,
  parseTranscripcionJsonAlmacenado,
} from './hablantes'
import { leerResumenAlmacenado } from './resumen'

const COLOR_ACENTO = '#1e3a5f'
const MARGEN = 72
const ACTA_IMAGEN_FIT: [number, number] = [450, 280]
const ACTA_IMAGEN_ALTO_APROX = ACTA_IMAGEN_FIT[1] + 24
const PDFKIT_IMAGEN_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif'])

const LOGO_FIT: [number, number] = [140, 55]

function rutaLogoActa(): string {
  const fromEnv = process.env.PDF_ACTA_LOGO_PATH?.trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const fallback = path.join(__dirname, '..', 'assets', 'logo.png')
  if (fs.existsSync(fallback)) return fallback
  return ''
}

async function incrustarLogoPortada(doc: InstanceType<typeof PDFDocument>): Promise<void> {
  const logoPath = rutaLogoActa()
  if (!logoPath) {
    console.warn('[acta.pdf] logo: no encontrado (PDF_ACTA_LOGO_PATH ni server/assets/logo.png)')
    return
  }
  let imageSource: string | Buffer
  try {
    imageSource = await sharp(logoPath).png().toBuffer()
  } catch (err) {
    console.warn('[acta.pdf] logo: usando archivo directo:', err instanceof Error ? err.message : err)
    imageSource = logoPath
  }
  const logoW = LOGO_FIT[0]
  const logoH = LOGO_FIT[1]
  const x = doc.page.margins.left ?? MARGEN
  const y = doc.y
  try {
    doc.image(imageSource, x, y, { fit: LOGO_FIT })
    doc.y = y + logoH + 20
    doc.x = doc.page.margins.left ?? MARGEN
  } catch (err) {
    console.warn(
      '[acta.pdf] logo: no se pudo dibujar:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

function nombreVisibleArchivo(storageKey: string): string {
  const sinPrefijo = storageKey.replace(/^\d+-/, '')
  return sinPrefijo || storageKey
}

function etiquetaTipoArchivo(tipo: string): string {
  if (tipo === 'imagen') return 'Imagen'
  if (tipo === 'documento') return 'Documento'
  if (tipo === 'audio') return 'Audio'
  if (tipo === 'video') return 'Vídeo'
  return tipo
}

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

function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

function formatDuracion(seg: number | null | undefined): string {
  if (seg == null || seg <= 0) return '—'
  const m = Math.floor(seg / 60)
  const s = Math.floor(seg % 60)
  if (m === 0) return `${s} s`
  return `${m} min ${s} s`
}

function fechaLarga(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(String(iso)).toLocaleString('es-ES', {
      dateStyle: 'long',
      timeStyle: 'short',
    })
  } catch {
    return String(iso)
  }
}

async function prepararImagenParaPdf(filePath: string): Promise<string | Buffer | null> {
  const ext = path.extname(filePath).toLowerCase()
  if (PDFKIT_IMAGEN_EXT.has(ext)) return filePath
  try {
    return await sharp(filePath).png().toBuffer()
  } catch {
    return null
  }
}

function asegurarEspacioImagen(doc: InstanceType<typeof PDFDocument>): void {
  const margenInf = doc.page.margins.bottom ?? MARGEN
  const limiteY = doc.page.height - margenInf
  if (doc.y + ACTA_IMAGEN_ALTO_APROX > limiteY) doc.addPage()
}

async function incrustarImagen(
  doc: InstanceType<typeof PDFDocument>,
  filePath: string,
): Promise<void> {
  const imageSource = await prepararImagenParaPdf(filePath)
  if (!imageSource) {
    doc.fontSize(9).fillColor('#666666').text('(No se pudo incluir la imagen en el PDF.)')
    doc.moveDown(0.5).fillColor('#000000')
    return
  }
  asegurarEspacioImagen(doc)
  try {
    doc.image(imageSource, { fit: ACTA_IMAGEN_FIT })
    doc.moveDown(0.5)
  } catch {
    doc.fontSize(9).fillColor('#666666').text('(No se pudo incrustar esta imagen.)')
    doc.moveDown(0.5).fillColor('#000000')
  }
}

function tituloSeccion(doc: InstanceType<typeof PDFDocument>, texto: string): void {
  doc.moveDown(0.75)
  const y = doc.y
  const x = doc.page.margins.left ?? MARGEN
  doc.rect(x, y, 4, 14).fill(COLOR_ACENTO)
  doc
    .fillColor('#000000')
    .fontSize(12)
    .text(texto, x + 12, y, { width: doc.page.width - (doc.page.margins.left ?? MARGEN) * 2 - 12 })
  doc.moveDown(1)
}

function parrafo(doc: InstanceType<typeof PDFDocument>, texto: string, size = 11): void {
  doc.fontSize(size).fillColor('#000000').text(texto, {
    align: 'justify',
    lineGap: 4,
  })
  doc.moveDown(0.5)
}

function aplicarPiesDePagina(doc: InstanceType<typeof PDFDocument>): void {
  const range = doc.bufferedPageRange()
  const total = range.count
  const margenIzq = doc.page.margins.left ?? MARGEN
  const ancho = doc.page.width - margenIzq - (doc.page.margins.right ?? MARGEN)

  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i)

    const margenInf = doc.page.margins.bottom ?? MARGEN
    const pieY = doc.page.height - margenInf / 2 - 4

    const margenInfGuardado = doc.page.margins.bottom
    doc.page.margins.bottom = 0

    doc
      .fontSize(8)
      .fillColor('#666666')
      .text(`Página ${i - range.start + 1} de ${total}`, margenIzq, pieY, {
        width: ancho,
        align: 'right',
        lineBreak: false,
        height: 10,
      })

    doc.page.margins.bottom = margenInfGuardado
  }

  doc.switchToPage(range.start + total - 1)
  doc.fillColor('#000000')
}

async function escribirPortada(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
): Promise<void> {
  const titulo = String(reunion.titulo ?? 'Reunión')
  const fecha = fechaLarga(reunion.creado_en)
  const id = reunion.id != null ? String(reunion.id) : ''
  const generado = fechaLarga(new Date().toISOString())

  await incrustarLogoPortada(doc)

  doc.moveDown(1)
  doc.fontSize(18).fillColor(COLOR_ACENTO).text('ACTA DE REUNIÓN', { align: 'center' })
  doc.moveDown(1)
  doc.fontSize(16).fillColor('#000000').text(titulo, { align: 'center', underline: true })
  doc.moveDown(1)
  doc
    .fontSize(10)
    .fillColor('#444444')
    .text(
      'Documento generado a partir de grabación de audio, transcripción automática y resumen elaborado por el sistema.',
      { align: 'center', width: doc.page.width - MARGEN * 2 },
    )
  doc.moveDown(0.75)
  if (fecha) {
    doc.fontSize(10).text(`Fecha de la reunión: ${fecha}`, { align: 'center' })
  }
  if (id) {
    doc.text(`Referencia interna: reunión n.º ${id}`, { align: 'center' })
  }
  doc.moveDown(2)
  doc
    .fontSize(9)
    .fillColor('#666666')
    .text(`Generado con Actalia Reuniones — ${generado}`, { align: 'center' })
  doc.fillColor('#000000')
  doc.addPage()
}

function escribirIntroduccion(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
  archivos: RowDataPacket[],
): void {
  const titulo = String(reunion.titulo ?? 'Reunión')
  const fecha = fechaLarga(reunion.creado_en)
  const audios = archivos.filter((a) => {
    const t = String(a.tipo ?? '')
    return t === 'audio' || t === 'video'
  })
  const adjuntos = archivos.filter((a) => {
    const t = String(a.tipo ?? '')
    return t === 'imagen' || t === 'documento'
  })

  tituloSeccion(doc, 'Introducción')
  parrafo(
    doc,
    `En ${fecha || 'la fecha indicada en el sistema'}, con motivo de la reunión titulada «${titulo}», se recopila la presente acta a partir del audio registrado, su transcripción y el resumen generado.`,
  )

  if (audios.length > 0) {
    doc.fontSize(11).fillColor('#000000').text('Archivos de audio o vídeo asociados:', {
      underline: true,
    })
    doc.moveDown(0.35)
    for (const a of audios) {
      const nombre = nombreVisibleArchivo(String(a.storage_key ?? ''))
      const dur = formatDuracion(
        a.duracion_segundos != null ? Number(a.duracion_segundos) : null,
      )
      doc.fontSize(10).text(`• ${nombre} (${dur})`, { indent: 12 })
    }
    doc.moveDown(0.5)
  }

  if (adjuntos.length > 0) {
    doc.fontSize(11).text('Otros materiales aportados:', { underline: true })
    doc.moveDown(0.35)
    for (const a of adjuntos) {
      const nombre = nombreVisibleArchivo(String(a.storage_key ?? ''))
      doc
        .fontSize(10)
        .text(`• ${nombre} (${etiquetaTipoArchivo(String(a.tipo ?? ''))})`, { indent: 12 })
    }
    doc.moveDown(0.5)
  }

  tituloSeccion(doc, 'Contenido del acta')
  const items = [
    '1. Resumen de la reunión',
    incluirTranscripcionActaActivo(reunion)
      ? '2. Transcripción del audio'
      : null,
    '3. Materiales adjuntos (imágenes y documentos)',
    '4. Cierre y firmas',
  ].filter(Boolean) as string[]
  for (const item of items) {
    doc.fontSize(10).text(item, { indent: 12 })
  }
  doc.moveDown(0.75)
}

function escribirResumen(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
): void {
  if (!incluirResumenActaActivo(reunion)) return
  const raw = String(reunion.resumen ?? '').trim()
  if (!raw) return

  const data = leerResumenAlmacenado(raw)
  if (!data.global && data.temas.length === 0 && Object.keys(data.porAudio).length === 0) {
    return
  }

  tituloSeccion(doc, '1. Resumen de la reunión')

  if (data.temas.length > 0) {
    doc.fontSize(11).fillColor('#000000').text('Temas tratados', { underline: true })
    doc.moveDown(0.5)
    for (const tema of data.temas) {
      doc.fontSize(11).text(tema.titulo, { continued: false })
      doc.moveDown(0.25)
      parrafo(doc, tema.resumen, 10)
    }
  }

  if (data.global.trim()) {
    const etiqueta =
      data.temas.length > 0 || Object.keys(data.porAudio).length > 0
        ? 'Síntesis general'
        : 'Resumen'
    doc.fontSize(11).text(etiqueta, { underline: true })
    doc.moveDown(0.35)
    parrafo(doc, data.global.trim(), 10)
  }

  const audios = Object.entries(data.porAudio)
  if (audios.length > 0) {
    doc.fontSize(11).text('Resumen por archivo de audio', { underline: true })
    doc.moveDown(0.5)
    for (const [nombre, texto] of audios) {
      doc.fontSize(10).text(nombre, { underline: true })
      doc.moveDown(0.25)
      parrafo(doc, texto.trim(), 10)
    }
  }
}

function escribirTranscripcion(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
): void {
  if (!incluirTranscripcionActaActivo(reunion)) return

  const json = parseTranscripcionJsonAlmacenado(
    reunion.transcripcion_json != null ? String(reunion.transcripcion_json) : '',
  )
  const textoPlano = String(reunion.transcripcion ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()

  if (json?.diarizada && json.segmentos.length > 0) {
    tituloSeccion(doc, '2. Transcripción del audio')
    doc.fontSize(10).fillColor('#444444').text(
      'Transcripción con separación automática de voces. Los nombres mostrados son los asignados en la aplicación.',
    )
    doc.moveDown(0.5).fillColor('#000000').fontSize(10)
    for (const seg of json.segmentos) {
      const t = seg.text?.trim()
      if (!t) continue
      const nombre = nombreVisibleHablante(seg.speaker, json.hablantes)
      const marca = formatMmSs(seg.start)
      doc.text(`[${marca}] ${nombre}: ${t}`, { lineGap: 3 })
    }
    doc.moveDown(0.5)
    return
  }

  if (!textoPlano) return

  tituloSeccion(doc, '2. Transcripción del audio')
  parrafo(doc, textoPlano, 10)
}

async function escribirMateriales(
  doc: InstanceType<typeof PDFDocument>,
  archivos: RowDataPacket[],
  uploadsDirPath: string,
): Promise<void> {
  const materiales = archivos.filter((a) => {
    const t = String(a.tipo ?? '')
    return t === 'imagen' || t === 'documento'
  })
  if (materiales.length === 0) return

  tituloSeccion(doc, '3. Materiales adjuntos')

  for (const archivo of materiales) {
    const storageKey = String(archivo.storage_key ?? '')
    const texto = String(archivo.texto_ocr ?? '').trim()
    const esImagen = String(archivo.tipo ?? '') === 'imagen'

    if (esImagen && incluirImagenActaActivo(archivo)) {
      const filePath = path.join(uploadsDirPath, storageKey)
      if (storageKey && !storageKey.includes('..') && fs.existsSync(filePath)) {
        await incrustarImagen(doc, filePath)
      }
    }

    if (texto) {
      parrafo(doc, texto, 10)
    } else if (esImagen) {
      doc
        .fontSize(9)
        .fillColor('#666666')
        .text('(Sin descripción; usa «Interpretar imagen» en la aplicación.)')
      doc.moveDown(0.5).fillColor('#000000')
    }

    doc.moveDown(0.35)
  }
}

function escribirCierreYFirmas(doc: InstanceType<typeof PDFDocument>): void {
  tituloSeccion(doc, '4. Cierre del acta')
  parrafo(
    doc,
    'Con lo actuado, se da por reproducida en el presente documento la información derivada del audio transcrito y de los materiales adjuntos que figuran en las secciones anteriores. El presente acta se expide como documento electrónico.',
  )

  doc.fontSize(11).text('Acuerdos', { underline: true })
  doc.moveDown(0.35)
  parrafo(
    doc,
    'No constan acuerdos formalizados de forma estructurada en esta versión automática del acta. Los puntos relevantes quedan recogidos en el resumen de la reunión.',
    10,
  )

  doc.moveDown(1)
  doc.fontSize(11).text('Firmas', { underline: true })
  doc.moveDown(1.5)

  const x0 = doc.page.margins.left ?? MARGEN
  const ancho = doc.page.width - (doc.page.margins.left ?? MARGEN) * 2
  const y = doc.y
  doc.moveTo(x0, y + 28).lineTo(x0 + ancho, y + 28).stroke('#000000')
  doc.fontSize(9).text('Firma / Conforme', x0, y + 32, { width: ancho * 0.55 })
  doc.text('Fecha', x0 + ancho * 0.58, y + 32, { width: ancho * 0.42 })
  doc.moveDown(3)
}

export async function escribirPdfActa(
  doc: InstanceType<typeof PDFDocument>,
  reunion: RowDataPacket,
  archivos: RowDataPacket[],
  uploadsDirPath: string,
): Promise<void> {
  await escribirPortada(doc, reunion)
  escribirIntroduccion(doc, reunion, archivos)
  escribirResumen(doc, reunion)
  escribirTranscripcion(doc, reunion)
  await escribirMateriales(doc, archivos, uploadsDirPath)
  escribirCierreYFirmas(doc)

  aplicarPiesDePagina(doc)
}