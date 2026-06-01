import nodemailer from 'nodemailer'

export function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASS?.trim(),
  )
}

function createTransport() {
  const port = Number(process.env.SMTP_PORT) || 587
  const secure = process.env.SMTP_SECURE === 'true' || port === 465
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 15_000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 10_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface InvitacionEmailInput {
  para: string
  replyTo: string
  reunionTitulo: string
  reunionId: number
  mensajeOpcional?: string | null
  teamsJoinUrl?: string | null
  fechaInicio?: string | null
  fechaFin?: string | null
  enviadoPorNombre?: string | null
}

export async function enviarInvitacionReunion(input: InvitacionEmailInput): Promise<void> {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP no configurado (SMTP_HOST, SMTP_USER, SMTP_PASS en server/.env)')
  }

  const appUrl = (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '')
  const enlaceReunion = `${appUrl}/?reunion=${input.reunionId}`
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'noreply@localhost'


  const fmt = (iso: string | null | undefined): string => {
    if (!iso?.trim()) return ''
    try {
      return new Date(iso).toLocaleString('es-ES', {
        dateStyle: 'full',
        timeStyle: 'short',
      })
    } catch {
      return iso
    }
  }
  const inicioTxt = fmt(input.fechaInicio)
  const finTxt = fmt(input.fechaFin)
  const lineas: string[] = []
  lineas.push(`Convocatoria: ${input.reunionTitulo}`)
  lineas.push('')
  if (inicioTxt) {
    lineas.push(`Cuándo: ${inicioTxt}${finTxt ? ` – ${finTxt}` : ''}`)
    lineas.push('')
  }
  if (input.mensajeOpcional?.trim()) {
    lineas.push(input.mensajeOpcional.trim())
    lineas.push('')
  }
  if (input.teamsJoinUrl?.trim()) {
    lineas.push('Unirse en Microsoft Teams:')
    lineas.push(input.teamsJoinUrl.trim())
    lineas.push('')
  }
  lineas.push(`Documentación de la reunión (Actalia): ${enlaceReunion}`)
  if (input.enviadoPorNombre?.trim()) {
    lineas.push('')
    lineas.push(`Convocado por: ${input.enviadoPorNombre.trim()}`)
  }

  const text = lineas.join('\n')
  const html = `
    <h2 style="font-family:sans-serif">Convocatoria de reunión</h2>
    <p style="font-family:sans-serif"><strong>${escapeHtml(input.reunionTitulo)}</strong></p>
    ${inicioTxt ? `<p style="font-family:sans-serif"><strong>Cuándo:</strong> ${escapeHtml(inicioTxt)}${finTxt ? ` – ${escapeHtml(finTxt)}` : ''}</p>` : ''}
    ${input.mensajeOpcional?.trim() ? `<p style="font-family:sans-serif">${escapeHtml(input.mensajeOpcional.trim())}</p>` : ''}
    ${
      input.teamsJoinUrl?.trim()
        ? `<p style="font-family:sans-serif"><a href="${escapeHtml(input.teamsJoinUrl.trim())}" style="display:inline-block;padding:10px 16px;background:#5b5fc7;color:#fff;text-decoration:none;border-radius:4px">Unirse en Microsoft Teams</a></p>
           <p style="font-family:sans-serif;font-size:12px;color:#666">${escapeHtml(input.teamsJoinUrl.trim())}</p>`
        : ''
    }
    <p style="font-family:sans-serif"><a href="${enlaceReunion}">Abrir reunión en Actalia</a></p>
    ${
      input.enviadoPorNombre?.trim()
        ? `<p style="font-family:sans-serif;font-size:12px;color:#666">Convocado por ${escapeHtml(input.enviadoPorNombre.trim())}</p>`
        : ''
    }
  `.trim()

  const transport = createTransport()
  await transport.sendMail({
    from,
    to: input.para,
    replyTo: input.replyTo,
    subject: `Convocatoria: ${input.reunionTitulo}`,
    text,
    html,
  })
}