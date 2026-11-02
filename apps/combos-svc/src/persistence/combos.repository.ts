import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  sql,
  type ExtractTablesWithRelations,
} from 'drizzle-orm';
import type { NodePgTransaction } from 'drizzle-orm/node-postgres';
import { CombosDatabase } from './combos.database.js';
import {
  combos,
  comboItems,
  combosTables,
  componentProjection,
} from './combos.schema.js';

export interface ComboComponentRecord {
  id: string;
  sku: string;
  quantity: number;
}
export interface ComboAggregate {
  combo: typeof combos.$inferSelect;
  components: ComboComponentRecord[];
}
export interface NewCombo {
  name: string;
  description: string | null;
  price: string;
  currency: string;
  components: Array<{ sku: string; quantity: number; productId: string }>;
}
export interface ComboPatch {
  name: string;
  description: string | null;
  price: string;
  currency: string;
  expectedVersion: bigint;
  components?: Array<{ sku: string; quantity: number; productId: string }>;
}

const COMPONENT_CATALOG_LOCK_KEY = 840084;
type CombosTransaction = NodePgTransaction<
  typeof combosTables,
  ExtractTablesWithRelations<typeof combosTables>
>;

export class CatalogComponentDeactivatedError extends Error {
  constructor() {
    super('CATALOG_COMPONENT_DEACTIVATED');
  }
}

export class InboxMessageConflictError extends Error {
  constructor() {
    super('INBOX_MESSAGE_ID_CONFLICT');
  }
}

@Injectable()
export class CombosRepository {
  constructor(private readonly database: CombosDatabase) {}

