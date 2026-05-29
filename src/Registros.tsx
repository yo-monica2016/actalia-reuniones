import { useCallback, useEffect, useState } from 'react'
import { listRegistros, listReuniones } from './api'
import type { Registro, ReunionListItem } from './types'

const ETIQUETAS_ACCION: Record<string, string> = {
  login_ok: 'Inicio de sesión',
  login_fallido: 'Login fallido',
  usuario_creado: 'Usuario creado',
  reunion_creada: 'Reunión creada',
  reunion_eliminada: 'Reunión eliminada',
  archivo_subido: 'Archivo subido',
  archivo_eliminado: 'Archivo eliminado',
  usuario_asignado: 'Usuario asignado',
  usuario_quitado: 'Usuario quitado',
  hablante_usuario_asignado: 'Voz asignada a usuario',
  hablante_usuario_quitado: 'Voz desasignada',
  transcripcion_iniciada: 'Transcripción iniciada',
  transcripcion_cancelada: 'Transcripción cancelada',
  resumen_generado: 'Resumen generado',
}

function etiquetaAccion(accion: string): string {
  return ETIQUETAS_ACCION[accion] ?? accion
}

function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function resumenDetalle(r: Registro): string {
  const d = r.detalle
  if (!d) return ''
  const partes: string[] = []
  if (typeof d.titulo === 'string' && d.titulo) partes.push(d.titulo)
  if (typeof d.storage_key === 'string' && d.storage_key) partes.push(d.storage_key)
  if (typeof d.tipo === 'string' && d.tipo) partes.push(d.tipo)
  if (typeof d.usuario_email === 'string' && d.usuario_email) partes.push(d.usuario_email)
  if (typeof d.motivo === 'string' && d.motivo) partes.push(d.motivo)
  return partes.join(' · ')
}

function tituloReunion(r: Registro): string | null {
  if (r.reunion_titulo?.trim()) return r.reunion_titulo.trim()
  return null
}

export function Registros() {
  const [lista, setLista] = useState<Registro[]>([])
  const [reuniones, setReuniones] = useState<ReunionListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reunionId, setReunionId] = useState('')
  const [accion, setAccion] = useState('')

  useEffect(() => {
    void listReuniones()
      .then(setReuniones)
      .catch(() => setReuniones([]))
  }, [])

  const cargar = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const filtros: Parameters<typeof listRegistros>[0] = { limit: 100 }
      const rid = Number(reunionId)
      if (reunionId.trim() && Number.isInteger(rid) && rid > 0) filtros.reunionId = rid
      if (accion.trim()) filtros.accion = accion.trim()
      const rows = await listRegistros(filtros)
      setLista(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLista([])
    } finally {
      setLoading(false)
    }
  }, [reunionId, accion])

  useEffect(() => {
    void cargar()
  }, [cargar])

  return (
    <section className="admin-registros panel-inner">
      <h2>Registros de actividad</h2>
      <p className="muted">Historial de acciones en la aplicación.</p>

      <div className="registros-filtros">
        <label>
          Reunión
          <select
            value={reunionId}
            onChange={(e) => setReunionId(e.target.value)}
            disabled={loading}
            className="registros-select-reunion"
          >
            <option value="">Todas las reuniones</option>
            {reuniones.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.titulo}
              </option>
            ))}
          </select>
        </label>
        <label>
          Acción
          <select value={accion} onChange={(e) => setAccion(e.target.value)} disabled={loading}>
            <option value="">Todas</option>
            {Object.entries(ETIQUETAS_ACCION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void cargar()} disabled={loading}>
          {loading ? 'Cargando…' : 'Actualizar'}
        </button>
      </div>

      {error && <p className="login-error">{error}</p>}

      {lista.length === 0 && !loading && !error && (
        <p className="muted">No hay registros con estos filtros.</p>
      )}

      {lista.length > 0 && (
        <ul className="registros-cards">
          {lista.map((r) => {
            const detalle = resumenDetalle(r)
            const reunion = tituloReunion(r)
            return (
              <li key={r.id} className="registro-card">
                <div className="registro-card-cabecera">
                  <span className="registro-card-fecha">{formatFecha(r.creado_en)}</span>
                  <span className="registro-card-accion">{etiquetaAccion(r.accion)}</span>
                </div>
                <p className="registro-card-usuario muted">{r.email ?? '—'}</p>
                {reunion && <p className="registro-card-reunion">{reunion}</p>}
                {detalle && <p className="registro-card-detalle muted">{detalle}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
