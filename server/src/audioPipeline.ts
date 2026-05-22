import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import ffmpeg from 'fluent-ffmpeg'
import {
  OPENAI_MAX_AUDIO_BYTES,
  OPENAI_DIARIZE_MAX_BYTES,
  debeIntentarDiarize,
  segmentosATextoPlano,
  transcribirAudioOpenAi,
  transcribirAudioOpenAiDiarize,
  type SegmentoDiarizado,
} from './openai'

const CHUNK_MIN_SEC = Math.max(
  300,
  Number(process.env.AUDIO_CHUNK_MIN_SEC ?? 600),
)
const CHUNK_MAX_SEC = Math.max(
  CHUNK_MIN_SEC,
  Number(process.env.AUDIO_CHUNK_MAX_SEC ?? 900),
)
const CHUNK_TARGET_SEC = Math.max(
  CHUNK_MIN_SEC,
  Math.min(CHUNK_MAX_SEC, Number(process.env.AUDIO_CHUNK_TARGET_SEC ?? 720)),
)
const SILENCE_NOISE_DB = Number(process.env.AUDIO_SILENCE_NOISE_DB ?? -35)
const SILENCE_MIN_DUR = Number(process.env.AUDIO_SILENCE_MIN_SEC ?? 0.5)
const COMPRESS_BITRATE = process.env.AUDIO_COMPRESS_BITRATE?.trim() || '64k'

export interface PreparacionAudio {
  /** Rutas a borrar al finalizar (temporales). */
  temporales: string[]
}

export interface ResultadoTranscripcionPipeline {
  texto: string
  segmentos: SegmentoDiarizado[]
  diarizada: boolean
  aviso?: string
}

function ffmpegPathConfig(): void {
  const bin = process.env.FFMPEG_PATH?.trim()
  if (bin) ffmpeg.setFfmpegPath(bin)
  const ffprobe = process.env.FFPROBE_PATH?.trim()
  if (ffprobe) ffmpeg.setFfprobePath(ffprobe)
}

function ffprobeAsync(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

export async function obtenerDuracionSegundos(filePath: string): Promise<number> {
  ffmpegPathConfig()
  const data = await ffprobeAsync(filePath)
  const sec = Number(data.format.duration ?? 0)
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error(`No se pudo leer la duración de ${path.basename(filePath)}`)
  }
  return sec
}

function ejecutarFfmpeg(command: ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    command.on('end', () => resolve()).on('error', (err) => reject(err)).run()
  })
}

/** MP3 mono 64 kbps para reducir tamaño. */
export async function comprimirAMp3(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  ffmpegPathConfig()
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const cmd = ffmpeg(inputPath)
    .noVideo()
    .audioChannels(1)
    .audioBitrate(COMPRESS_BITRATE)
    .format('mp3')
    .output(outputPath)
  await ejecutarFfmpeg(cmd)
  console.log(
    `[audio] comprimido → ${path.basename(outputPath)} (${(fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2)} MB)`,
  )
}

interface IntervaloSilencio {
  inicio: number
  fin: number
  medio: number
}

/** Puntos de corte en silencios (stderr de silencedetect). */
export async function detectarSilencios(filePath: string): Promise<IntervaloSilencio[]> {
  ffmpegPathConfig()
  const noise = `${SILENCE_NOISE_DB}dB`
  const dur = SILENCE_MIN_DUR

  return new Promise((resolve, reject) => {
    const silencios: IntervaloSilencio[] = []
    let silencioInicio: number | null = null

    ffmpeg(filePath)
      .noVideo()
      .audioFilters(`silencedetect=noise=${noise}:d=${dur}`)
      .format('null')
      .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
      .on('stderr', (line: string) => {
        const startM = line.match(/silence_start:\s*([\d.]+)/)
        if (startM) silencioInicio = Number(startM[1])

        const endM = line.match(/silence_end:\s*([\d.]+)/)
        if (endM && silencioInicio != null) {
          const fin = Number(endM[1])
          silencios.push({
            inicio: silencioInicio,
            fin,
            medio: (silencioInicio + fin) / 2,
          })
          silencioInicio = null
        }
      })
      .on('end', () => resolve(silencios))
      .on('error', (err) => reject(err))
      .run()
  })
}

