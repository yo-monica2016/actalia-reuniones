-- Firma simulada del acta (fase 1). El API también migra al arrancar (ensureFirmaActaSimuladaColumns).
-- No ejecutar si firma_acta_tipo ya existe (error #1060 columna duplicada).
ALTER TABLE reuniones
  ADD COLUMN firma_acta_tipo VARCHAR(20) NULL
    COMMENT 'simulada | certificada (futuro)',
  ADD COLUMN firma_acta_png VARCHAR(500) NULL
    COMMENT 'ruta relativa imagen firma simulada',
  ADD COLUMN firma_acta_firmada_en DATETIME(6) NULL
    COMMENT 'fecha hora firma',
  ADD COLUMN firma_acta_firmante VARCHAR(200) NULL
    COMMENT 'nombre quien firmo (simulacion)';
