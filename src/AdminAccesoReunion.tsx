import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  asignarUsuarioReunion,
  listReuniones,
  listReunionUsuarios,
  listUsuarios,
  quitarUsuarioReunion,
} from './api'
import type { ReunionListItem, ReunionUsuariosResponse, UsuarioListItem } from './types'

export function AdminAccesoReunion() {
  const [reuniones, setReuniones] = useState<ReunionListItem[]>([])
  const [usuarios, setUsuarios] = useState<UsuarioListItem[]>([])
  const [reunionId, setReunionId] = useState('')
  const [usuarioId, setUsuarioId] = useState('')
  const [acceso, setAcceso] = useState<ReunionUsuariosResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [seleccion, setSeleccion] = useState<Record<number, boolean>>({})

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
  }, [])

  useEffect(() => {
    const rid = Number(reunionId)
    if (!reunionId || !Number.isInteger(rid) || rid <= 0) {
      setAcceso(null)
      return
    }
    setError(null)
    void cargarAcceso(rid).catch(() => setAcceso(null))
  }, [reunionId, cargarAcceso])

  useEffect(() => {
    if (!acceso) {
      setSeleccion({})
      return
    }
    const next: Record<number, boolean> = {}
    for (const u of acceso.asignados) next[u.id] = true
    setSeleccion(next)
  }, [acceso])

  async function handleAsignar() {
    const rid = Number(reunionId)
    const uid = Number(usuarioId)
    if (!Number.isInteger(rid) || rid <= 0) return
    if (!Number.isInteger(uid) || uid <= 0) return

    setLoading(true)
    setError(null)
    setOk(null)
    try {
      const asignados = await asignarUsuarioReunion(rid, uid)
      setAcceso((prev) => ({
        dueno: prev?.dueno ?? null,
        asignados,
      }))
      setOk('Usuario asignado a la reunión')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleQuitar() {
    const rid = Number(reunionId)
    const uid = Number(usuarioId)
    if (!Number.isInteger(rid) || rid <= 0) return
    if (!Number.isInteger(uid) || uid <= 0) return

    setLoading(true)
    setError(null)
    setOk(null)
    try {
      await quitarUsuarioReunion(rid, uid)
      await cargarAcceso(rid)
      setOk('Acceso quitado')
      setUsuarioId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleGuardarCambios() {
    const rid = Number(reunionId)
    if (!Number.isInteger(rid) || rid <= 0) return
    if (!acceso) return

    const asignadosActual = new Set(acceso.asignados.map((u) => u.id))
    const seleccionados = new Set<number>(
      Object.entries(seleccion)
        .filter(([, v]) => v === true)
        .map(([k]) => Number(k))
        .filter((n) => Number.isInteger(n) && n > 0),
    )

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
      <p className="muted">Gestiona qué usuarios tienen acceso a una reunión.</p>

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

        <select
          className="reunion-acceso-select"
          value={usuarioId}
          onChange={(e) => setUsuarioId(e.target.value)}
          disabled={loading || !reunionId}
        >
          <option value="">Elegir usuario…</option>
          {usuariosNoAdmin.map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.nombre ?? u.email}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleAsignar()}
          disabled={loading || !reunionId || !usuarioId}
        >
          Asignar
        </button>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleQuitar()}
          disabled={loading || !reunionId || !usuarioId}
        >
          Quitar
        </button>
      </div>

      {reunionId && (
        <div style={{ marginTop: '0.75rem' }}>
          <p className="muted" style={{ marginBottom: '0.35rem' }}>
            Marca los usuarios que deben tener acceso:
          </p>
          <ul className="lista reunion-acceso-lista">
            {usuariosNoAdmin.map((u) => {
              const marcado = Boolean(seleccion[u.id])
              return (
                <li key={u.id} className="reunion-acceso-item">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={marcado}
                      disabled={loading}
                      onChange={(e) =>
                        setSeleccion((prev) => ({
                          ...prev,
                          [u.id]: e.target.checked,
                        }))
                      }
                    />
                    <span>{u.nombre ?? u.email}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleGuardarCambios()}
            disabled={loading || !acceso}
            style={{ marginTop: '0.5rem' }}
          >
            Guardar cambios
          </button>
        </div>
      )}

      {error && <p className="login-error">{error}</p>}
      {ok && <p className="muted">{ok}</p>}

      {acceso?.dueno && (
        <p className="muted">Dueño: {acceso.dueno.nombre ?? acceso.dueno.email}</p>
      )}

      {acceso && acceso.asignados.length > 0 ? (
        <ul className="lista reunion-acceso-lista">
          {acceso.asignados.map((u) => (
            <li key={u.id} className="reunion-acceso-item">
              <span>{u.nombre ?? u.email}</span>
            </li>
          ))}
        </ul>
      ) : reunionId ? (
        <p className="muted">Ningún usuario asignado además del dueño.</p>
      ) : null}
    </section>
  )
}

