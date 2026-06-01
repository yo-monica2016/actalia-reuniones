import { useEffect, useRef, useState } from 'react'


type Props = {
  abierto: boolean
  firmanteInicial: string
  loading?: boolean
  onCerrar: () => void
  onConfirmar: (firmaPng: Blob, firmante: string) => void
}

export function FirmaActaSimuladaModal({
  abierto,
  firmanteInicial,
  loading,
  onCerrar,
  onConfirmar,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dibujando = useRef(false)
  const [firmante, setFirmante] = useState(firmanteInicial)

  useEffect(() => {
    if (abierto) setFirmante(firmanteInicial)
  }, [abierto, firmanteInicial])

  useEffect(() => {
    if (!abierto) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#111'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
  }, [abierto])

  if (!abierto) return null

  function pos(e: React.MouseEvent | React.TouchEvent) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const t = 'touches' in e ? e.touches[0] : e
    return {
      x: ((t.clientX - rect.left) / rect.width) * canvas.width,
      y: ((t.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function empezar(e: React.MouseEvent | React.TouchEvent) {
    dibujando.current = true
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pos(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }

  function mover(e: React.MouseEvent | React.TouchEvent) {
    if (!dibujando.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  function terminar() {
    dibujando.current = false
  }

  function limpiar() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }

  function confirmar() {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      onConfirmar(blob, firmante.trim() || 'INPRO')
    }, 'image/png')
  }

  return (
    <div className="firma-modal-overlay" role="dialog" aria-modal="true">
      <div className="firma-modal">
        <h3>Firmar acta (simulación)</h3>
        <p className="muted firma-modal-aviso">
          No es firma con certificado digital. Solo prueba del flujo; sin validez legal.
        </p>
        <label>
          Certificado (demo)
          <input type="text" value="INPRO — certificado de demostración" readOnly />
        </label>
        <label>
          Firmante
          <input
            type="text"
            value={firmante}
            onChange={(e) => setFirmante(e.target.value)}
            disabled={loading}
          />
        </label>
        <p className="muted">Dibuja la firma en el recuadro:</p>
        <canvas
          ref={canvasRef}
          className="firma-modal-canvas"
          width={440}
          height={120}
          onMouseDown={empezar}
          onMouseMove={mover}
          onMouseUp={terminar}
          onMouseLeave={terminar}
          onTouchStart={empezar}
          onTouchMove={mover}
          onTouchEnd={terminar}
        />
        <div className="firma-modal-botones">
          <button type="button" className="btn-secondary" onClick={limpiar} disabled={loading}>
            Borrar firma
          </button>
          <button type="button" className="btn-secondary" onClick={onCerrar} disabled={loading}>
            Cancelar
          </button>
          <button type="button" className="btn-secondary" onClick={confirmar} disabled={loading}>
            {loading ? 'Guardando…' : 'Firmar'}
          </button>
        </div>
      </div>
    </div>
  )
}