/** Cortes [t0, t1, …, duración] buscando silencio cerca del objetivo 10–15 min. */
export function planificarCortesPorSilencio(
  duracionTotal: number,
  silencios: IntervaloSilencio[],
): number[] {
  const cortes: number[] = [0]
  let inicioTramo = 0

  while (inicioTramo < duracionTotal - 30) {
    const objetivo = inicioTramo + CHUNK_TARGET_SEC
    if (objetivo >= duracionTotal - 60) break

    const ventanaMin = inicioTramo + CHUNK_MIN_SEC
    const ventanaMax = Math.min(inicioTramo + CHUNK_MAX_SEC, duracionTotal - 30)

    const candidatos = silencios.filter(
      (s) => s.medio >= ventanaMin && s.medio <= ventanaMax,
    )

    let puntoCorte: number
    if (candidatos.length > 0) {
      const mejor = candidatos.reduce((a, b) =>
        Math.abs(a.medio - objetivo) < Math.abs(b.medio - objetivo) ? a : b,
      )
      puntoCorte = mejor.medio
      console.log(
        `[audio] corte en silencio ${puntoCorte.toFixed(1)}s (ventana ${ventanaMin.toFixed(0)}–${ventanaMax.toFixed(0)}s)`,
      )
    } else {
      puntoCorte = Math.min(objetivo, ventanaMax)
      console.warn(
        `[audio] sin silencio en ventana; corte fijo en ${puntoCorte.toFixed(1)}s`,
      )
    }

    if (puntoCorte <= inicioTramo + 30) break
    cortes.push(puntoCorte)
    inicioTramo = puntoCorte
  }

  if (cortes[cortes.length - 1]! < duracionTotal - 1) {
    cortes.push(duracionTotal)
  }
  return cortes
}

export async function exportarTramoMp3(
  inputPath: string,
  outputPath: string,
  inicioSec: number,
  finSec: number,
): Promise<void> {
  ffmpegPathConfig()
  const duracion = Math.max(0.1, finSec - inicioSec)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const cmd = ffmpeg(inputPath)
    .setStartTime(inicioSec)
    .duration(duracion)
    .noVideo()
    .audioChannels(1)
    .audioBitrate(COMPRESS_BITRATE)
    .format('mp3')
    .output(outputPath)
  await ejecutarFfmpeg(cmd)
}

export interface TrozoAudio {
  path: string
  indice: number
  offsetSec: number
  duracionSec: number
}

export async function generarTrozosEnSilencios(
  workingPath: string,
  tempDir: string,
  duracionTotal: number,
): Promise<TrozoAudio[]> {
  const silencios = await detectarSilencios(workingPath)
  console.log(`[audio] ${silencios.length} intervalo(s) de silencio detectados`)
  const cortes = planificarCortesPorSilencio(duracionTotal, silencios)
  const trozos: TrozoAudio[] = []

  for (let i = 0; i < cortes.length - 1; i++) {
    const inicio = cortes[i]!
    const fin = cortes[i + 1]!
    const outPath = path.join(tempDir, `chunk-${String(i + 1).padStart(3, '0')}.mp3`)
    await exportarTramoMp3(workingPath, outPath, inicio, fin)
    trozos.push({
      path: outPath,
      indice: i + 1,
      offsetSec: inicio,
      duracionSec: fin - inicio,
    })
    console.log(
      `[audio] trozo ${i + 1}/${cortes.length - 1}: ${inicio.toFixed(0)}s–${fin.toFixed(0)}s → ${path.basename(outPath)}`,
    )
  }
  return trozos
}

export function desplazarSegmentos(
  segmentos: SegmentoDiarizado[],
  offsetSec: number,
): SegmentoDiarizado[] {
  return segmentos.map((s) => ({
    ...s,
    start: s.start + offsetSec,
    end: s.end + offsetSec,
  }))
}

export function unirResultadosTrozos(
  partes: Array<{
    indice: number
    offsetSec: number
    texto: string
    segmentos: SegmentoDiarizado[]
    diarizada: boolean
  }>,
): { texto: string; segmentos: SegmentoDiarizado[]; diarizada: boolean } {
  const ordenadas = [...partes].sort((a, b) => a.offsetSec - b.offsetSec)
  const segmentos: SegmentoDiarizado[] = []
  const bloquesTexto: string[] = []

  for (const parte of ordenadas) {
    const seg = desplazarSegmentos(parte.segmentos, parte.offsetSec)
    segmentos.push(...seg)
    if (parte.texto.trim()) {
      if (ordenadas.length > 1) {
        bloquesTexto.push(
          `--- Fragmento ${parte.indice} (${Math.round(parte.offsetSec)}s) ---\n${parte.texto.trim()}`,
        )
      } else {
        bloquesTexto.push(parte.texto.trim())
      }
    }
  }

  const texto =
    bloquesTexto.length > 0
      ? bloquesTexto.join('\n\n')
      : segmentosATextoPlano(segmentos)

  const diarizada = ordenadas.some((p) => p.diarizada && p.segmentos.length > 0)
  return { texto, segmentos, diarizada }
}

