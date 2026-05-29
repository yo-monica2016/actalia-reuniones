import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Login } from './Login.tsx'
import { fetchMe } from './api'
import { getStoredUser, isLoggedIn } from './authStorage'
import type { Usuario } from './types'

function Root() {
  const [usuario, setUsuario] = useState<Usuario | null>(() => getStoredUser())
  const [comprobando, setComprobando] = useState(() => isLoggedIn())

  useEffect(() => {
    if (!isLoggedIn()) {
      setComprobando(false)
      return
    }
    void fetchMe()
      .then(setUsuario)
      .catch(() => {
        setUsuario(null)
      })
      .finally(() => setComprobando(false))
  }, [])

  const onLoggedIn = useCallback((u: Usuario) => {
    setUsuario(u)
  }, [])

  const onLogout = useCallback(() => {
    setUsuario(null)
  }, [])

  if (comprobando) {
    return (
      <div className="login-page">
        <p className="muted">Comprobando sesión…</p>
      </div>
    )
  }

  if (!usuario) {
    return <Login onLoggedIn={onLoggedIn} />
  }

  return <App usuario={usuario} onLogout={onLogout} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