  async processEvent(input: {
    messageId: string;
    handler: string;
    eventName: string;
    correlationId: string;
    operationId: string | null;
    payload: Record<string, unknown>;
    disposition: 'PROCESSED' | 'REJECTED_INVALID_EVENT';
    sku?: string;
    skus?: string[];
    resolveProductSkus?: (componentSkus: string[]) => Promise<string[]>;
    changedAt?: string;
  }): Promise<'PROCESSED' | 'DUPLICATE'> {
    return this.database.query(async (client) => {
      await client.query('BEGIN');
      try {
        if (input.eventName === 'catalog.product.deactivated') {
          await client.query('SELECT pg_advisory_xact_lock($1)', [
            COMPONENT_CATALOG_LOCK_KEY,
          ]);
          if (!input.resolveProductSkus)
            throw new Error('PRODUCT_SKU_RESOLVER_REQUIRED');
          const candidates = await client.query(
            'SELECT DISTINCT sku FROM combos.combo_items ORDER BY sku',
          );
          input.skus = await input.resolveProductSkus(
            candidates.rows.map((row) => String(row.sku)),
          );
        } else if (input.eventName === 'catalog.sku.deactivated') {
          await client.query('SELECT pg_advisory_xact_lock($1)', [
            COMPONENT_CATALOG_LOCK_KEY,
          ]);
        }
        const inserted = await client.query(
          `INSERT INTO combos.inbox
             (message_id, handler, event_name, correlation_id, operation_id, payload, result)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (message_id, handler) DO NOTHING
           RETURNING id`,
          [
            input.messageId,
            input.handler,
            input.eventName,
            input.correlationId,
            input.operationId,
            JSON.stringify(input.payload),
            input.disposition,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await client.query(
            `SELECT 1 FROM combos.inbox
             WHERE message_id = $1 AND handler = $2 AND event_name = $3
               AND correlation_id = $4 AND operation_id IS NOT DISTINCT FROM $5
               AND payload = $6::jsonb AND result = $7`,
            [
              input.messageId,
              input.handler,
              input.eventName,
              input.correlationId,
              input.operationId,
              JSON.stringify(input.payload),
              input.disposition,
            ],
          );
          if (existing.rowCount === 0) throw new InboxMessageConflictError();
          await client.query('COMMIT');
          return 'DUPLICATE';
        }

        if (input.eventName === 'catalog.product.deactivated' && input.skus) {
          await client.query(
            `INSERT INTO combos.component_projection
               (combo_item_id, catalog_deactivated, catalog_observed_at)
             SELECT id, true, $2::timestamptz
             FROM combos.combo_items WHERE sku = ANY($1::text[])
             ON CONFLICT (combo_item_id) DO UPDATE
             SET catalog_deactivated = true,
                 catalog_observed_at = EXCLUDED.catalog_observed_at
             WHERE combos.component_projection.catalog_observed_at IS NULL
                OR combos.component_projection.catalog_observed_at <= EXCLUDED.catalog_observed_at`,
            [input.skus, input.changedAt],
          );
        }

        if (input.eventName === 'catalog.sku.deactivated' && input.sku) {
          await client.query(
            `INSERT INTO combos.component_projection
               (combo_item_id, catalog_deactivated, catalog_observed_at)
             SELECT id, true, $2::timestamptz
             FROM combos.combo_items WHERE sku = $1
             ON CONFLICT (combo_item_id) DO UPDATE
             SET catalog_deactivated = true,
                 catalog_observed_at = EXCLUDED.catalog_observed_at
             WHERE combos.component_projection.catalog_observed_at IS NULL
                OR combos.component_projection.catalog_observed_at <= EXCLUDED.catalog_observed_at`,
            [input.sku, input.changedAt],
          );
        }

        if (input.eventName === 'inventory.stock.changed' && input.sku) {
          await client.query(
            `INSERT INTO combos.component_projection
               (combo_item_id, catalog_deactivated, projected_available, inventory_observed_at)
             SELECT id, false, NULL, $2::timestamptz
             FROM combos.combo_items WHERE sku = $1
             ON CONFLICT (combo_item_id) DO UPDATE
             SET projected_available = NULL,
                 inventory_observed_at = GREATEST(
                   COALESCE(combos.component_projection.inventory_observed_at, EXCLUDED.inventory_observed_at),
                   EXCLUDED.inventory_observed_at
                 )`,
            [input.sku, input.changedAt],
          );
        }
        await client.query('COMMIT');
        return 'PROCESSED';
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private throwIfUnavailable(error: unknown): never {
    let current: unknown = error;
    let code = '';
    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current !== 'object' || current === null) break;
      if ('code' in current) code = String(current.code);
      if (!('cause' in current)) break;
      current = current.cause;
    }
    if (
      code.startsWith('08') ||
      code.startsWith('ECONN') ||
      code === 'ETIMEDOUT'
    )
      throw new ServiceUnavailableException(
        'Servicio temporalmente no disponible',
      );
    throw error;
  }

  private async componentRows(id: string): Promise<ComboComponentRecord[]> {
    return this.database
      .drizzle()
      .select({
        id: comboItems.id,
        sku: comboItems.sku,
        quantity: comboItems.quantity,
      })
      .from(comboItems)
      .where(eq(comboItems.comboId, id))
      .orderBy(asc(comboItems.createdAt), asc(comboItems.id));
  }

  async get(id: string): Promise<ComboAggregate | undefined> {
    try {
      const [combo] = await this.database
        .drizzle()
        .select()
        .from(combos)
        .where(eq(combos.id, id))
        .limit(1);
      if (!combo) return undefined;
      return { combo, components: await this.componentRows(id) };
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async list(input: {
    page: number;
    size: number;
    status?: 'ACTIVO' | 'INACTIVO';
  }): Promise<{ items: ComboAggregate[]; total: number }> {
    try {
      const conditions = input.status ? [eq(combos.status, input.status)] : [];
      const where = conditions.length ? and(...conditions) : undefined;
      const [count] = await this.database
        .drizzle()
        .select({ total: sql<number>`count(*)::int` })
        .from(combos)
        .where(where);
      const rows = await this.database
        .drizzle()
        .select()
        .from(combos)
        .where(where)
        .orderBy(desc(combos.createdAt), asc(combos.id))
        .limit(input.size)
        .offset((input.page - 1) * input.size);
      const items = await Promise.all(
        rows.map(async (combo) => ({
          combo,
          components: await this.componentRows(combo.id),
        })),
      );
      return { items, total: count?.total ?? 0 };
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async create(input: NewCombo): Promise<string> {
    try {
      return await this.database.drizzle().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${COMPONENT_CATALOG_LOCK_KEY})`,
        );
        await this.assertComponentsNotDeactivated(tx, input.components);
        const [combo] = await tx
          .insert(combos)
          .values({
            name: input.name,
            description: input.description,
            comboPrice: input.price,
            currency: input.currency,
          })
          .returning({ id: combos.id });
        if (!combo) throw new Error('COMBO_INSERT_FAILED');
        await tx.insert(comboItems).values(
          input.components.map((component) => ({
            comboId: combo.id,
            sku: component.sku,
            quantity: component.quantity,
          })),
        );
        return combo.id;
      });
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async update(id: string, patch: ComboPatch): Promise<boolean> {
    try {
      return await this.database.drizzle().transaction(async (tx) => {
        if (patch.components !== undefined) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${COMPONENT_CATALOG_LOCK_KEY})`,
          );
          await this.assertComponentsNotDeactivated(tx, patch.components);
        }
        const changed = await tx
          .update(combos)
          .set({
            name: patch.name,
            description: patch.description,
            comboPrice: patch.price,
            currency: patch.currency,
            version: sql`${combos.version} + 1`,
          })
          .where(
            and(
              eq(combos.id, id),
              eq(combos.version, patch.expectedVersion),
              eq(combos.status, 'ACTIVO'),
            ),
          )
          .returning({ id: combos.id });
        if (!changed.length) return false;
        if (patch.components !== undefined) {
          await tx.delete(comboItems).where(eq(comboItems.comboId, id));
          await tx.insert(comboItems).values(
            patch.components.map((component) => ({
              comboId: id,
              sku: component.sku,
              quantity: component.quantity,
            })),
          );
        }
        return true;
      });
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  private async assertComponentsNotDeactivated(
    tx: CombosTransaction,
    components: Array<{ sku: string; productId: string }>,
  ): Promise<void> {
    const skus = [...new Set(components.map((component) => component.sku))];
    const productIds = [
      ...new Set(components.map((component) => component.productId)),
    ];
    const result = await tx.execute(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM combos.inbox
          WHERE handler = 'combos.catalog.sku.deactivated'
            AND result = 'PROCESSED'
            AND payload #>> '{data,sku}' IN (${sql.join(
              skus.map((sku) => sql`${sku}`),
              sql`, `,
            )})
        ) OR EXISTS (
          SELECT 1 FROM combos.inbox
          WHERE handler = 'combos.catalog.product.deactivated'
            AND result = 'PROCESSED'
            AND payload #>> '{data,product_id}' IN (${sql.join(
              productIds.map((productId) => sql`${productId}`),
              sql`, `,
            )})
        ) AS blocked
    `);
    if (result.rows[0]?.blocked === true)
      throw new CatalogComponentDeactivatedError();
  }

  async deactivate(id: string): Promise<boolean> {
    try {
      const updated = await this.database
        .drizzle()
        .update(combos)
        .set({ status: 'INACTIVO', version: sql`${combos.version} + 1` })
        .where(eq(combos.id, id))
        .returning({ id: combos.id });
      return updated.length > 0;
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }

  async projections(id: string) {
    try {
      return this.database
        .drizzle()
        .select({
          id: comboItems.id,
          sku: comboItems.sku,
          quantity: comboItems.quantity,
          catalogDeactivated: componentProjection.catalogDeactivated,
          catalogObservedAt: componentProjection.catalogObservedAt,
          projectedAvailable: componentProjection.projectedAvailable,
          inventoryObservedAt: componentProjection.inventoryObservedAt,
        })
        .from(comboItems)
        .leftJoin(
          componentProjection,
          eq(componentProjection.comboItemId, comboItems.id),
        )
        .where(eq(comboItems.comboId, id))
        .orderBy(asc(comboItems.sku));
    } catch (error) {
      return this.throwIfUnavailable(error);
    }
  }
}
