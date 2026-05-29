import { useEffect, useMemo, useState } from 'react'
import {
  deleteHablanteUsuario,
  getHablantesUsuarios,
  getReunionParticipantes,
  guardarNombresHablantes,
  setHablanteUsuario,
} from '../api'
import type { MapaHablantes, Reunion, ReunionUsuarioAcceso, ReunionUsuariosResponse } from '../types'
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

  const [participantes, setParticipantes] = useState<ReunionUsuariosResponse | null>(null)
  const [hablantesUsuarios, setHablantesUsuarios] = useState<Record<string, number>>({})
  const [guardandoAsignacion, setGuardandoAsignacion] = useState(false)

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
  useEffect(() => {
    void getReunionParticipantes(reunionId)
      .then(setParticipantes)
      .catch(() => setParticipantes(null))
    void getHablantesUsuarios(reunionId)
      .then(setHablantesUsuarios)
      .catch(() => setHablantesUsuarios({}))
  }, [reunionId])

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
  const opcionesUsuarios: ReunionUsuarioAcceso[] = useMemo(() => {
    const dueno = participantes?.dueno ? [participantes.dueno] : []
    const asignados = participantes?.asignados ?? []
    const all = [...dueno, ...asignados]
    const seen = new Set<number>()
    return all.filter((u) => {
      if (seen.has(u.id)) return false
      seen.add(u.id)
      return true
    })
  }, [participantes])

  const usuariosAsignados = useMemo(() => {
    const ids = new Set<number>()
    for (const uid of Object.values(hablantesUsuarios)) ids.add(uid)
    return opcionesUsuarios.filter((u) => ids.has(u.id))
  }, [hablantesUsuarios, opcionesUsuarios])

  if (!speakers.length) return null

  return (
    <div className="renombrar-hablantes">
      <p className="transcripcion-revisar-hablantes" role="note">
        Asigna un nombre a cada voz detectada (Persona A, B…). La separación es
        automática: revísala antes del acta o el resumen.
      </p>
      {usuariosAsignados.length > 0 && (
        <p className="muted" style={{ marginTop: '-0.25rem' }}>
          Usuarios detectados (asignados a voces):{' '}
          {usuariosAsignados.map((u) => u.nombre ?? u.email).join(', ')}
        </p>
      )}
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
            <div className="renombrar-hablante-asignar">
              <label className="muted">
                Asignar a usuario
                <select
                  value={hablantesUsuarios[sp] != null ? String(hablantesUsuarios[sp]) : ''}
                  disabled={disabled || guardando || guardandoAsignacion}
                  onChange={(e) => {
                    const v = e.target.value
                    setGuardandoAsignacion(true)
                    setError(null)
                    setOk(false)
                    if (!v) {
                      void deleteHablanteUsuario(reunionId, sp)
                        .then(() =>
                          setHablantesUsuarios((prev) => {
                            const next = { ...prev }
                            delete next[sp]
                            return next
                          }),
                        )
                        .catch((err) =>
                          setError(err instanceof Error ? err.message : 'No se pudo quitar la asignación'),
                        )
                        .finally(() => setGuardandoAsignacion(false))
                      return
                    }
                    const uid = Number(v)
                    void setHablanteUsuario(reunionId, sp, uid)
                      .then(() =>
                        setHablantesUsuarios((prev) => ({
                          ...prev,
                          [sp]: uid,
                        })),
                      )
                      .catch((err) =>
                        setError(err instanceof Error ? err.message : 'No se pudo asignar la voz al usuario'),
                      )
                      .finally(() => setGuardandoAsignacion(false))
                  }}
                >
                  <option value="">(Sin usuario)</option>
                  {opcionesUsuarios.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.nombre ?? u.email}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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
