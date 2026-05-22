-- Ejecutar en phpMyAdmin si no reinicias el servidor API (migración automática al arranque).
ALTER TABLE reuniones
  ADD COLUMN transcripcion_json LONGTEXT NULL COMMENT 'segmentos diarización JSON',
  ADD COLUMN transcripcion_aviso VARCHAR(600) NULL COMMENT 'aviso si no hubo diarización';
