# OpenAI (transcripción y resumen)

## Configuración (`server/.env`)

```env
OPENAI_API_KEY=sk-tu-clave
TRANSCRIPTION_PROVIDER=openai
SUMMARY_PROVIDER=openai
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_CHAT_MODEL=gpt-4o-mini
```

- Sin `OPENAI_API_KEY` o con `PROVIDER=local` → Whisper/Tesseract local (como antes).
- Si OpenAI falla → el servidor usa **fallback local** automáticamente.

## Límites

- Audio para OpenAI: máximo **25 MB** por archivo.
- Audios muy largos pueden tardar; la app muestra aviso mientras transcribe.

## Reiniciar API

Tras cambiar `.env`: `Ctrl+C` y `npm run dev` en `server/`.
