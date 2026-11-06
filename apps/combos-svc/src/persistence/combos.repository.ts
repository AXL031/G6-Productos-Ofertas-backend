import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
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
  components: Array<{
    sku: string;
    quantity: number;
    productId: string;
    catalogObservedAt: string;
  }>;
}
export interface ComboPatch {
  name: string;
  description: string | null;
  price: string;
  currency: string;
  expectedVersion: bigint;
  components?: Array<{
    sku: string;
    quantity: number;
    productId: string;
    catalogObservedAt: string;
  }>;
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

class ProductCandidateSnapshotChangedError extends Error {
  constructor() {
    super('PRODUCT_CANDIDATE_SNAPSHOT_CHANGED');
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
    candidateSkus?: string[];
    snapshotRetries?: number;
  }): Promise<'PROCESSED' | 'DUPLICATE'> {
    const productDeactivation =
      input.eventName === 'catalog.product.deactivated' &&
      input.handler === 'combos.catalog.product.deactivated';
    if (productDeactivation) {
      const prior = await this.database.query((client) =>
        this.existingDisposition(client, input),
      );
      if (prior) return prior;
      if (!input.resolveProductSkus)
        throw new Error('PRODUCT_SKU_RESOLVER_REQUIRED');
      const candidates = await this.database.query(async (client) =>
        client.query(
          'SELECT DISTINCT sku FROM combos.combo_items ORDER BY sku',
        ),
      );
      input.candidateSkus = candidates.rows.map((row) => String(row.sku));
      input.skus = await input.resolveProductSkus(input.candidateSkus);
    }
    try {
      return await this.database.query(async (client) => {
        await client.query('BEGIN');
        try {
          const skuDeactivation =
            input.eventName === 'catalog.sku.deactivated' &&
            input.handler === 'combos.catalog.sku.deactivated';
          const stockChange =
            input.eventName === 'inventory.stock.changed' &&
            input.handler === 'combos.inventory.stock.changed';
          if (productDeactivation) {
            await client.query('SELECT pg_advisory_xact_lock($1)', [
              COMPONENT_CATALOG_LOCK_KEY,
            ]);
            const prior = await this.existingDisposition(client, input);
            if (prior) {
              await client.query('COMMIT');
              return prior;
            }
            const currentCandidates = await client.query(
              'SELECT DISTINCT sku FROM combos.combo_items ORDER BY sku',
            );
            const currentSkus = currentCandidates.rows.map((row) =>
              String(row.sku),
            );
            if (
              JSON.stringify(currentSkus) !==
              JSON.stringify(input.candidateSkus ?? [])
            )
              throw new ProductCandidateSnapshotChangedError();
          } else if (skuDeactivation) {
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
            const duplicate = await this.existingDisposition(client, input);
            if (!duplicate) throw new InboxMessageConflictError();
            await client.query('COMMIT');
            return duplicate;
          }

          if (productDeactivation && input.skus) {
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

          if (skuDeactivation && input.sku) {
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

          if (stockChange && input.sku) {
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
    } catch (error) {
      if (
        error instanceof ProductCandidateSnapshotChangedError &&
        (input.snapshotRetries ?? 0) < 2
      )
        return this.processEvent({
          ...input,
          snapshotRetries: (input.snapshotRetries ?? 0) + 1,
        });
      throw error;
    }
  }

  private async existingDisposition(
    client: import('pg').PoolClient,
    input: {
      messageId: string;
      handler: string;
      eventName: string;
      correlationId: string;
      operationId: string | null;
      payload: Record<string, unknown>;
      disposition: 'PROCESSED' | 'REJECTED_INVALID_EVENT';
    },
  ): Promise<'DUPLICATE' | null> {
    const existing = await client.query(
      `SELECT 1 FROM combos.inbox
       WHERE message_id = $1 AND handler = $2`,
      [input.messageId, input.handler],
    );
    if (existing.rowCount === 0) return null;
    const identical = await client.query(
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
    if (identical.rowCount === 0) throw new InboxMessageConflictError();
    return 'DUPLICATE';
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
    if (code === '22P02' || code === '22003')
      throw new BadRequestException({ code: 'VALIDACION' });
    if (code === '23505')
      throw new ConflictException({ code: 'VERSION_CONFLICT' });
    if (code === '23503' || code === '23514')
      throw new UnprocessableEntityException({ code: 'VALIDACION' });
    throw error;
  }

  async get(id: string): Promise<ComboAggregate | undefined> {
    try {
      return await this.database.drizzle().transaction(
        async (tx) => {
          await tx.execute(
            sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );
          const [combo] = await tx
            .select()
            .from(combos)
            .where(eq(combos.id, id))
            .limit(1);
          if (!combo) return undefined;
          const components = await tx
            .select({
              id: comboItems.id,
              sku: comboItems.sku,
              quantity: comboItems.quantity,
            })
            .from(comboItems)
            .where(eq(comboItems.comboId, id))
            .orderBy(asc(comboItems.createdAt), asc(comboItems.id));
          return { combo, components };
        },
        { isolationLevel: 'repeatable read' },
      );
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
      if (!Number.isSafeInteger((input.page - 1) * input.size))
        throw new RangeError('PAGINATION_OFFSET_INVALID');
      return await this.database.drizzle().transaction(
        async (tx) => {
          await tx.execute(
            sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );
          const conditions = input.status
            ? [eq(combos.status, input.status)]
            : [];
          const where = conditions.length ? and(...conditions) : undefined;
          const [count] = await tx
            .select({ total: sql<string>`count(*)::text` })
            .from(combos)
            .where(where);
          const rows = await tx
            .select()
            .from(combos)
            .where(where)
            .orderBy(desc(combos.createdAt), asc(combos.id))
            .limit(input.size)
            .offset((input.page - 1) * input.size);
          const ids = rows.map((row) => row.id);
          const componentRows = ids.length
            ? await tx
                .select({
                  id: comboItems.id,
                  comboId: comboItems.comboId,
                  sku: comboItems.sku,
                  quantity: comboItems.quantity,
                })
                .from(comboItems)
                .where(inArray(comboItems.comboId, ids))
                .orderBy(asc(comboItems.createdAt), asc(comboItems.id))
            : [];
          const byCombo = new Map<string, ComboComponentRecord[]>();
          for (const component of componentRows) {
            const list = byCombo.get(component.comboId) ?? [];
            list.push({
              id: component.id,
              sku: component.sku,
              quantity: component.quantity,
            });
            byCombo.set(component.comboId, list);
          }
          const total = Number(count?.total ?? '0');
          if (!Number.isSafeInteger(total))
            throw new RangeError('COMBO_COUNT_OUT_OF_RANGE');
          return {
            items: rows.map((combo) => ({
              combo,
              components: byCombo.get(combo.id) ?? [],
            })),
            total,
          };
        },
        { isolationLevel: 'repeatable read' },
      );
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
        const insertedItems = await tx
          .insert(comboItems)
          .values(
            input.components.map((component) => ({
              comboId: combo.id,
              sku: component.sku,
              quantity: component.quantity,
            })),
          )
          .returning({ id: comboItems.id, sku: comboItems.sku });
        const observedAtBySku = new Map(
          input.components.map((component) => [
            component.sku,
            component.catalogObservedAt,
          ]),
        );
        await tx.insert(componentProjection).values(
          insertedItems.map((item) => ({
            comboItemId: item.id,
            catalogDeactivated: false,
            catalogObservedAt: new Date(observedAtBySku.get(item.sku)!),
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
          const insertedItems = await tx
            .insert(comboItems)
            .values(
              patch.components.map((component) => ({
                comboId: id,
                sku: component.sku,
                quantity: component.quantity,
              })),
            )
            .returning({ id: comboItems.id, sku: comboItems.sku });
          const observedAtBySku = new Map(
            patch.components.map((component) => [
              component.sku,
              component.catalogObservedAt,
            ]),
          );
          await tx.insert(componentProjection).values(
            insertedItems.map((item) => ({
              comboItemId: item.id,
              catalogDeactivated: false,
              catalogObservedAt: new Date(observedAtBySku.get(item.sku)!),
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
    components: Array<{
      sku: string;
      productId: string;
      catalogObservedAt: string;
    }>,
  ): Promise<void> {
    const observed = components.map((component) => ({
      sku: component.sku,
      product_id: component.productId,
      catalog_observed_at: component.catalogObservedAt,
    }));
    const result = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_to_recordset(${JSON.stringify(observed)}::jsonb)
          AS x(sku text, product_id text, catalog_observed_at timestamptz)
        JOIN combos.inbox i ON i.result = 'PROCESSED'
          AND i.event_name IN (
            'catalog.sku.deactivated', 'catalog.product.deactivated'
          )
          AND i.handler IN (
            'combos.catalog.sku.deactivated',
            'combos.catalog.product.deactivated'
          )
          AND (i.payload #>> '{data,changed_at}')::timestamptz > x.catalog_observed_at
          AND (
            (i.handler = 'combos.catalog.sku.deactivated'
              AND i.payload #>> '{data,sku}' = x.sku)
            OR
            (i.handler = 'combos.catalog.product.deactivated'
              AND i.payload #>> '{data,product_id}' = x.product_id)
          )
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
        .where(and(eq(combos.id, id), eq(combos.status, 'ACTIVO')))
        .returning({ id: combos.id });
      if (updated.length > 0) return true;
      const [existing] = await this.database
        .drizzle()
        .select({ id: combos.id })
        .from(combos)
        .where(eq(combos.id, id))
        .limit(1);
      return !!existing;
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
