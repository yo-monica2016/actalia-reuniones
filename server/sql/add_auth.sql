-- Autenticación: usuarios y propietario de reuniones
-- Ejecutar en phpMyAdmin (base actalia_reuniones) si no reinicias el API (el servidor también migra al arrancar).

CREATE TABLE IF NOT EXISTS usuarios (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nombre VARCHAR(120) NULL,
  rol ENUM('admin', 'usuario') NOT NULL DEFAULT 'usuario',
  creado_en TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE reuniones
  ADD COLUMN usuario_id INT UNSIGNED NULL AFTER id,
  ADD INDEX idx_reuniones_usuario (usuario_id);
