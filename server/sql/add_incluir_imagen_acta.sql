-- Ejecutar en phpMyAdmin (base actalia_reuniones) antes de usar el checkbox en la app.
ALTER TABLE archivos_reunion
  ADD COLUMN incluir_imagen_acta TINYINT(1) NOT NULL DEFAULT 1
  COMMENT '1=incluir foto en acta PDF; 0=sin foto en PDF'
  AFTER texto_ocr;
