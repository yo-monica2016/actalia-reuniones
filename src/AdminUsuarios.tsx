import { useCallback, useEffect, useState } from 'react'
import { crearUsuario, listUsuarios } from './api'
import type { UsuarioListItem } from './types'

export function AdminUsuarios() {
  const [lista, setLista] = useState<UsuarioListItem[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [nombre, setNombre] = useState('')
  const [rol, setRol] = useState<'usuario' | 'admin'>('usuario')
  const [loading, setLoading] = useState(false)
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; text: string } | null>(
    null,
  )
  const [usuarioSeleccionado, setUsuarioSeleccionado] = useState('')
  const cargar = useCallback(async () => {
    const rows = await listUsuarios()
    setLista(rows)
  }, [])

  useEffect(() => {
    void cargar().catch((e: Error) =>
      setMensaje({ tipo: 'error', text: e.message }),
    )
  }, [cargar])

  async function handleCrear(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMensaje(null)
    try {
      await crearUsuario({
        email: email.trim(),
        password,
        nombre: nombre.trim() || undefined,
        rol,
      })
      setEmail('')
      setPassword('')
      setNombre('')
      setRol('usuario')
      await cargar()
      setMensaje({ tipo: 'ok', text: 'Usuario creado' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al crear usuario',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="admin-usuarios panel-inner">
      <h2>Usuarios</h2>
      <p className="muted">Crear cuentas para que accedan a sus reuniones.</p>
      {mensaje && (
        <p className={`admin-usuarios-mensaje ${mensaje.tipo === 'ok' ? 'muted' : 'login-error'}`}>
          {mensaje.text}
        </p>
      )}
      <form onSubmit={(e) => void handleCrear(e)} className="admin-usuarios-form form">
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            disabled={loading}
          />
        </label>
        <label>
          Nombre
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            disabled={loading}
          />
        </label>
        <label>
          Rol
          <select value={rol} onChange={(e) => setRol(e.target.value as 'usuario' | 'admin')} disabled={loading}>
            <option value="usuario">Usuario</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Creando…' : 'Crear usuario'}
        </button>
      </form>
      
      <label className="admin-usuarios-ver-lista">
        Usuarios
        <select
          className="admin-usuarios-select-lista"
          value={usuarioSeleccionado}
          onChange={(e) => setUsuarioSeleccionado(e.target.value)}
          disabled={loading}
        >
          <option value="">
            {lista.length === 0 ? 'No hay usuarios creados' : 'Ver usuarios…'}
          </option>
          {lista.map((u) => (
            <option key={u.id} value={String(u.id)}>
              {u.nombre
                ? `${u.nombre} — ${u.email} (${u.rol})`
                : `${u.email} (${u.rol})`}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}
