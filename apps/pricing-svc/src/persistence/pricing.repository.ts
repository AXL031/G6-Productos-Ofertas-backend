import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, isNull, or, lte, gt, inArray } from 'drizzle-orm';
import type { PriceDefinition } from '../domain/price.js';
import {
  PricingDatabase,
  type PricingTransaction,
} from './pricing.database.js';
import {
  prices,
  priceValidities,
  scheduledPrices,
  bulkPriceJobs,
  bulkPriceRows,
} from './pricing.schema.js';
import { rethrowPersistenceError } from './persistence.error.js';

// rows es opcional en EstadoImportacionPrecio; nunca devolver detalle truncado.
export const MAX_INLINE_IMPORT_ROWS = 1000;

@Injectable()
export class PricingRepository {
  constructor(
    @Inject(PricingDatabase) private readonly database: PricingDatabase,
  ) {}

  readCandidates(
    productId: string,
    sku: string,
    channelId: string | null,
    at: Date,
  ) {
    return this.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(prices)
          .where(
            and(
              or(eq(prices.productId, productId), eq(prices.sku, sku)),
              channelId === null
                ? isNull(prices.channelId)
                : or(eq(prices.channelId, channelId), isNull(prices.channelId)),
            ),
          );
        if (!rows.length) return [];
        const snapshots = await tx
          .select()
          .from(priceValidities)
          .where(
            and(
              inArray(
                priceValidities.priceId,
                rows.map((row) => row.id),
              ),
              eq(priceValidities.isCancelled, false),
              lte(priceValidities.validFrom, at),
              or(
                isNull(priceValidities.validUntil),
                gt(priceValidities.validUntil, at),
              ),
            ),
          );
        return rows.map((row) => ({
          target: (row.productId !== null
            ? { productId: row.productId, sku: null }
            : { productId: null, sku: row.sku! }) as PriceDefinition['target'],
          channelId: row.channelId,
          priceVersion: row.priceVersion,
          validities: snapshots.filter(
            (snapshot) => snapshot.priceId === row.id,
          ),
        }));
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  // El caller construye snapshot + Outbox/Inbox en el mismo tx; no publicar aquí.
  async transaction<T>(
    operation: (tx: PricingTransaction) => Promise<T>,
    config?: { isolationLevel: 'repeatable read'; accessMode: 'read only' },
  ): Promise<T> {
    let callbackFailure: { error: unknown } | undefined;
    try {
      return await this.database.db.transaction(async (tx) => {
        try {
          return await operation(tx);
        } catch (error) {
          callbackFailure = { error };
          throw error;
        }
      }, config);
    } catch (error) {
      rethrowPersistenceError(
        error,
        callbackFailure?.error === error && callbackFailure !== undefined,
      );
    }
  }

  async findDefinition(
    target:
      { productId: string; sku?: never } | { sku: string; productId?: never },
    channelId: string | null,
  ) {
    const [price] = await this.execute(() =>
      this.database.db
        .select()
        .from(prices)
        .where(
          and(
            target.productId !== undefined
              ? eq(prices.productId, target.productId)
              : eq(prices.sku, target.sku),
            channelId === null
              ? isNull(prices.channelId)
              : eq(prices.channelId, channelId),
          ),
        ),
    );
    return price;
  }

  findValidities(priceId: string) {
    return this.execute(() =>
      this.database.db
        .select()
        .from(priceValidities)
        .where(eq(priceValidities.priceId, priceId))
        .orderBy(asc(priceValidities.validFrom)),
    );
  }

  // Una fotografía consistente para que el resolver no mezcle dos commits.
  readProduct(productId: string) {
    return this.transaction(
      async (tx) => {
        const [definition] = await tx
          .select()
          .from(prices)
          .where(
            and(eq(prices.productId, productId), isNull(prices.channelId)),
          );
        if (!definition) return undefined;
        const validities = await tx
          .select()
          .from(priceValidities)
          .where(eq(priceValidities.priceId, definition.id))
          .orderBy(asc(priceValidities.validFrom));
        return { definition, validities };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  readSchedules(
    target: { productId: string } | { sku: string },
    pagina: number,
    tamanio: number,
  ) {
    return this.transaction(
      async (tx) => {
        const scope =
          'productId' in target
            ? and(
                eq(prices.productId, target.productId),
                isNull(prices.channelId),
              )
            : eq(prices.sku, target.sku);
        const [definition] = await tx
          .select({ id: prices.id })
          .from(prices)
          .where(scope)
          .limit(1);
        if (!definition) return undefined;
        const [total] = await tx
          .select({ value: count() })
          .from(scheduledPrices)
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .where(scope);
        const items = await tx
          .select({
            schedule: scheduledPrices,
            validity: priceValidities,
            definition: prices,
          })
          .from(scheduledPrices)
          .innerJoin(prices, eq(prices.id, scheduledPrices.priceId))
          .innerJoin(
            priceValidities,
            eq(priceValidities.id, scheduledPrices.validityId),
          )
          .where(scope)
          .orderBy(asc(priceValidities.validFrom), asc(scheduledPrices.id))
          .limit(tamanio)
          .offset((pagina - 1) * tamanio);
        return { total: total.value, items };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  readImport(batchId: string) {
    return this.transaction(
      async (tx) => {
        const [job] = await tx
          .select({
            id: bulkPriceJobs.id,
            status: bulkPriceJobs.status,
            allowPartial: bulkPriceJobs.allowPartial,
            totalRows: bulkPriceJobs.totalRows,
            completedRows: bulkPriceJobs.completedRows,
            failedRows: bulkPriceJobs.failedRows,
          })
          .from(bulkPriceJobs)
          .where(eq(bulkPriceJobs.id, batchId));
        if (!job) return undefined;
        const rows = await tx
          .select({
            rowId: bulkPriceRows.rowId,
            sku: bulkPriceRows.sku,
            status: bulkPriceRows.status,
            code: bulkPriceRows.code,
          })
          .from(bulkPriceRows)
          .where(eq(bulkPriceRows.batchId, batchId))
          .orderBy(asc(bulkPriceRows.rowId))
          .limit(MAX_INLINE_IMPORT_ROWS + 1);
        return {
          job,
          rows: rows.length > MAX_INLINE_IMPORT_ROWS ? undefined : rows,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async execute<T>(operation: () => PromiseLike<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      rethrowPersistenceError(error);
    }
  }
}
