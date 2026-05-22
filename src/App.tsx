import { useCallback, useEffect, useRef, useState } from 'react'
import {
  checkHealth,
  createReunion,
  getReunion,
  listReuniones,
  uploadAudio,
  uploadArchivo,
  transcribirReunion,
  resumirReunion,
  eliminarArchivo,
  eliminarReunion,
  archivoUrl,
  downloadArchivo,
  extraerTextoImagen,
  extraerTextoDocumento,
  setIncluirImagenActa,
  setActaOpciones,
  transcripcionTxtUrl,
  transcripcionPdfUrl,
  actaPdfUrl,
  resumenTxtUrl,
  API_BASE_DISPLAY,
} from './api'
import { RenombrarHablantes } from './components/RenombrarHablantes'
import { TranscripcionPorHablante } from './components/TranscripcionPorHablante'
import { speakersUnicos } from './transcripcionView'
import { leerResumenAlmacenado } from './resumen'
import { etiquetaEstado } from './estados'
import type {
  ArchivoReunion,
  Reunion,
  ReunionListItem,
  TranscripcionJsonGuardada,
} from './types'
import './App.css'

function incluirImagenActaMarcado(a: ArchivoReunion): boolean {
  const v = a.incluir_imagen_acta
  if (v === 0 || v === false || v === '0') return false
  return true
}

function incluirTranscripcionActaMarcado(r: Reunion): boolean {
  const v = r.incluir_transcripcion_acta
  if (v === 0 || v === false || v === '0') return false
  return v === undefined || v === null || v === 1 || v === true || v === '1'
}

function incluirResumenActaMarcado(r: Reunion): boolean {
  const v = r.incluir_resumen_acta
  if (v === 0 || v === false || v === '0') return false
  return v === undefined || v === null || v === 1 || v === true || v === '1'
}

function parseTranscripcionJson(
  raw: Reunion['transcripcion_json'],
): TranscripcionJsonGuardada | null {
  if (raw == null || raw === '') return null
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (j && typeof j === 'object' && Array.isArray(j.segmentos)) {
      const hablantes =
        j.hablantes && typeof j.hablantes === 'object' && !Array.isArray(j.hablantes)
          ? (j.hablantes as TranscripcionJsonGuardada['hablantes'])
          : undefined
      return {
        diarizada: Boolean(j.diarizada),
        segmentos: j.segmentos,
        hablantes,
      }
    }
  } catch {
    /* ignorar JSON inválido */
  }
  return null
}

function mensajeTrasTranscripcion(r: Reunion): string {
  if (r.transcripcion_aviso?.trim()) {
    return r.transcripcion_aviso.trim()
  }
  const json = parseTranscripcionJson(r.transcripcion_json)
  if (json?.diarizada) {
    return 'Transcripción completada con voces separadas (Persona A, Persona B…).'
  }
  return 'Transcripción completada'
}

