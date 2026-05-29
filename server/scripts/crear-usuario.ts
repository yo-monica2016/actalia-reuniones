/**
 * Crear usuario (admin o normal).
 * Uso: npx tsx scripts/crear-usuario.ts email contraseña "Nombre" [admin|usuario]
 */
import '../src/loadEnv'
import mysql from 'mysql2/promise'
import { hashPassword } from '../src/auth'

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  const password = process.argv[3]
  const nombre = process.argv[4]?.trim() || null
  const rolRaw = (process.argv[5]?.trim() || 'usuario').toLowerCase()

  if (!email || !password) {
    console.error(
      'Uso: npx tsx scripts/crear-usuario.ts email contraseña "Nombre" [admin|usuario]',
    )
    process.exit(1)
  }
  if (rolRaw !== 'admin' && rolRaw !== 'usuario') {
    console.error('El rol debe ser admin o usuario')
    process.exit(1)
  }
  if (password.length < 6) {
    console.error('La contraseña debe tener al menos 6 caracteres')
    process.exit(1)
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'actalia_reuniones',
  })

  try {
    const passwordHash = await hashPassword(password)
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO usuarios (email, password_hash, nombre, rol) VALUES (?, ?, ?, ?)`,
      [email, passwordHash, nombre, rolRaw],
    )
    console.log(`Usuario creado: id=${result.insertId} email=${email} rol=${rolRaw}`)
    console.log('Usa ese email y la contraseña que acabas de escribir en la pantalla de login.')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Duplicate') || msg.includes('duplicate')) {
      console.error('Ya existe un usuario con ese email.')
    } else {
      console.error('Error:', msg)
    }
    process.exit(1)
  } finally {
    await pool.end()
  }
}

void main()
