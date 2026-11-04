-- Aplicar únicamente mediante el proceso de migración autorizado.
-- No reemplaza el valor configurado por el owner en una instalación existente.
INSERT INTO taxonomy.runtime_settings (clave, valor_integer, descripcion)
VALUES ('MASTER_DEACTIVATION_TIMEOUT_SECONDS', 60, 'Timeout inicial de comprobación de baja maestra en segundos')
ON CONFLICT (clave) DO NOTHING;
