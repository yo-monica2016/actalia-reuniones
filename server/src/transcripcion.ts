import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

function envFlag(name: string, defaultOn: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return defaultOn
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Reduce bucles típicos de Whisper (misma frase corta repetida muchas veces). */
export function limpiarRepeticionesTranscripcion(texto: string): string {
  let out = texto.replace(/(.{8,120}?)(?:\s*\1){2,}/gi, '$1')
  const lineas = out.split(/\n/)
  const resultado: string[] = []
  let ultima = ''
  let rep = 0
  for (const linea of lineas) {
    const norm = linea.replace(/\s+/g, ' ').trim().toLowerCase()
    if (norm && norm === ultima) {
      rep++
      if (rep >= 2) continue
    } else {
      rep = 0
      ultima = norm
    }
    resultado.push(linea)
  }
  return resultado.join('\n').trim()
}

/** Argumentos CLI: nombre de archivo relativo a uploadsDir (igual que en consola). */
export function buildWhisperArgs(storageKey: string): string[] {
  const model = process.env.WHISPER_MODEL?.trim() || 'small'
  const language = process.env.WHISPER_LANGUAGE?.trim() || 'Spanish'

  const args: string[] = [
    '-m',
    'whisper',
    storageKey,
    '--language',
    language,
    '--model',
    model,
    '--task',
    'transcribe',
    '--output_dir',
    '.',
    '--output_format',
    'txt',
  ]

  const temperature = process.env.WHISPER_TEMPERATURE?.trim()
  args.push('--temperature', temperature !== undefined && temperature !== '' ? temperature : '0')

  const beamSize = process.env.WHISPER_BEAM_SIZE?.trim()
  if (beamSize) args.push('--beam_size', beamSize)

  const initialPrompt = process.env.WHISPER_INITIAL_PROMPT?.trim()
  if (initialPrompt) args.push('--initial_prompt', initialPrompt)

  if (!envFlag('WHISPER_CONDITION_ON_PREVIOUS_TEXT', false)) {
    args.push('--condition_on_previous_text', 'False')
  }

  const compression = process.env.WHISPER_COMPRESSION_RATIO_THRESHOLD?.trim()
  if (compression) args.push('--compression_ratio_threshold', compression)

  const logprob = process.env.WHISPER_LOGPROB_THRESHOLD?.trim()
  if (logprob) args.push('--logprob_threshold', logprob)

  return args
}

export function runWhisper(storageKey: string, uploadsDir: string): Promise<void> {
  const python = process.env.PYTHON_CMD?.trim() || 'py'
  const args = buildWhisperArgs(storageKey)

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: uploadsDir,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      const detail = stderr.trim() || `Whisper terminó con código ${code}`
      console.error(`[transcripcion] fallo ${storageKey}:`, detail.slice(0, 2000))
      reject(new Error(detail))
    })
  })
}

export function whisperTxtPath(uploadsDir: string, storageKey: string): string {
  const base = path.parse(storageKey).name
  return path.join(uploadsDir, `${base}.txt`)
}

export function resolveWhisperTxtPath(uploadsDir: string, storageKey: string): string {
  const expected = whisperTxtPath(uploadsDir, storageKey)
  if (fs.existsSync(expected)) return expected

  const base = path.parse(storageKey).name.toLowerCase()
  for (const file of fs.readdirSync(uploadsDir)) {
    if (!file.toLowerCase().endsWith('.txt')) continue
    if (path.parse(file).name.toLowerCase() === base) {
      return path.join(uploadsDir, file)
    }
  }
  return expected
}

export async function transcribirStorageKey(
  uploadsDir: string,
  storageKey: string,
): Promise<string> {
  if (!storageKey || storageKey.includes('..') || /[/\\]/.test(storageKey)) {
    throw new Error('archivo de audio inválido')
  }
  const audioPath = path.join(uploadsDir, storageKey)
  if (!fs.existsSync(audioPath)) {
    throw new Error(`archivo de audio no encontrado: ${storageKey}`)
  }

  console.log(`[transcripcion] iniciando Whisper: ${storageKey}`)
  await runWhisper(storageKey, uploadsDir)
  console.log(`[transcripcion] Whisper terminó: ${storageKey}`)

  const txtPath = resolveWhisperTxtPath(uploadsDir, storageKey)
  if (!fs.existsSync(txtPath)) {
    throw new Error('Whisper no generó el archivo de texto')
  }
  let texto = fs.readFileSync(txtPath, 'utf8').trim()
  if (!texto) {
    throw new Error('la transcripción está vacía')
  }

  if (envFlag('WHISPER_LIMPIAR_REPETICIONES', true)) {
    texto = limpiarRepeticionesTranscripcion(texto)
  }

  return texto
}
