import './loadEnv'
import bcrypt from 'bcryptjs'
import jwt, { type SignOptions } from 'jsonwebtoken'
import type { RolUsuario } from './reunionAccess'

const BCRYPT_ROUNDS = 10

export interface AppJwtPayload {
  sub: number
  email: string
  rol: RolUsuario
}

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim()
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET no configurada o demasiado corta (mín. 16 caracteres) en server/.env',
    )
  }
  return secret
}

export function jwtExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN?.trim() || '7d'
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function signToken(payload: AppJwtPayload): string {
  const options: SignOptions = { expiresIn: jwtExpiresIn() as SignOptions['expiresIn'] }
  return jwt.sign(payload, jwtSecret(), options)
}

export function verifyToken(token: string): AppJwtPayload {
  const decoded = jwt.verify(token, jwtSecret())
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('token inválido')
  }
  const raw = decoded as Record<string, unknown>
  const sub = Number(raw.sub)
  const email = String(raw.email ?? '')
  const rol = raw.rol
  if (!Number.isInteger(sub) || sub <= 0 || !email) {
    throw new Error('token inválido')
  }
  if (rol !== 'admin' && rol !== 'usuario') {
    throw new Error('token inválido')
  }
  return { sub, email, rol }
}

export function parseBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7).trim()
  return token.length > 0 ? token : null
}
