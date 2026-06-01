import { useCallback, useState } from 'react'
import {
  createReunion,
  enviarInvitacionesReunion,
  listInvitacionesReunion,
} from '../api'
import type { ReunionInvitacion, UsuarioListItem } from '../types'

type Props = {
  replyToEmail: string
  usuariosSugeridos?: UsuarioListItem[]
  disabled?: boolean
  onConvocatoriaEnviada?: (reunionId: number, titulo: string) => void
}

function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return iso
  }
}

function parseEmailsInput(raw: string): string[] {
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return [
    ...new Set(
      raw
        .split(/[,;\n]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((e) => emailRe.test(e)),
    ),
  ]
}

export function ConvocatoriaPanel({
  replyToEmail: _replyToEmail,
  usuariosSugeridos = [],
  disabled = false,
  onConvocatoriaEnviada,
}: Props) {
  const [titulo, setTitulo] = useState('')
  const [emailsTexto, setEmailsTexto] = useState('')
  const [mensaje, setMensaje] = useState('')
  const [teamsUrl, setTeamsUrl] = useState('')
  const [fechaInicio, setFechaInicio] = useState('')
  const [fechaFin, setFechaFin] = useState('')
  const [historial, setHistorial] = useState<ReunionInvitacion[]>([])
  const [ultimaReunionId, setUltimaReunionId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [invitadoId, setInvitadoId] = useState('')

  const cargarHistorial = useCallback(async (reunionId: number) => {
    const rows = await listInvitacionesReunion(reunionId)
    setHistorial(rows)
  }, [])

  function añadirEmail(email: string) {
    const e = email.trim().toLowerCase()
    if (!e) return
    const actuales = parseEmailsInput(emailsTexto)
    if (actuales.includes(e)) return
    setEmailsTexto((prev) => (prev.trim() ? `${prev.trim()}, ${e}` : e))
  }

  const sugeridosUnicos = usuariosSugeridos.filter(
    (u, i, arr) => arr.findIndex((x) => x.email.toLowerCase() === u.email.toLowerCase()) === i,
  )

  function handleAñadirInvitadoDesplegable() {
    const uid = Number(invitadoId)
    if (!Number.isInteger(uid) || uid <= 0) return
    const u = sugeridosUnicos.find((x) => x.id === uid)
    if (!u) return
    añadirEmail(u.email)
    setInvitadoId('')
  }

  async function handleEnviar(e: React.FormEvent) {
    e.preventDefault()
    const tituloTrim = titulo.trim()
    if (!tituloTrim) {
      setError('Indica un título para la convocatoria.')
      return
    }
    const emails = parseEmailsInput(emailsTexto)
    if (emails.length === 0) {
      setError('Escribe al menos un email válido.')
      return
    }
    setLoading(true)
    setError(null)
    setOk(null)
    try {
      const reunion = await createReunion(tituloTrim)
      const res = await enviarInvitacionesReunion(reunion.id, {
        emails,
        mensaje: mensaje.trim() || undefined,
        teamsJoinUrl: teamsUrl.trim() || undefined,
        fechaInicio: fechaInicio ? new Date(fechaInicio).toISOString() : undefined,
        fechaFin: fechaFin ? new Date(fechaFin).toISOString() : undefined,
      })
      setUltimaReunionId(reunion.id)
      await cargarHistorial(reunion.id)
      setEmailsTexto('')
      onConvocatoriaEnviada?.(reunion.id, reunion.titulo)
      if (res.enviados > 0 && res.fallidos === 0) {
        setOk(
          `Convocatoria enviada. Reunión «${reunion.titulo}» creada en la lista (para el acta y el audio después).`,
        )
      } else if (res.enviados > 0) {
        const detalle = res.resultados
          .filter((r) => !r.ok)
          .map((r) => `${r.email}: ${r.error ?? 'error'}`)
          .join('; ')
        setOk(
          `Reunión creada. ${res.enviados} enviados, ${res.fallidos} fallidos. ${detalle}`,
        )
      } else {
        setError(res.resultados[0]?.error ?? 'No se pudo enviar el correo')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="convocatoria-panel">
      <h2>Convocar reunión</h2>

      {sugeridosUnicos.length > 0 && (
        <div className="invitaciones-sugeridos invitaciones-sugeridos-select">
          <label className="invitaciones-sugeridos-label">
            Añadir invitado
            <select
              className="admin-usuarios-select-lista invitaciones-invitado-select"
              value={invitadoId}
              onChange={(e) => setInvitadoId(e.target.value)}
              disabled={loading || disabled}
            >
              <option value="">Elegir invitado…</option>
              {sugeridosUnicos.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.nombre ?? u.email} — {u.email}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={loading || disabled || !invitadoId}
            onClick={handleAñadirInvitadoDesplegable}
          >
            Añadir
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => void handleEnviar(e)}
        className="form invitaciones-form convocatoria-form-grid"
      >
        <label className="convocatoria-field-full">
          Título de la convocatoria
          <input
            type="text"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Ej. Reunión con cliente"
            disabled={loading || disabled}
            required
          />
        </label>
        <label className="convocatoria-field-full">
          Enlace de Microsoft Teams
          <input
            type="url"
            value={teamsUrl}
            onChange={(e) => setTeamsUrl(e.target.value)}
            placeholder="https://teams.microsoft.com/l/meetup-join/..."
            disabled={loading || disabled}
          />
        </label>
        <label>
          Inicio
          <input
            type="datetime-local"
            value={fechaInicio}
            onChange={(e) => setFechaInicio(e.target.value)}
            disabled={loading || disabled}
          />
        </label>
        <label>
          Fin
          <input
            type="datetime-local"
            value={fechaFin}
            onChange={(e) => setFechaFin(e.target.value)}
            disabled={loading || disabled}
          />
        </label>
        <label className="convocatoria-field-full">
          Emails
          <textarea
            rows={2}
            value={emailsTexto}
            onChange={(e) => setEmailsTexto(e.target.value)}
            placeholder="persona@inpro.es, cliente@empresa.com"
            disabled={loading || disabled}
            required
          />
        </label>
        <label className="convocatoria-field-full">
          Mensaje opcional
          <textarea
            rows={2}
            value={mensaje}
            onChange={(e) => setMensaje(e.target.value)}
            placeholder="Texto del correo…"
            disabled={loading || disabled}
          />
        </label>
        <button
          type="submit"
          className="convocatoria-field-full convocatoria-submit"
          disabled={loading || disabled}
        >
          {loading ? 'Enviando…' : 'Enviar convocatoria'}
        </button>
      </form>

      {error && <p className="login-error">{error}</p>}
      {ok && <p className="muted invitaciones-ok">{ok}</p>}

      {ultimaReunionId != null && historial.length > 0 && (
        <div className="invitaciones-historial">
          <h3 className="pasos-subtitulo">Últimos envíos</h3>
          <ul className="invitaciones-lista">
            {historial.slice(0, 5).map((inv) => (
              <li
                key={inv.id}
                className={
                  inv.estado === 'error'
                    ? 'invitaciones-item invitaciones-item-error'
                    : 'invitaciones-item'
                }
              >
                <strong>{inv.email_invitado}</strong>
                <span className="muted">
                  {' '}
                  · {formatFecha(inv.creado_en)} · {inv.estado}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
