import { useCallback, useEffect, useRef, useState } from 'react'
import {
  checkHealth,
  createReunion,
  getReunion,
  listReuniones,
  uploadAudio,
  transcribirReunion,
  resumirReunion,
  eliminarArchivo,
  eliminarReunion,
  archivoUrl,
  transcripcionTxtUrl,
  transcripcionPdfUrl,
  API_BASE,
} from './api'
import { etiquetaEstado } from './estados'
import type { Reunion, ReunionListItem } from './types'
import './App.css'

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

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function App() {
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [reuniones, setReuniones] = useState<ReunionListItem[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detalle, setDetalle] = useState<Reunion | null>(null)
  const [tituloNuevo, setTituloNuevo] = useState('')
  const [loading, setLoading] = useState(false)
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; text: string } | null>(
    null,
  )
  const [grabando, setGrabando] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mediaRefs = useRef<Map<number, HTMLMediaElement>>(new Map())
  const cargarLista = useCallback(async () => {
    const lista = await listReuniones()
    setReuniones(lista)
  }, [])

  const cargarDetalle = useCallback(async (id: number) => {
    const r = await getReunion(id)
    setDetalle(r)
    setSelectedId(id)
  }, [])

  useEffect(() => {
    void checkHealth().then(setApiOk)
    const t = setInterval(() => {
      void checkHealth().then(setApiOk)
    }, 15000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (apiOk) {
      cargarLista().catch((e: Error) =>
        setMensaje({ tipo: 'error', text: e.message }),
      )
    }
  }, [apiOk, cargarLista])

  useEffect(() => {
    mediaRefs.current.clear()
  }, [selectedId])

  async function handleCrear(e: React.FormEvent) {
    e.preventDefault()
    const titulo = tituloNuevo.trim()
    if (!titulo) return
    setLoading(true)
    setMensaje(null)
    try {
      const creada = await createReunion(titulo)
      setTituloNuevo('')
      await cargarLista()
      await cargarDetalle(creada.id)
      setMensaje({ tipo: 'ok', text: 'Reunión creada' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al crear',
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleSubirAudio(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await uploadAudio(selectedId, file)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Audio subido correctamente' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al subir',
      })
    } finally {
      setLoading(false)
    }
  }
  async function handleTranscribir(archivoId?: number) {
    if (selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await transcribirReunion(selectedId, archivoId)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Transcripción completada' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al transcribir',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
    }
  }

  async function handleEliminarArchivo(archivoId: number, storageKey: string) {
    if (selectedId == null) return
    const ok = window.confirm(
      `¿Eliminar el archivo "${storageKey}"? No se puede deshacer.`,
    )
    if (!ok) return

    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await eliminarArchivo(selectedId, archivoId)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Archivo eliminado' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al eliminar',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
    }
  }
  async function handleEliminarReunion() {
    if (selectedId == null || !detalle) return
    const ok = window.confirm(
      `¿Eliminar la reunión "${detalle.titulo}" por completo?\n\nSe borrarán audio, transcripción y resumen. No se puede deshacer.`,
    )
    if (!ok) return

    setLoading(true)
    setMensaje(null)
    try {
      await eliminarReunion(selectedId)
      setDetalle(null)
      setSelectedId(null)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Reunión eliminada' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al eliminar la reunión',
      })
    } finally {
      setLoading(false)
    }
  }

  function handleMediaPlay(archivoId: number) {
    mediaRefs.current.forEach((el, id) => {
      if (id !== archivoId) {
        el.pause()
      }
    })
  }

  function setMediaRef(archivoId: number, el: HTMLMediaElement | null) {
    if (el) {
      mediaRefs.current.set(archivoId, el)
    } else {
      mediaRefs.current.delete(archivoId)
    }
  }

  async function handleResumir() {
    if (selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await resumirReunion(selectedId)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Resumen generado' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al resumir',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
    }
  }
  async function handleIniciarGrabacion() {
    if (selectedId == null || grabando || loading) return
    setMensaje(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mediaRecorderRef.current = recorder
      recorder.start()
      setGrabando(true)
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'No se pudo usar el micrófono. Permite el acceso en el navegador.',
      })
    }
  }

  async function handlePararGrabacion() {
    const recorder = mediaRecorderRef.current
    if (!recorder || !grabando || selectedId == null) return

    setLoading(true)
    setGrabando(false)
    setMensaje(null)

    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        recorder.addEventListener(
          'stop',
          () => {
            recorder.stream.getTracks().forEach((t) => t.stop())
            const type = recorder.mimeType || 'audio/webm'
            resolve(new Blob(chunksRef.current, { type }))
          },
          { once: true },
        )
        recorder.addEventListener(
          'error',
          () => reject(new Error('Error al grabar audio')),
          { once: true },
        )
        recorder.stop()
      })

      mediaRecorderRef.current = null
      chunksRef.current = []

      const ext = blob.type.includes('webm') ? 'webm' : 'ogg'
      const file = new File([blob], `Grabacion-${Date.now()}.${ext}`, {
        type: blob.type || 'audio/webm',
      })

      const actualizada = await uploadAudio(selectedId, file)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Grabación subida correctamente' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al subir la grabación',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Actalia reuniones</h1>

        </div>
        <div className="header-meta">
          <span
            className={`pill ${apiOk === true ? 'pill-ok' : apiOk === false ? 'pill-error' : 'pill-wait'}`}
          >
            API {apiOk === true ? 'conectada' : apiOk === false ? 'desconectada' : '…'}
          </span>

        </div>
      </header>

      {apiOk === false && (
        <div className="alert alert-error">
          No se puede conectar al API en <strong>{API_BASE}</strong>. Arranca el servidor:{' '}
          <code>cd server</code> → <code>npm run dev</code>
        </div>
      )}

      {mensaje && (
        <div className={`alert alert-${mensaje.tipo === 'ok' ? 'ok' : 'error'}`}>
          {mensaje.text}
        </div>
      )}

      <div className="layout">
        <aside className="panel">
          <h2>Nueva reunión</h2>
          <form onSubmit={handleCrear} className="form">
            <label htmlFor="titulo">Título</label>
            <input
              id="titulo"
              type="text"
              value={tituloNuevo}
              onChange={(e) => setTituloNuevo(e.target.value)}
              placeholder="Ej. Reunión con cliente"
              disabled={loading || apiOk !== true}
            />
            <button type="submit" disabled={loading || apiOk !== true || !tituloNuevo.trim()}>
              Crear reunión
            </button>
          </form>

          <div className="lista-header">
            <h2>Reuniones</h2>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void cargarLista()}
              disabled={apiOk !== true || loading}
            >
              Actualizar
            </button>
          </div>

          {reuniones.length === 0 ? (
            <p className="muted">No hay reuniones. Crea una arriba.</p>
          ) : (
            <ul className="lista">
              {reuniones.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`lista-item ${selectedId === r.id ? 'active' : ''}`}
                    onClick={() => void cargarDetalle(r.id)}
                  >
                    <span className="lista-titulo">{r.titulo}</span>
                    <span className={`badge badge-${r.estado}`}>
                      {etiquetaEstado(r.estado)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="panel panel-main">
          {!detalle ? (
            <p className="muted empty">Selecciona una reunión o crea una nueva.</p>
          ) : (
            <>
              <div className="detalle-header">
                <h2>{detalle.titulo}</h2>
                <span className={`badge badge-${detalle.estado}`}>
                  {etiquetaEstado(detalle.estado)}
                </span>
                <button
                  type="button"
                  className="btn-secondary btn-eliminar-reunion"
                  onClick={() => void handleEliminarReunion()}
                  disabled={loading || apiOk !== true}
                >
                  Eliminar reunión
                </button>
              </div>

              {detalle.estado === 'error' && detalle.error_mensaje && (
                <div className="alert alert-error reunion-error-detalle" role="alert">
                  <strong>Error en el proceso:</strong> {detalle.error_mensaje}
                </div>
              )}

              <dl className="meta-grid">
                <div>
                  <dt>ID</dt>
                  <dd>{detalle.id}</dd>
                </div>
                <div>
                  <dt>Creada</dt>
                  <dd>{formatFecha(detalle.creado_en)}</dd>
                </div>
                <div>
                  <dt>Actualizada</dt>
                  <dd>{formatFecha(detalle.actualizado_en)}</dd>
                </div>
              </dl>

              <section className="upload-section">
                <h3>Audio de la reunión</h3>
                <p className="muted">
                  Formatos habituales: mp3, m4a, webm, wav.
                </p>
                <label className="file-label">
                  <input
                    type="file"
                    accept="audio/*,video/*,.m4a"
                    onChange={handleSubirAudio}
                    disabled={loading || apiOk !== true}
                  />
                  {loading ? 'Subiendo…' : 'Elegir archivo de audio'}
                </label>
                <div className="grabacion-controls">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handleIniciarGrabacion()}
                    disabled={loading || grabando || apiOk !== true}
                  >
                    {grabando ? 'Grabando…' : 'Grabar'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handlePararGrabacion()}
                    disabled={!grabando || loading}
                  >
                    Parar y subir
                  </button>
                </div>
              </section>

              <section>
                <h3>Archivos</h3>
                {!detalle.archivos?.length ? (
                  <p className="muted">Aún no hay archivos subidos.</p>
                ) : (
                  <ul className="archivos">
                    {detalle.archivos.map((a) => {
                      const url = archivoUrl(detalle.id, a.id)
                      return (
                        <li key={a.id}>
                          <strong>{a.storage_key}</strong>
                          <span>
                            {a.tipo} · {formatBytes(a.tamano_bytes)} ·{' '}
                            {formatFecha(a.creado_en)}
                          </span>
                          {a.tipo === 'audio' && (
                            <audio
                              className="audio-player"
                              controls
                              src={url}
                              preload="metadata"
                              ref={(el) => setMediaRef(a.id, el)}
                              onPlay={() => handleMediaPlay(a.id)}
                            />
                          )}
                          {a.tipo === 'video' && (
                            <video
                              className="audio-player"
                              controls
                              src={url}
                              preload="metadata"
                              ref={(el) => setMediaRef(a.id, el)}
                              onPlay={() => handleMediaPlay(a.id)}
                            />
                          )}
                          <a
                            className="archivo-download"
                            href={url}
                            download={a.storage_key}
                          >
                            Descargar
                          </a>
                          <button
                            type="button"
                            className="btn-secondary btn-archivo-accion"
                            onClick={() => void handleTranscribir(a.id)}
                            disabled={
                              loading ||
                              apiOk !== true ||
                              detalle.estado === 'transcribiendo'
                            }
                          >
                            Transcribir este
                          </button>
                          <button
                            type="button"
                            className="btn-secondary btn-archivo-accion btn-archivo-eliminar"
                            onClick={() => void handleEliminarArchivo(a.id, a.storage_key)}
                            disabled={loading || apiOk !== true}
                          >
                            Eliminar
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
              <section className="upload-section">
                <h3>Transcripción</h3>
                <p className="muted">
                  En cada archivo usa «Transcribir este». El botón de abajo solo transcribe
                  el audio más reciente.
                </p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleTranscribir()}
                  disabled={
                    loading ||
                    apiOk !== true ||
                    !detalle.archivos?.length ||
                    detalle.estado === 'transcribiendo'
                  }
                >
                  {loading || detalle.estado === 'transcribiendo'
                    ? 'Transcribiendo…'
                    : 'Transcribir audio'}
                </button>
              </section>
              <section className="upload-section">
                <h3>Resumen</h3>
                <p className="muted">
                  Crea un texto corto a partir de la transcripción (primeras frases).
                </p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void handleResumir()}
                  disabled={
                    loading ||
                    apiOk !== true ||
                    !detalle.transcripcion?.trim() ||
                    detalle.estado === 'resumiendo'
                  }
                >
                  {loading || detalle.estado === 'resumiendo'
                    ? 'Generando resumen…'
                    : 'Generar resumen'}
                </button>
              </section>

              {detalle.resumen && (
                <section className="futuro">
                  <h3>Resumen</h3>
                  <p className="text-block">{detalle.resumen}</p>
                </section>
              )}

              {detalle.transcripcion?.trim() && (
                <section className="upload-section descarga-transcripcion">
                  <h3>Transcripción completa</h3>
                  <p className="muted">
                    El texto largo no se muestra aquí. Descárgalo para leerlo o archivarlo.
                  </p>
                  <div className="descarga-transcripcion-botones">
                    <a
                      className="btn-secondary descarga-link"
                      href={transcripcionTxtUrl(detalle.id)}
                      download
                    >
                      Descargar (.txt)
                    </a>
                    <a
                      className="btn-secondary descarga-link"
                      href={transcripcionPdfUrl(detalle.id)}
                      download
                    >
                      Descargar PDF
                    </a>
                  </div>
                </section>
              )}

              {detalle.estado === 'borrador' && !detalle.archivos?.length && (
                <p className="hint">Sube un audio para pasar al estado «Audio listo».</p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
