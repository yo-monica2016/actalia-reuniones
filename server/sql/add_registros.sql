-- Auditoría: quién hizo qué y cuándo
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
