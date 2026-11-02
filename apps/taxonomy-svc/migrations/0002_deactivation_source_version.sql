-- DEC-G6-INT-05: migración aditiva de diseño; ejecutar mediante el proceso
-- autorizado, nunca desde el arranque de la aplicación.
-- La transacción del ejecutor debe incluir este archivo completo.

ALTER TABLE taxonomy.master_deactivation_operations
  ADD COLUMN source_version bigint;

-- No inventar la versión capturada de una operación histórica aún activa.
-- El operador debe reconciliar y cerrar o respaldar esas operaciones antes
-- de reintentar este cambio mediante el procedimiento aprobado.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM taxonomy.master_deactivation_operations
    WHERE status IN ('REQUESTED', 'IN_PROGRESS')
  ) THEN
    RAISE EXCEPTION 'Operaciones de baja activas requieren reconciliación antes de la migración';
  END IF;
END
$guard$;

ALTER TABLE taxonomy.master_deactivation_operations
  ADD CONSTRAINT ck_mdo_source_version CHECK (source_version IS NULL OR source_version >= 0),
  ADD CONSTRAINT ck_mdo_active_source_version CHECK (
    status NOT IN ('REQUESTED', 'IN_PROGRESS') OR source_version IS NOT NULL
  );

CREATE UNIQUE INDEX uq_mdo_active_entity
  ON taxonomy.master_deactivation_operations (entity_type, entity_id)
  WHERE status IN ('REQUESTED', 'IN_PROGRESS');
