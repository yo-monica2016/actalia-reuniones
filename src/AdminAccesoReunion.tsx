import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  asignarUsuarioReunion,
  listReuniones,
  listReunionUsuarios,
  listUsuarios,
  quitarUsuarioReunion,
} from './api'
import type { ReunionListItem, ReunionUsuariosResponse, UsuarioListItem } from './types'

// Añadido selector múltiple de usuarios con guardado y visualización de acceso
export function AdminAccesoReunion() {
  const [reuniones, setReuniones] = useState<ReunionListItem[]>([])
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([])
  const [reunionId, setReunionId] = useState('')
  const [acceso, setAcceso] = useState<ReunionUsuariosResponse | null>(null)
  const [seleccionIds, setSeleccionIds] = useState<number[]>([])
  const [selectorAbierto, setSelectorAbierto] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const selectorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void listReuniones()
      .then(setReuniones)
      .catch(() => setReuniones([]))
    void listUsuarios()
      .then(setUsuarios)
      .catch(() => setUsuarios([]))
  }, [])

  const usuariosNoAdmin = useMemo(() => usuarios.filter((u) => u.rol !== 'admin'), [usuarios])

  const cargarAcceso = useCallback(async (rid: number) => {
    const data = await listReunionUsuarios(rid)
    setAcceso(data)
    setSeleccionIds(data.asignados.map((u) => u.id))
  }, [])

  useEffect(() => {
    const rid = Number(reunionId)
    if (!reunionId || !Number.isInteger(rid) || rid <= 0) {
      setAcceso(null)
      setSeleccionIds([])
      setSelectorAbierto(false)
      return
    }
    setSelectorAbierto(false)
    setError(null)
    void cargarAcceso(rid).catch(() => {
      setAcceso(null)
      setSeleccionIds([])
    })
  }, [reunionId, cargarAcceso])

  useEffect(() => {
    if (!selectorAbierto) return
    function handleClickOutside(e: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorAbierto(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [selectorAbierto])

  function toggleUsuarioSeleccion(uid: number) {
    setSeleccionIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    )
  }

  const usuariosSeleccionados = useMemo(
    () => usuariosNoAdmin.filter((u) => seleccionIds.includes(u.id)),
    [usuariosNoAdmin, seleccionIds],
  )

  const textoAccesoConcedido = useMemo(() => {
    if (usuariosSeleccionados.length === 0) return '—'
    return usuariosSeleccionados.map((u) => u.nombre ?? u.email).join(', ')
  }, [usuariosSeleccionados])

  async function handleGuardarCambios() {
    const rid = Number(reunionId)
    if (!Number.isInteger(rid) || rid <= 0) return
    if (!acceso) return

    const asignadosActual = new Set(acceso.asignados.map((u) => u.id))
    const seleccionados = new Set(seleccionIds)

    const toAdd = [...seleccionados].filter((id) => !asignadosActual.has(id))
    const toRemove = [...asignadosActual].filter((id) => !seleccionados.has(id))

    if (toAdd.length === 0 && toRemove.length === 0) {
      setOk('No hay cambios')
      return
    }

    setLoading(true)
    setError(null)
    setOk(null)
    try {
      for (const uid of toAdd) {
        await asignarUsuarioReunion(rid, uid)
      }
      for (const uid of toRemove) {
        await quitarUsuarioReunion(rid, uid)
      }
      await cargarAcceso(rid)
      setOk('Cambios guardados')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="admin-acceso panel-inner">
      <h2>Acceso a la reunión</h2>
      <p className="muted">
        Elige la reunión, abre «Seleccionar usuarios» y marca quién debe tener acceso.
      </p>

      <div className="reunion-acceso-asignar">
        <select
          className="reunion-acceso-select"
          value={reunionId}
          onChange={(e) => setReunionId(e.target.value)}
          disabled={loading}
        >
          <option value="">Elegir reunión…</option>
          {reuniones.map((r) => (
            <option key={r.id} value={String(r.id)}>
              {r.titulo}
            </option>
          ))}
        </select>
      </div>

      {acceso?.dueno && (
        <p className="muted reunion-acceso-dueno">
          Dueño: {acceso.dueno.nombre ?? acceso.dueno.email}
        </p>
      )}

      {reunionId && (
        <div className="reunion-acceso-usuarios">
          <div className="reunion-acceso-selector-wrap" ref={selectorRef}>
            <label className="reunion-acceso-multi-label">Usuarios con acceso</label>
            <button
              type="button"
              className="reunion-acceso-select reunion-acceso-selector-btn"
              onClick={() => setSelectorAbierto((v) => !v)}
              disabled={loading}
              aria-expanded={selectorAbierto}
              aria-haspopup="listbox"
            >
              Seleccionar usuarios
            </button>

            {selectorAbierto && (
              <ul className="reunion-acceso-selector-lista" role="listbox" aria-multiselectable>
                {usuariosNoAdmin.map((u) => {
                  const marcado = seleccionIds.includes(u.id)
                  return (
                    <li key={u.id} role="option" aria-selected={marcado}>
                      <button
                        type="button"
                        className={
                          marcado
                            ? 'reunion-acceso-opcion reunion-acceso-opcion--activa'
                            : 'reunion-acceso-opcion'
                        }
                        disabled={loading}
                        onClick={() => toggleUsuarioSeleccion(u.id)}
                      >
                        {u.nombre ?? u.email} — {u.email}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            <p className="muted reunion-acceso-resumen">
              Acceso concedido a: {textoAccesoConcedido}
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleGuardarCambios()}
            disabled={loading || !acceso}
          >
            Guardar cambios
          </button>
        </div>
      )}

      {error && <p className="login-error">{error}</p>}
      {ok && <p className="muted">{ok}</p>}
    </section>
  )
}
