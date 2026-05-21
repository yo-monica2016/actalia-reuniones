# Transcripción (Whisper local)

## Requisitos

- **FFmpeg** en el PATH (`ffmpeg -version` debe funcionar en PowerShell).
- **Python** con Whisper: `py -m pip install -U openai-whisper`
- Copia `server/.env.example` a `server/.env` y ajusta variables.

## Modelos (`WHISPER_MODEL`)

| Modelo | Calidad | Velocidad (CPU) |
|--------|---------|-----------------|
| tiny   | Baja    | Muy rápida      |
| base   | Media   | Rápida          |
| **small** (recomendado) | Buena | Moderada |
| medium | Muy buena | Lenta       |
| large  | Máxima  | Muy lenta       |

## Variables útiles

- `WHISPER_INITIAL_PROMPT`: una frase con el contexto (ej. tema de la reunión) mejora nombres y términos.
- `WHISPER_CONDITION_ON_PREVIOUS_TEXT=false`: reduce repeticiones en silencios.
- `WHISPER_LIMPIAR_REPETICIONES=true`: post-proceso ligero en el servidor.

Tras cambiar `.env`, reinicia `npm run dev` en `server/` y **vuelve a transcribir** la reunión.

## Si la consola transcribe pero la app no

El servidor lanza Whisper con el **nombre del archivo** (`storage_key`) dentro de `server/uploads`, igual que:

```powershell
cd server\uploads
py -m whisper "nombre-archivo.webm" --language Spanish --model tiny --output_dir . --output_format txt
```

En la terminal del API verás líneas `[transcripcion] iniciando Whisper` / `terminó`.