export function crearDirectorioTemporal(baseDir: string): string {
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const dir = path.join(baseDir, 'tmp', `transcribe-${id}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function limpiarTemporales(rutas: string[]): void {
  for (const ruta of rutas) {
    try {
      if (!fs.existsSync(ruta)) continue
      const st = fs.statSync(ruta)
      if (st.isDirectory()) {
        fs.rmSync(ruta, { recursive: true, force: true })
      } else {
        fs.unlinkSync(ruta)
      }
      console.log(`[audio] temporal eliminado: ${ruta}`)
    } catch (err) {
      console.warn(`[audio] no se pudo borrar ${ruta}:`, err)
    }
  }
}

function necesitaDivision(duracionSec: number, tamanoBytes: number): boolean {
  if (tamanoBytes > OPENAI_MAX_AUDIO_BYTES) return true
  if (duracionSec > CHUNK_MAX_SEC) return true
  if (tamanoBytes > OPENAI_DIARIZE_MAX_BYTES && duracionSec > CHUNK_MIN_SEC) return true
  return false
}

async function transcribirUnArchivo(
  filePath: string,
  etiqueta: string,
): Promise<{ texto: string; segmentos: SegmentoDiarizado[]; diarizada: boolean }> {
  const tamano = fs.statSync(filePath).size
  if (debeIntentarDiarize(tamano)) {
    const { texto, segmentos } = await transcribirAudioOpenAiDiarize(filePath)
    return { texto, segmentos, diarizada: segmentos.length > 0 }
  }
  const texto = await transcribirAudioOpenAi(filePath)
  return { texto, segmentos: [], diarizada: false }
}

/**
 * Comprime si > 25 MB, divide por silencios si hace falta, transcribe con diarize y une.
 */
export async function transcribirAudioConPipeline(
  audioPath: string,
  uploadsDir: string,
): Promise<ResultadoTranscripcionPipeline & PreparacionAudio> {
  ffmpegPathConfig()
  const temporales: string[] = []
  const avisos: string[] = []

  let workingPath = audioPath
  let stat = fs.statSync(workingPath)
  const tempDir = crearDirectorioTemporal(uploadsDir)
  temporales.push(tempDir)

  try {
    if (stat.size > OPENAI_MAX_AUDIO_BYTES) {
      const comprimido = path.join(tempDir, 'comprimido.mp3')
      console.log(
        `[audio] ${(stat.size / (1024 * 1024)).toFixed(1)} MB > 25 MB → comprimiendo MP3 mono ${COMPRESS_BITRATE}`,
      )
      await comprimirAMp3(workingPath, comprimido)
      temporales.push(comprimido)
      workingPath = comprimido
      stat = fs.statSync(workingPath)
      if (stat.size > OPENAI_MAX_AUDIO_BYTES) {
        avisos.push(
          `Tras comprimir sigue pesando ${(stat.size / (1024 * 1024)).toFixed(1)} MB; se dividirá en fragmentos.`,
        )
      } else {
        avisos.push('Audio comprimido por debajo de 25 MB.')
      }
    }

    const duracion = await obtenerDuracionSegundos(workingPath)
    console.log(
      `[audio] duración ${(duracion / 60).toFixed(1)} min, tamaño ${(stat.size / (1024 * 1024)).toFixed(2)} MB`,
    )

    if (!necesitaDivision(duracion, stat.size)) {
      console.log(`[audio] un solo archivo, sin trocear`)
      const r = await transcribirUnArchivo(workingPath, path.basename(audioPath))
      return {
        ...r,
        temporales,
        aviso: avisos.length > 0 ? avisos.join(' ') : undefined,
      }
    }

    const trozos = await generarTrozosEnSilencios(workingPath, tempDir, duracion)
    for (const t of trozos) temporales.push(t.path)

    avisos.push(
      `Transcripción en ${trozos.length} fragmento(s) (${CHUNK_MIN_SEC / 60}–${CHUNK_MAX_SEC / 60} min), cortes en silencios.`,
    )

    const partes: Array<{
      indice: number
      offsetSec: number
      texto: string
      segmentos: SegmentoDiarizado[]
      diarizada: boolean
    }> = []

    for (const trozo of trozos) {
      const tamanoTrozo = fs.statSync(trozo.path).size
      if (tamanoTrozo > OPENAI_MAX_AUDIO_BYTES) {
        throw new Error(
          `Fragmento ${trozo.indice} supera 25 MB (${(tamanoTrozo / (1024 * 1024)).toFixed(1)} MB). Reduce CHUNK_MAX_SEC.`,
        )
      }
      console.log(
        `[audio] transcribiendo trozo ${trozo.indice}/${trozos.length} (offset ${trozo.offsetSec.toFixed(0)}s)`,
      )
      const r = await transcribirUnArchivo(trozo.path, `trozo-${trozo.indice}`)
      partes.push({
        indice: trozo.indice,
        offsetSec: trozo.offsetSec,
        texto: r.texto,
        segmentos: r.segmentos,
        diarizada: r.diarizada,
      })
    }

    const unido = unirResultadosTrozos(partes)
    return {
      ...unido,
      temporales,
      aviso: avisos.join(' '),
    }
  } catch (err) {
    limpiarTemporales(temporales)
    throw err
  }
}
