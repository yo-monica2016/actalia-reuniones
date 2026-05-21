-- Ejecutar en phpMyAdmin (base actalia_reuniones) si no reinicias el servidor API.
ALTER TABLE reuniones
  ADD COLUMN incluir_transcripcion_acta TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1=incluir transcripción en acta.pdf',
  ADD COLUMN incluir_resumen_acta TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1=incluir resumen en acta.pdf';
