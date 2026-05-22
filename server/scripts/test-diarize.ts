/**
 * Prueba de diarización OpenAI leyendo server/.env (sin variables en la terminal).
 * Uso: npm run test:diarize
 *      npm run test:diarize -- prueba-diarize-10min.mp3
 */
import path from 'node:path'
import fs from 'node:fs'
import '../src/loadEnv'
import { openAiConfigured, transcribirAudioOpenAiDiarize } from '../src/openai'

const serverRoot = path.join(__dirname, '..')
const archivo = process.argv[2]?.trim() || 'prueba-diarize.mp3'
const audioPath = path.join(serverRoot, archivo)

if (!openAiConfigured()) {
  console.error('Falta OPENAI_API_KEY en server/.env')
  process.exit(1)
}

if (!fs.existsSync(audioPath)) {
  console.error(`No existe: ${audioPath}`)
  process.exit(1)
}

console.log(`Diarizando: ${archivo}`)
console.log(
  `Reintentos=${process.env.OPENAI_DIARIZE_MAX_RETRIES ?? 3}, timeout=${process.env.OPENAI_DIARIZE_TIMEOUT_MS ?? 900000}ms`,
)

transcribirAudioOpenAiDiarize(audioPath)
  .then(({ texto, segmentos }) => {
    console.log(`\n--- Texto (${texto.length} chars) ---\n`)
    console.log(texto.slice(0, 2000) + (texto.length > 2000 ? '\n...' : ''))
    console.log(`\n--- Segmentos: ${segmentos.length} ---`)
    for (const s of segmentos.slice(0, 5)) {
      console.log(`  [${s.speaker}] ${s.start?.toFixed(1)}s: ${s.text?.slice(0, 80)}`)
    }
    if (segmentos.length > 5) console.log(`  ... y ${segmentos.length - 5} más`)
    process.exit(0)
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
