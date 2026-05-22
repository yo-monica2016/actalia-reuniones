import type { TranscripcionJsonGuardada } from '../types'
import {
  agruparSegmentosPorHablante,
  formatSegundos,
} from '../transcripcionView'

interface Props {
  json: TranscripcionJsonGuardada
}

export function TranscripcionPorHablante({ json }: Props) {
  const grupos = agruparSegmentosPorHablante(json.segmentos, json.hablantes)

  if (!grupos.length) {
    return (
      <p className="muted transcripcion-sin-segmentos">
        No hay segmentos por hablante en esta transcripción.
      </p>
    )
  }

  return (
    <div className="transcripcion-por-hablante" role="region" aria-label="Transcripción por hablante">
      <p className="transcripcion-por-hablante-leyenda muted">
        {grupos.length} hablante{grupos.length === 1 ? '' : 's'} ·{' '}
        {json.segmentos.length} intervenciones
      </p>
      {grupos.map((grupo, index) => (
        <details
          key={grupo.speaker}
          className="hablante-bloque"
          open={index < 3}
        >
          <summary className="hablante-resumen">
            <span className="hablante-nombre">{grupo.etiqueta}</span>
            <span className="hablante-meta">
              {grupo.segmentos.length} línea{grupo.segmentos.length === 1 ? '' : 's'} · desde{' '}
              {formatSegundos(grupo.primerInicio)}
            </span>
          </summary>
          <ul className="hablante-lineas">
            {grupo.segmentos.map((seg, i) => (
              <li
                key={`${grupo.speaker}-${seg.start}-${i}`}
                className="hablante-linea"
              >
                <time className="hablante-tiempo" dateTime={`PT${seg.start}S`}>
                  {formatSegundos(seg.start)}
                </time>
                <span className="hablante-texto">{seg.text}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}
