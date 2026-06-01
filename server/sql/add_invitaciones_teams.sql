-- Invitaciones por correo y convocatoria Teams (también migrado al arrancar el API)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
