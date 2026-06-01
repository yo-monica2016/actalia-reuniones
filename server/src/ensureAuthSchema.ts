import type { Pool } from 'mysql2/promise'

function isUnknownColumnError(err: unknown, column: string): boolean {
  const e = err as { code?: string; errno?: number; sqlMessage?: string }
  if (e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054) return true
  const msg = String(e?.sqlMessage ?? err ?? '')
  return msg.includes(column) && msg.includes('Unknown column')
}

export async function ensureUsuariosTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      nombre VARCHAR(120) NULL,
      rol ENUM('admin', 'usuario') NOT NULL DEFAULT 'usuario',
      creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  try {
    await pool.query('SELECT rol FROM usuarios LIMIT 0')
  } catch (err) {
    if (!isUnknownColumnError(err, 'rol')) throw err
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN rol ENUM('admin', 'usuario') NOT NULL DEFAULT 'usuario'
        AFTER password_hash
    `)
    console.log('[db] columna usuarios.rol creada')
  }
}

export async function ensureReunionesUsuarioId(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT usuario_id FROM reuniones LIMIT 0')
    return
  } catch (err) {
    if (!isUnknownColumnError(err, 'usuario_id')) throw err
  }
  await pool.query(`
    ALTER TABLE reuniones
      ADD COLUMN usuario_id INT UNSIGNED NULL AFTER id,
      ADD INDEX idx_reuniones_usuario (usuario_id)
  `)
  console.log('[db] columna reuniones.usuario_id creada')
}

export async function ensureReunionUsuariosTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reunion_usuarios (
      reunion_id BIGINT UNSIGNED NOT NULL,
      usuario_id INT UNSIGNED NOT NULL,
      creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (reunion_id, usuario_id),
      KEY idx_reunion_usuarios_usuario (usuario_id),
      CONSTRAINT fk_ru_reunion
        FOREIGN KEY (reunion_id) REFERENCES reuniones(id) ON DELETE CASCADE,
      CONSTRAINT fk_ru_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}
export async function ensureRegistrosTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registros (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      usuario_id INT UNSIGNED NULL,
      email VARCHAR(255) NULL,
      accion VARCHAR(64) NOT NULL,
      reunion_id BIGINT UNSIGNED NULL,
      entidad_tipo VARCHAR(32) NULL,
      entidad_id BIGINT UNSIGNED NULL,
      detalle JSON NULL,
      ip VARCHAR(45) NULL,
      creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_registros_creado (creado_en DESC),
      INDEX idx_registros_reunion (reunion_id),
      INDEX idx_registros_usuario (usuario_id),
      INDEX idx_registros_accion (accion)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}
export async function ensureReunionInvitacionesTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reunion_invitaciones (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      reunion_id BIGINT UNSIGNED NOT NULL,
      email_invitado VARCHAR(255) NOT NULL,
      mensaje TEXT NULL,
      enviado_por_usuario_id INT UNSIGNED NULL,
      estado ENUM('enviado', 'error') NOT NULL DEFAULT 'enviado',
      error_mensaje TEXT NULL,
      creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      INDEX idx_inv_reunion (reunion_id),
      INDEX idx_inv_email (email_invitado),
      CONSTRAINT fk_inv_reunion
        FOREIGN KEY (reunion_id) REFERENCES reuniones(id) ON DELETE CASCADE,
      CONSTRAINT fk_inv_usuario
        FOREIGN KEY (enviado_por_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function ensureReunionTeamsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reunion_teams (
      reunion_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
      teams_meeting_id VARCHAR(255) NULL,
      join_url VARCHAR(512) NULL,
      titulo VARCHAR(255) NULL,
      fecha_inicio DATETIME NULL,
      fecha_fin DATETIME NULL,
      creado_por_usuario_id INT UNSIGNED NULL,
      creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      actualizado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      CONSTRAINT fk_teams_reunion
        FOREIGN KEY (reunion_id) REFERENCES reuniones(id) ON DELETE CASCADE,
      CONSTRAINT fk_teams_usuario
        FOREIGN KEY (creado_por_usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
}

export async function ensureUsuariosMicrosoftColumns(pool: Pool): Promise<void> {
  try {
    await pool.query('SELECT microsoft_user_id FROM usuarios LIMIT 0')
  } catch (err) {
    if (!isUnknownColumnError(err, 'microsoft_user_id')) throw err
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN microsoft_user_id VARCHAR(128) NULL AFTER rol,
        ADD COLUMN microsoft_refresh_token TEXT NULL AFTER microsoft_user_id
    `)
    console.log('[db] columnas usuarios.microsoft_* creadas')
  }
}
