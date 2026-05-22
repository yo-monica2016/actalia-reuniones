import { useEffect, useState } from 'react'
import { guardarNombresHablantes } from '../api'
import type { MapaHablantes, Reunion } from '../types'
import { etiquetaPersona } from '../transcripcionView'

interface Props {
  reunionId: number
  speakers: string[]
  hablantesIniciales?: MapaHablantes
  onGuardado: (reunion: Reunion) => void
  disabled?: boolean
}

export function RenombrarHablantes({
  reunionId,
  speakers,
  hablantesIniciales,
  onGuardado,
  disabled = false,
}: Props) {
  const [nombres, setNombres] = useState<Record<string, string>>({})
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const speakersKey = speakers.join('|')
  const hablantesKey = JSON.stringify(hablantesIniciales ?? {})

  useEffect(() => {
    const init: Record<string, string> = {}
    for (const sp of speakers) {
      init[sp] = hablantesIniciales?.[sp] ?? ''
    }
    setNombres(init)
    setError(null)
    setOk(false)
  }, [reunionId, speakersKey, hablantesKey])

  async function handleGuardar() {
    setGuardando(true)
    setError(null)
    setOk(false)
    const hablantes: MapaHablantes = {}
    for (const sp of speakers) {
      const t = (nombres[sp] ?? '').trim()
      if (t) hablantes[sp] = t
    }
    try {
      const reunion = await guardarNombresHablantes(reunionId, hablantes)
      onGuardado(reunion)
      setOk(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron guardar los nombres')
    } finally {
      setGuardando(false)
    }
  }

  if (!speakers.length) return null

  return (
    <div className="renombrar-hablantes">
      <p className="transcripcion-revisar-hablantes" role="note">
        Asigna un nombre a cada voz detectada (Persona A, B…). La separación es
        automática: revísala antes del acta o el resumen.
      </p>
      <ul className="renombrar-hablantes-lista">
        {speakers.map((sp) => (
          <li key={sp} className="renombrar-hablante-fila">
            <label htmlFor={`hablante-${reunionId}-${sp}`}>
              <span className="renombrar-hablante-etiqueta">{etiquetaPersona(sp)}</span>
              <span className="renombrar-hablante-codigo muted">voz {sp}</span>
            </label>
            <input
              id={`hablante-${reunionId}-${sp}`}
              type="text"
              className="renombrar-hablante-input"
              value={nombres[sp] ?? ''}
              onChange={(e) => {
                setNombres((prev) => ({ ...prev, [sp]: e.target.value }))
                setOk(false)
              }}
              placeholder="Ej. Luis, María…"
              maxLength={120}
              disabled={disabled || guardando}
            />
          </li>
        ))}
      </ul>
      <div className="renombrar-hablantes-acciones">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleGuardar()}
          disabled={disabled || guardando}
        >
          {guardando ? 'Guardando…' : 'Guardar nombres'}
        </button>
        {ok && (
          <span className="renombrar-hablantes-ok" role="status">
            Nombres guardados
          </span>
        )}
        {error && (
          <span className="renombrar-hablantes-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}
