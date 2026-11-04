import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

const MODEL_TABLES: Array<[string, PgTable]> = [
  ['locations', schema.locations],
  ['stock_balance', schema.stockBalance],
  ['reservations', schema.reservations],
  ['reservation_lines', schema.reservationLines],
  ['inventory_operations', schema.inventoryOperations],
  ['kardex', schema.kardex],
  ['outbox', schema.outbox],
  ['commercial_fulfillment_routes', schema.commercialFulfillmentRoutes],
  ['stock_threshold_override', schema.stockThresholdOverride],
  ['incidencias', schema.incidencias],
  ['traslados', schema.traslados],
  ['traslado_recepciones', schema.trasladoRecepciones],
  ['inventory_config', schema.inventoryConfig],
  ['dashboard_projection', schema.dashboardProjection],
  ['inbox', schema.inbox],
];

interface ColumnShape {
  name: string;
  notNull: boolean;
  primary: boolean;
  generated?: unknown;
}

function columnNames(table: PgTable): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function col(table: PgTable, name: string): ColumnShape {
  const columns = getTableColumns(table) as Record<string, ColumnShape>;
  return columns[name];
}

describe('schema Drizzle — reconciliación con datos/inventory-svc/physical-model.md', () => {
  it('expone las 15 tablas del modelo físico con su nombre SQL', () => {
    expect(MODEL_TABLES).toHaveLength(15);
    expect(MODEL_TABLES.map(([, table]) => getTableName(table)).sort()).toEqual(
      MODEL_TABLES.map(([name]) => name).sort(),
    );
  });

  it('declara los 4 enums nuevos del modelo y sus valores exactos', () => {
    expect(schema.incidenciaEstadoEnum.enumValues).toEqual([
      'ABIERTA',
      'RESUELTA',
      'TRASLADO_PENDIENTE',
    ]);
    expect(schema.tipoResolucionIncidenciaEnum.enumValues).toEqual([
      'REHABILITADO',
      'MERMA',
      'FALTANTE_CONFIRMADO',
      'TRASLADO_ALMACEN_CENTRAL',
    ]);
    expect(schema.trasladoEstadoEnum.enumValues).toEqual([
      'EN_TRANSITO',
      'RECIBIDO_PARCIAL',
      'COMPLETADO',
      'COMPLETADO_CON_DISCREPANCIA',
    ]);
    expect(schema.disposicionRecepcionTrasladoEnum.enumValues).toEqual([
      'REINGRESAR_DISPONIBLE',
      'REINGRESAR_BLOQUEADO',
      'CONFIRMAR_MERMA',
    ]);
  });

  it('incidencias mapea las columnas del modelo (3.7)', () => {
    expect(columnNames(schema.incidencias).sort()).toEqual(
      [
        'id',
        'incidencia_id',
        'sku_id',
        'location_id',
        'external_incident_id',
        'act_ref',
        'estado',
        'tipo_resolucion',
        'cantidad_bloqueada',
        'idempotency_key',
        'correlation_id',
        'created_at',
        'updated_at',
        'resolved_at',
      ].sort(),
    );
    expect(col(schema.incidencias, 'incidencia_id').notNull).toBe(true);
    expect(col(schema.incidencias, 'idempotency_key').notNull).toBe(true);
    expect(col(schema.incidencias, 'tipo_resolucion').notNull).toBe(false);
    expect(col(schema.incidencias, 'resolved_at').notNull).toBe(false);
  });

  it('traslados referencia locations en origen y destino (3.8)', () => {
    const { foreignKeys } = getTableConfig(schema.traslados);
    expect(foreignKeys).toHaveLength(2);
    expect(foreignKeys.every((fk) => fk.onDelete === 'restrict')).toBe(true);
    expect(col(schema.traslados, 'quantity_received').notNull).toBe(true);
    expect(col(schema.traslados, 'missing_quantity').notNull).toBe(false);
  });

  it('traslado_recepciones referencia traslados con borrado en cascada (3.9)', () => {
    const { foreignKeys } = getTableConfig(schema.trasladoRecepciones);
    expect(foreignKeys).toHaveLength(1);
    expect(foreignKeys[0].onDelete).toBe('cascade');
    expect(col(schema.trasladoRecepciones, 'es_recepcion_final').notNull).toBe(
      true,
    );
  });

  it('inventory_config usa key como PK y value jsonb obligatorio (3.11)', () => {
    expect(col(schema.inventoryConfig, 'key').primary).toBe(true);
    expect(col(schema.inventoryConfig, 'value').notNull).toBe(true);
    expect(col(schema.inventoryConfig, 'description').notNull).toBe(false);
  });

  it('dashboard_projection tiene PK compuesta y available generada (3.12)', () => {
    const { primaryKeys } = getTableConfig(schema.dashboardProjection);
    expect(primaryKeys).toHaveLength(1);
    expect(
      (getTableColumns(schema.dashboardProjection).available as ColumnShape)
        .generated,
    ).toBeDefined();
    expect(col(schema.dashboardProjection, 'status').notNull).toBe(true);
  });

  it('inbox deduplica por message_id y no expone updated_at (3.14)', () => {
    const names = columnNames(schema.inbox);
    expect(names).toContain('message_id');
    expect(names).toContain('processed_at');
    expect(names).not.toContain('updated_at');
    expect(col(schema.inbox, 'message_id').notNull).toBe(true);
  });
});