function etiquetaTranscribiendo(
  activa: boolean,
  minutos: number,
  textoNormal: string,
): string {
  if (!activa) return textoNormal
  return minutos > 0 ? `Transcribiendo… (${minutos} min)` : 'Transcribiendo…'
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

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function nombreVisibleArchivo(storageKey: string): string {
  const sinPrefijo = storageKey.replace(/^\d+-/, '')
  return sinPrefijo || storageKey
}

function App() {
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [reuniones, setReuniones] = useState<ReunionListItem[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detalle, setDetalle] = useState<Reunion | null>(null)
  const [tituloNuevo, setTituloNuevo] = useState('')
  const [loading, setLoading] = useState(false)
  const [guardandoIncluirId, setGuardandoIncluirId] = useState<number | null>(null)
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; text: string } | null>(
    null,
  )
  const [grabando, setGrabando] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const [mostrarResumenes, setMostrarResumenes] = useState(false)
  /** En la web el OCR no se muestra hasta «Ver transcrito»; el PDF del acta lleva todo el texto. */
  const [ocrVisiblePorArchivo, setOcrVisiblePorArchivo] = useState<
    Record<number, boolean>
  >({})
  const [transcripcionActiva, setTranscripcionActiva] = useState(false)
  const [transcripcionMinutos, setTranscripcionMinutos] = useState(0)
  const [transcripcionNotaExtra, setTranscripcionNotaExtra] = useState<string | null>(
    null,
  )
  const transcripcionInicioRef = useRef<number | null>(null)
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
    setMostrarResumenes(false)
    setOcrVisiblePorArchivo({})
  }, [selectedId])

  useEffect(() => {
    if (!transcripcionActiva) return

    const tick = () => {
      const inicio = transcripcionInicioRef.current
      if (inicio == null) return
      const min = Math.floor((Date.now() - inicio) / 60000)
      setTranscripcionMinutos(min)
      if (min === 5) {
        setTranscripcionNotaExtra('Seguimos con tu audio. Gracias por esperar.')
      }
      if (min === 15) {
        setTranscripcionNotaExtra(
          'Tu transcripción sigue en curso. No hemos olvidado tu archivo.',
        )
      }
    }

    tick()
    const id = window.setInterval(tick, 300000)
    return () => window.clearInterval(id)
  }, [transcripcionActiva])

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

  async function handleSubirMaterial(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await uploadArchivo(selectedId, file)
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: 'Archivo subido correctamente' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al subir',
      })
    } finally {
      setLoading(false)
    }
  }

  function iniciarAvisoTranscripcion() {
    transcripcionInicioRef.current = Date.now()
    setTranscripcionMinutos(0)
    setTranscripcionNotaExtra(null)
    setTranscripcionActiva(true)
  }

  function finalizarAvisoTranscripcion() {
    transcripcionInicioRef.current = null
    setTranscripcionActiva(false)
    setTranscripcionMinutos(0)
    setTranscripcionNotaExtra(null)
  }

  async function handleTranscribir(archivoId?: number) {
    if (selectedId == null) return
    iniciarAvisoTranscripcion()
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await transcribirReunion(
        selectedId,
        archivoId != null ? { archivoId } : {},
      )
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({ tipo: 'ok', text: mensajeTrasTranscripcion(actualizada) })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al transcribir',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
      finalizarAvisoTranscripcion()
    }
  }

  async function handleTranscribirTodos() {
    if (selectedId == null) return
    iniciarAvisoTranscripcion()
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await transcribirReunion(selectedId, { todos: true })
      setDetalle(actualizada)
      await cargarLista()
      setMensaje({
        tipo: 'ok',
        text: mensajeTrasTranscripcion(actualizada),
      })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al transcribir',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
      finalizarAvisoTranscripcion()
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

  async function handleDescargarArchivo(archivoId: number, storageKey: string) {
    if (selectedId == null) return
    setMensaje(null)
    try {
      await downloadArchivo(selectedId, archivoId, storageKey)
      setMensaje({ tipo: 'ok', text: 'Descarga iniciada' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al descargar',
      })
    }
  }

  async function handleExtraerTextoImagen(archivoId: number) {
    if (selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await extraerTextoImagen(selectedId, archivoId)
      setDetalle(actualizada)
      setMensaje({ tipo: 'ok', text: 'Texto extraído de la imagen' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al extraer texto',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
    }
  }

  async function handleIncluirImagenActa(archivoId: number, incluir: boolean) {
    if (selectedId == null || detalle == null) return
    const detallePrevio = detalle
    setGuardandoIncluirId(archivoId)
    setMensaje(null)
    setDetalle({
      ...detalle,
      archivos: (detalle.archivos ?? []).map((a) =>
        a.id === archivoId
          ? { ...a, incluir_imagen_acta: incluir ? 1 : 0 }
          : a,
      ),
    })
    try {
      const actualizada = await setIncluirImagenActa(selectedId, archivoId, incluir)
      setDetalle(actualizada)
    } catch (err) {
      setDetalle(detallePrevio)
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al guardar preferencia',
      })
      await cargarDetalle(selectedId)
    } finally {
      setGuardandoIncluirId(null)
    }
  }
  async function handleActaOpcion(
    campo: 'transcripcion' | 'resumen',
    incluir: boolean,
  ) {
    if (selectedId == null || !detalle) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await setActaOpciones(selectedId, {
        ...(campo === 'transcripcion'
          ? { incluirTranscripcionActa: incluir }
          : { incluirResumenActa: incluir }),
      })
      setDetalle(actualizada)
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al guardar opciones del acta',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
    }
  }

  async function handleExtraerTextoDocumento(archivoId: number) {
    if (selectedId == null) return
    setLoading(true)
    setMensaje(null)
    try {
      const actualizada = await extraerTextoDocumento(selectedId, archivoId)
      setDetalle(actualizada)
      setMensaje({ tipo: 'ok', text: 'Texto extraído del documento' })
    } catch (err) {
      setMensaje({
        tipo: 'error',
        text: err instanceof Error ? err.message : 'Error al extraer texto',
      })
      await cargarDetalle(selectedId)
    } finally {
      setLoading(false)
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
      setMostrarResumenes(false)
      setMensaje({ tipo: 'ok', text: 'Resumen generado. Descárgalo o pulsa «Ver resúmenes».' })
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

  const audiosReunion =
    detalle?.archivos?.filter((a) => a.tipo === 'audio' || a.tipo === 'video') ?? []
  const resumenDatos = leerResumenAlmacenado(detalle?.resumen)
  const hayResumenPorAudio = Object.keys(resumenDatos.porAudio).length > 0
  const hayResumenTemas = resumenDatos.temas.length > 0

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
          No se puede conectar al API en <strong>{API_BASE_DISPLAY}</strong>. Arranca el servidor:{' '}
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

              {transcripcionActiva && (
                <div className="transcripcion-aviso" role="status">
                  <p className="transcripcion-aviso-titulo">
                    Estamos transcribiendo tu audio. En archivos largos puede tardar
                    un rato. No cierres esta página.
                  </p>
                  {transcripcionMinutos > 0 && (
                    <p className="transcripcion-aviso-tiempo">
                      Lleva {transcripcionMinutos} min.
                    </p>
                  )}
                  {transcripcionNotaExtra && (
                    <p className="transcripcion-aviso-nota">{transcripcionNotaExtra}</p>
                  )}
                  <div className="transcripcion-aviso-bar" aria-hidden="true" />
                </div>
              )}

              <dl className="meta-grid">
               
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

              <section className="upload-section">
                <h3>Fotos y presentaciones</h3>
                <p className="muted">
                  Imágenes y documentos: PDF, PowerPoint (.pptx, .ppt).
                </p>
                <label className="file-label">
                  <input
                    type="file"
                    accept="image/*,.pdf,.ppt,.pptx,.odp,application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    onChange={handleSubirMaterial}
                    disabled={loading || apiOk !== true}
                  />
                  {loading ? 'Subiendo…' : 'Elegir foto o PowerPoint'}
                </label>
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
                          <strong>{nombreVisibleArchivo(a.storage_key)}</strong>
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
                          {a.tipo === 'imagen' && (
                            <>
                              <img
                                className="archivo-imagen"
                                src={url}
                                alt={a.storage_key}
                              />
                              <button
                                type="button"
                                className="btn-secondary btn-archivo-accion"
                                onClick={() => void handleExtraerTextoImagen(a.id)}
                                disabled={loading || apiOk !== true}
                              >
                                {loading ? 'Extrayendo texto…' : 'Extraer texto (OCR)'}
                              </button>
                              <label className="archivo-acta-opcion">
                                <input
                                  type="checkbox"
                                  checked={incluirImagenActaMarcado(a)}
                                  disabled={
                                    apiOk !== true || guardandoIncluirId === a.id
                                  }
                                  onChange={(e) =>
                                    void handleIncluirImagenActa(a.id, e.target.checked)
                                  }
                                />
                                Incluir imagen en el acta (PDF)
                                {guardandoIncluirId === a.id && (
                                  <span className="muted"> guardando…</span>
                                )}
                              </label>
                              {a.texto_ocr?.trim() && (
                                <>
                                  <button
                                    type="button"
                                    className="btn-secondary btn-archivo-accion"
                                    onClick={() =>
                                      setOcrVisiblePorArchivo((prev) => ({
                                        ...prev,
                                        [a.id]: !prev[a.id],
                                      }))
                                    }
                                  >
                                    {ocrVisiblePorArchivo[a.id]
                                      ? 'Ocultar transcrito'
                                      : 'Ver transcrito'}
                                  </button>
                                  {ocrVisiblePorArchivo[a.id] && (
                                    <div className="archivo-ocr-texto">
                                      <h4>Texto de la imagen</h4>
                                      <p className="text-block">{a.texto_ocr}</p>
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          )}
                          {a.tipo === 'documento' && (
                            <>
                              <p className="muted archivo-doc-hint">
                                PDF o PowerPoint (.pptx).
                               
                              </p>
                              <button
                                type="button"
                                className="btn-secondary btn-archivo-accion"
                                onClick={() => void handleExtraerTextoDocumento(a.id)}
                                disabled={loading || apiOk !== true}
                              >
                                {loading
                                  ? 'Extrayendo texto…'
                                  : 'Extraer texto del documento'}
                              </button>
                              {a.texto_ocr?.trim() && (
                                <>
                                  <button
                                    type="button"
                                    className="btn-secondary btn-archivo-accion"
                                    onClick={() =>
                                      setOcrVisiblePorArchivo((prev) => ({
                                        ...prev,
                                        [a.id]: !prev[a.id],
                                      }))
                                    }
                                  >
                                    {ocrVisiblePorArchivo[a.id]
                                      ? 'Ocultar transcrito'
                                      : 'Ver transcrito'}
                                  </button>
                                  {ocrVisiblePorArchivo[a.id] && (
                                    <div className="archivo-ocr-texto">
                                      <h4>Texto del documento</h4>
                                      <p className="text-block">{a.texto_ocr}</p>
                                    </div>
                                  )}
                                </>
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            className="archivo-download"
                            onClick={() => void handleDescargarArchivo(a.id, a.storage_key)}
                            disabled={loading || apiOk !== true}
                          >
                            Descargar
                          </button>
                          {(a.tipo === 'audio' || a.tipo === 'video') && (
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
                              {etiquetaTranscribiendo(
                                transcripcionActiva,
                                transcripcionMinutos,
                                'Transcribir este',
                              )}
                            </button>
                          )}
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
                <h3>Resumen</h3>
                <p className="muted">
                  Genera un texto corto «Ver resúmenes».
                </p>
                <div className="descarga-transcripcion-botones">
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
                  {detalle.resumen?.trim() && (
                    <>
                      <a
                        className="btn-secondary descarga-link"
                        href={resumenTxtUrl(detalle.id)}
                        download
                      >
                        Descargar resumen (.txt)
                      </a>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setMostrarResumenes((v) => !v)}
                      >
                        {mostrarResumenes ? 'Ocultar resúmenes' : 'Ver resúmenes'}
                      </button>
                    </>
                  )}
                </div>

                {mostrarResumenes && detalle.resumen?.trim() && (
                  <div className="resumen-panel">
                    {hayResumenTemas && (
                      <>
                        <h4 className="pasos-subtitulo">Temas tratados</h4>
                        <ul className="resumen-temas-lista">
                          {resumenDatos.temas.map((tema, i) => (
                            <li key={`${tema.titulo}-${i}`} className="resumen-tema-item">
                              <h5 className="resumen-tema-titulo">{tema.titulo}</h5>
                              <p className="text-block">{tema.resumen}</p>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {resumenDatos.global &&
                      (hayResumenTemas || !hayResumenPorAudio) && (
                        <>
                          <h4 className="pasos-subtitulo">
                            {hayResumenTemas ? 'Síntesis general' : 'Resumen'}
                          </h4>
                          <p className="text-block">{resumenDatos.global}</p>
                        </>
                      )}
                    {hayResumenPorAudio && (
                      <>
                        <h4 className="pasos-subtitulo">Por archivo de audio</h4>
                        <ul className="archivos resumen-por-audio-lista">
                          {Object.entries(resumenDatos.porAudio).map(([nombre, texto]) => (
                            <li key={nombre} className="resumen-audio-item">
                              <strong>{nombre}</strong>
                              <p className="text-block">{texto}</p>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </section>
              <section className="upload-section">
                <h3>Transcripción</h3>
                <p className="muted">
                  «Transcribir este» en cada archivo → solo ese audio.
                  {audiosReunion.length > 1 && (
                    <> «Transcribir todos» une todos en un solo texto.</>
                  )}{' '}
                  Con transcripción lista, descarga .txt o PDF.
                </p>
                {detalle.transcripcion_aviso?.trim() && (
                  <p className="transcripcion-aviso-diarizacion" role="status">
                    {detalle.transcripcion_aviso}
                  </p>
                )}
                {parseTranscripcionJson(detalle.transcripcion_json)?.diarizada &&
                  !detalle.transcripcion_aviso?.trim() && (
                    <p className="transcripcion-ok-diarizacion" role="status">
                      Voces separadas (Persona A, B…). Revisa por hablante abajo; el
                      modelo puede agrupar o separar voces de forma automática.
                    </p>
                  )}
                {(() => {
                  const json = parseTranscripcionJson(detalle.transcripcion_json)
                  if (json?.diarizada && json.segmentos.length > 0) {
                    return (
                      <>
                        <RenombrarHablantes
                          reunionId={detalle.id}
                          speakers={speakersUnicos(json.segmentos)}
                          hablantesIniciales={json.hablantes}
                          onGuardado={(r) => setDetalle(r)}
                          disabled={loading}
                        />
                        <TranscripcionPorHablante json={json} />
                      </>
                    )
                  }
                  if (detalle.transcripcion?.trim()) {
                    return (
                      <pre className="transcripcion-preview">
                        {detalle.transcripcion}
                      </pre>
                    )
                  }
                  return null
                })()}
                {parseTranscripcionJson(detalle.transcripcion_json)?.diarizada &&
                  detalle.transcripcion?.trim() && (
                    <details className="transcripcion-plano-extra">
                      <summary className="muted">Ver texto plano completo (todas las voces)</summary>
                      <pre className="transcripcion-preview transcripcion-preview--completo">
                        {detalle.transcripcion}
                      </pre>
                    </details>
                  )}
                <div className="descarga-transcripcion-botones">
                  {audiosReunion.length > 1 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handleTranscribirTodos()}
                      disabled={
                        loading ||
                        apiOk !== true ||
                        detalle.estado === 'transcribiendo'
                      }
                    >
                      {etiquetaTranscribiendo(
                        transcripcionActiva,
                        transcripcionMinutos,
                        loading || detalle.estado === 'transcribiendo'
                          ? 'Transcribiendo…'
                          : 'Transcribir todos',
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handleTranscribir()}
                    disabled={
                      loading ||
                      apiOk !== true ||
                      !audiosReunion.length ||
                      detalle.estado === 'transcribiendo'
                    }
                  >
                    {etiquetaTranscribiendo(
                      transcripcionActiva,
                      transcripcionMinutos,
                      loading || detalle.estado === 'transcribiendo'
                        ? 'Transcribiendo…'
                        : audiosReunion.length > 1
                          ? 'Transcribir audio más reciente'
                          : 'Transcribir audio',
                    )}
                  </button>
                  {detalle.transcripcion?.trim() && (
                    <>
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
                    </>
                  )}
                </div>
              </section>

              {(detalle.resumen?.trim() ||
                detalle.transcripcion?.trim() ||
                detalle.archivos?.some((a) => a.texto_ocr?.trim()) ||
                (detalle.archivos?.length ?? 0) > 0) && (
                <section className="upload-section descarga-transcripcion">
                  <h3>Acta de la reunión</h3>
                  <p className="muted">
                    Elige qué incluir en el PDF. Las fotos siguen con su
                    checkbox en cada imagen.
                  </p>
                  <label className="archivo-acta-opcion">
                    <input
                      type="checkbox"
                      checked={incluirTranscripcionActaMarcado(detalle)}
                      disabled={
                        loading || apiOk !== true || !detalle.transcripcion?.trim()
                      }
                      onChange={(e) =>
                        void handleActaOpcion('transcripcion', e.target.checked)
                      }
                    />
                    Incluir transcripción en el acta (PDF)
                  </label>
                  <label className="archivo-acta-opcion">
                    <input
                      type="checkbox"
                      checked={incluirResumenActaMarcado(detalle)}
                      disabled={loading || apiOk !== true || !detalle.resumen?.trim()}
                      onChange={(e) =>
                        void handleActaOpcion('resumen', e.target.checked)
                      }
                    />
                    Incluir resumen en el acta (PDF)
                  </label>
                  <div className="descarga-transcripcion-botones">
                    <a
                      className="btn-secondary descarga-link"
                      href={`${actaPdfUrl(detalle.id)}?v=${encodeURIComponent(detalle.actualizado_en)}`}
                      download
                    >
                      Descargar acta (PDF)
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
