-- Tabla de acceso compartido (owner en reuniones.usuario_id + filas aquí)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;