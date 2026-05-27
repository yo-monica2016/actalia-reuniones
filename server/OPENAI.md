# OpenAI (transcripción y resumen)

## Configuración (`server/.env`)

```env
OPENAI_API_KEY=sk-tu-clave
TRANSCRIPTION_PROVIDER=openai
SUMMARY_PROVIDER=openai
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_DIARIZE_MODEL=gpt-4o-transcribe-diarize
OPENAI_DIARIZE_MAX_MB=6
OPENAI_DIARIZE_MAX_RETRIES=2
OPENAI_DIARIZE_TIMEOUT_MS=300000
OPENAI_DIARIZE_RETRY_DELAY_MS=2000
OPENAI_CHAT_MODEL=gpt-4o-mini
```

**No uses** sintaxis tipo `VAR=valor` en PowerShell (eso es de bash/Linux). Toda la configuración va en `server/.env`.

- Transcripción: **solo OpenAI** (`TRANSCRIPTION_PROVIDER=openai` + `OPENAI_API_KEY`). No hay fallback a Whisper/Python local.
- Resumen: OpenAI por defecto; si falla, puede usarse resumen local (`SUMMARY_PROVIDER=local` o reglas en `.env`).
- OCR de imágenes: Tesseract en el servidor (opcional). Visión: OpenAI (`/interpretar`).

### Probar diarización

Desde `server/` (lee `.env` automáticamente):

```powershell
npm run test:diarize
npm run test:diarize -- prueba-diarize-10min.mp3
```

## Límites y archivos grandes

- OpenAI acepta hasta **25 MB** por petición.
- Si el audio pesa más: el servidor **comprime** a MP3 mono 64 kbps (ffmpeg).
- Si sigue siendo largo o pesado: **divide en trozos** de ~10–15 min cortando en **silencios** (`silencedetect`).
- Cada trozo se transcribe con **diarización** (Persona A/B) y se **une** en orden cronológico.
- Los temporales en `server/uploads/tmp/` se **borran** al terminar.

Requisito en el **servidor** (no en el PC del usuario): tras `npm install` en `server/` se incluye FFmpeg con `ffmpeg-static` y `ffprobe-static`. Opcional: `FFMPEG_PATH` / `FFPROBE_PATH` en `server/.env` para otro binario.

Variables opcionales: `AUDIO_CHUNK_MIN_SEC`, `AUDIO_CHUNK_MAX_SEC`, `AUDIO_SILENCE_NOISE_DB`.

## Reiniciar API

Tras cambiar `.env`: `Ctrl+C` y `npm run dev` en `server/`.
