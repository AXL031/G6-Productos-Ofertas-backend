import {
  HttpException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { translatePostgresFailure } from './database-errors.js';
import { Database, type CatalogTransaction } from './database.js';
import { inbox, outbox, products, variants } from './catalog.schema.js';
import { CatalogMutationService } from './catalog-mutation.service.js';
import {
  catalogError,
  object,
  parseMutation,
} from './catalog-mutation.input.js';
import {
  envelope,
  InvalidCatalogMessage,
  UUID,
  type CatalogEnvelope,
} from './catalog-messages.js';
import { CatalogPricingIdentityProvider } from './catalog-pricing-identity.js';
import { CatalogConfig } from './config.js';
import { CatalogTokenVerifier } from './catalog-auth.js';

/** Existing G7 flow, with only the scope already published for Taxonomy reads. */
@Injectable()
export class CatalogBulkIdentity extends CatalogPricingIdentityProvider {
  constructor(
    @Optional() @Inject(CatalogConfig) config: CatalogConfig | undefined,
    verifier: CatalogTokenVerifier,
  ) {
    super(config, verifier);
  }
  protected override get scope(): string {
    return 'catalogo:leer';
  }
}
export interface BulkRow {
  row_number: number;
  row_operation_id: string;
  producto_id: string | null;
  sku_base: string;
  product: Record<string, unknown>;
  variant_id?: string | null;
  sku_variante?: string | null;
  variant: Record<string, unknown> | null;
}
export interface BulkRequest {
  batch_id: string;
  batch_operation_id: string;
  template_version: 2;
  mode: 'ALTA' | 'ACTUALIZACION';
  rows: BulkRow[];
}
export interface BulkRowResult extends Record<string, unknown> {
  row_number: number;
  row_operation_id: string;
  product_id: string | null;
  sku_base: string;
  status: 'COMPLETED' | 'REJECTED';
  code: string | null;
}
export function canonicalBulk(value: unknown): string {
  if (Array.isArray(value))
    return '[' + value.map(canonicalBulk).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalBulk(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((k) => Object.hasOwn(value, k))
  );
}
export function parseBulkRequest(message: CatalogEnvelope): BulkRequest {
  const d = message.data;
  if (
    ![1, 2].includes(message.schema_version) ||
    !keys(d, [
      'batch_id',
      'batch_operation_id',
      'template_version',
      'mode',
      'rows',
    ]) ||
    !UUID.test(String(d.batch_id)) ||
    !UUID.test(String(d.batch_operation_id)) ||
    message.operation_id !== d.batch_operation_id ||
    d.template_version !== 2 ||
    !['ALTA', 'ACTUALIZACION'].includes(String(d.mode)) ||
    !Array.isArray(d.rows) ||
    !d.rows.length ||
    d.rows.length > 5000 ||
    Buffer.byteLength(JSON.stringify(message), 'utf8') > 1048576
  )
    catalogError(400, 'VALIDACION');
  const operations = new Set<string>(),
    numbers = new Set<number>(),
    finishedFamilies = new Set<string>();
  let family: string | undefined;
  for (const row of d.rows as unknown[]) {
    if (
      !object(row) ||
      !keys(row, [
        'row_number',
        'row_operation_id',
        'producto_id',
        'sku_base',
        'product',
        ...(message.schema_version === 1 || Object.hasOwn(row, 'variant_id')
          ? ['variant_id']
          : []),
        ...(message.schema_version === 2 && Object.hasOwn(row, 'sku_variante')
          ? ['sku_variante']
          : []),
        'variant',
      ]) ||
      (message.schema_version === 2 &&
        ['variant_id', 'sku_variante'].some(
          (key) =>
            Object.hasOwn(row, key) &&
            row[key] !== null &&
            (typeof row[key] !== 'string' || row[key].length === 0),
        )) ||
      !Number.isSafeInteger(row.row_number) ||
      Number(row.row_number) < 2 ||
      typeof row.row_operation_id !== 'string' ||
      !UUID.test(row.row_operation_id) ||
      typeof row.sku_base !== 'string' ||
      !row.sku_base ||
      !object(row.product) ||
      !(row.variant === null || object(row.variant)) ||
      (d.mode === 'ALTA'
        ? row.producto_id !== null ||
          (message.schema_version === 1
            ? row.variant_id !== null
            : row.variant_id != null || row.sku_variante != null)
        : typeof row.producto_id !== 'string' ||
          !row.producto_id ||
          (row.variant === null
            ? message.schema_version === 1
              ? row.variant_id !== null
              : row.variant_id != null || row.sku_variante != null
            : message.schema_version === 1
              ? typeof row.variant_id !== 'string' || !row.variant_id
              : typeof row.variant_id !== 'string' &&
                typeof row.sku_variante !== 'string'))
    )
      catalogError(400, 'VALIDACION');
    const r = row as unknown as BulkRow;
    if (
      operations.has(r.row_operation_id.toLowerCase()) ||
      numbers.has(r.row_number)
    )
      catalogError(400, 'VALIDACION');
    operations.add(r.row_operation_id.toLowerCase());
    numbers.add(r.row_number);
    if (r.sku_base !== family) {
      if (family !== undefined) finishedFamilies.add(family);
      if (finishedFamilies.has(r.sku_base)) catalogError(400, 'VALIDACION');
      family = r.sku_base;
    }
  }
  return d as unknown as BulkRequest;
}
function rejection(row: BulkRow, code: string): BulkRowResult {
  return {
    row_number: row.row_number,
    row_operation_id: row.row_operation_id,
    product_id: row.producto_id,
    sku_base: row.sku_base,
    status: 'REJECTED',
    code,
  };
}
export function businessCode(error: unknown): string | undefined {
  const failure = translatePostgresFailure(error);
  if (
    failure?.failure === 'unique' ||
    (failure?.failure === 'deferred_constraint' && failure.sqlState === '23505')
  ) {
    switch (failure.constraintName) {
      case 'uq_sku_identity_sku':
      case 'uq_products_sku_base':
      case 'uq_variants_sku':
        return 'SKU_DUPLICADO';
      case 'uq_variants_product_combination':
        return 'COMBINACION_DUPLICADA';
      case 'uq_products_slug':
        return 'SLUG_DUPLICADO';
      default:
        // An unknown UNIQUE may protect transport/persistence, not user input.
        // Preserve the technical failure and roll back the chunk before ACK.
        return;
    }
  }
  if (
    failure &&
    ['check', 'foreign_key', 'not_null', 'deferred_constraint'].includes(
      failure.failure,
    )
  )
    return 'VALIDACION';
  if (!(error instanceof HttpException) || error.getStatus() >= 500) return;
  const response = error.getResponse();
  return object(response) && typeof response.code === 'string'
    ? response.code
    : 'VALIDACION';
}
const COMMAND = 'catalog.bulk.command.v1',
  ROW = 'catalog.bulk.row.v1',
  DELIVERY = 'catalog.bulk.delivery.v1';

@Injectable()
export class CatalogBulkService {
  constructor(
    private readonly database: Database,
    private readonly mutations: CatalogMutationService,
    private readonly identity: CatalogBulkIdentity,
  ) {}
  private async lock(tx: CatalogTransaction, key: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
  private async previous(tx: CatalogTransaction, id: string, handler: string) {
    return (
      await tx
        .select()
        .from(inbox)
        .where(and(eq(inbox.message_id, id), eq(inbox.handler, handler)))
        .limit(1)
    )[0];
  }
  private async remember(
    tx: CatalogTransaction,
    id: string,
    handler: string,
    message: CatalogEnvelope,
    payload: Record<string, unknown>,
  ) {
    await tx.insert(inbox).values({
      message_id: id,
      handler,
      event_name: message.name,
      correlation_id: message.correlation_id,
      operation_id: message.operation_id,
      payload,
      result: 'APPLIED',
    });
  }
  private semantic(request: BulkRequest, row: BulkRow) {
    return { batch_id: request.batch_id, mode: request.mode, row };
  }
  private async family(
    tx: CatalogTransaction,
    request: BulkRequest,
    rows: BulkRow[],
    authorization: string,
    correlationId: string,
  ): Promise<BulkRowResult[]> {
    const first = rows[0];
    if (
      rows.some(
        (r) =>
          canonicalBulk(r.product) !== canonicalBulk(first.product) ||
          r.producto_id !== first.producto_id,
      )
    )
      catalogError(400, 'VALIDACION');
    for (const row of rows) {
      parseMutation(
        row.product,
        request.mode === 'ALTA' ? 'createProduct' : 'updateProduct',
      );
      if (
        request.mode === 'ACTUALIZACION' &&
        row.variant &&
        !Number.isSafeInteger(row.variant.catalogVersion)
      )
        catalogError(400, 'VALIDACION');
      if (row.variant)
        parseMutation(
          row.variant,
          request.mode === 'ALTA' ? 'createVariant' : 'updateVariant',
        );
    }
    const actor = { authorization, correlationId };
    const targets = new Map<BulkRow, string>();
    let id: string;
    if (request.mode === 'ALTA') {
      if (
        first.product.skuBase !== first.sku_base ||
        typeof first.product.tieneVariantes !== 'boolean' ||
        (first.product.tieneVariantes
          ? rows.some((r) => r.variant === null)
          : rows.length !== 1 || first.variant !== null)
      )
        catalogError(400, 'VALIDACION');
      const created = await this.mutations.createProduct(
        first.product,
        actor,
        tx,
      );
      id = created.product_id;
      for (const row of rows)
        if (row.variant)
          await this.mutations.createVariant(id, row.variant, actor, tx, true);
    } else {
      id = first.producto_id!;
      const parent = (
        await tx
          .select()
          .from(products)
          .where(sql`${products.id}::text = ${id}`)
          .for('update')
      )[0];
      if (!parent) catalogError(404, 'PRODUCTO_NO_ENCONTRADO');
      if (
        parent.sku_base !== first.sku_base ||
        (parent.tiene_variantes
          ? rows.some((r) => r.variant === null)
          : rows.length !== 1 || first.variant !== null) ||
        (first.product.tipoProductoId !== undefined &&
          first.product.tipoProductoId !== parent.tipo_producto_id)
      )
        catalogError(400, 'VALIDACION');
      // Parent intent/version is shared by the family and is applied exactly once.
      if (!Number.isSafeInteger(first.product.catalogVersion))
        catalogError(400, 'VALIDACION');
      for (const row of rows)
        if (row.variant) {
          const child = (
            await tx
              .select()
              .from(variants)
              .where(
                and(
                  typeof row.sku_variante === 'string'
                    ? eq(variants.sku, row.sku_variante)
                    : sql`${variants.id}::text = ${row.variant_id}`,
                  eq(variants.product_id, id),
                ),
              )
              .for('update')
          )[0];
          if (!child) catalogError(404, 'VARIANTE_NO_ENCONTRADA');
          if (row.variant_id != null && row.variant_id !== child.id)
            catalogError(400, 'VALIDACION');
          // Keep the original row untouched for existing Inbox/operation receipts.
          targets.set(row, child.id);
        }
      if (
        new Set(targets.values()).size !== rows.filter((r) => r.variant).length
      )
        catalogError(400, 'VALIDACION');
      await this.mutations.update(id, undefined, first.product, actor, tx);
      for (const row of rows)
        if (row.variant)
          await this.mutations.update(
            id,
            targets.get(row)!,
            row.variant,
            actor,
            tx,
            true,
          );
    }
    return rows.map((r) => ({
      row_number: r.row_number,
      row_operation_id: r.row_operation_id,
      product_id: id,
      sku_base: r.sku_base,
      status: 'COMPLETED',
      code: null,
    }));
  }
  async consume(message: CatalogEnvelope): Promise<'APPLIED' | 'DUPLICATE'> {
    // These IDs are required to issue a causal contractual rejection at all.
    if (
      !UUID.test(String(message.data.batch_id)) ||
      !UUID.test(String(message.data.batch_operation_id)) ||
      !UUID.test(String(message.operation_id))
    )
      throw new InvalidCatalogMessage();
    return this.database.transaction(async (tx) => {
      await this.lock(tx, 'bulk-delivery:' + message.message_id.toLowerCase());
      await this.lock(
        tx,
        'bulk-command:' + String(message.data.batch_operation_id).toLowerCase(),
      );
      const delivered = await this.previous(tx, message.message_id, DELIVERY);
      if (delivered) {
        if (canonicalBulk(delivered.payload) !== canonicalBulk(message))
          throw new InvalidCatalogMessage();
        return 'DUPLICATE';
      }
      const old = await this.previous(
        tx,
        String(message.data.batch_operation_id),
        COMMAND,
      );
      let result: Record<string, unknown>, name: string;
      if (
        old &&
        canonicalBulk(old.payload.input) !== canonicalBulk(message.data)
      ) {
        name = 'catalog.bulk.upsert.rejected';
        result = {
          batch_id: message.data.batch_id,
          batch_operation_id: message.data.batch_operation_id,
          code: 'IDEMPOTENCY_CONFLICT',
          detail: 'La identidad del comando ya corresponde a otra intención.',
        };
      } else if (old) {
        name = String(old.payload.name);
        result = old.payload.result as Record<string, unknown>;
      } else {
        let request: BulkRequest | undefined;
        try {
          request = parseBulkRequest(message);
        } catch (error) {
          if (!businessCode(error)) throw error;
        }
        if (!request) {
          name = 'catalog.bulk.upsert.rejected';
          result = {
            batch_id: message.data.batch_id,
            batch_operation_id: message.data.batch_operation_id,
            code: 'VALIDACION',
            detail: 'El comando no cumple el contrato de entrada.',
          };
        } else {
          for (const id of request.rows.map((r) => r.row_operation_id).sort())
            await this.lock(tx, 'bulk-row:' + id.toLowerCase());
          for (const sku of [
            ...new Set(request.rows.map((r) => r.sku_base)),
          ].sort())
            await this.lock(tx, 'bulk-family:' + sku);
          const results: BulkRowResult[] = [];
          const groups = new Map<string, BulkRow[]>();
          for (const row of request.rows)
            groups.set(row.sku_base, [
              ...(groups.get(row.sku_base) ?? []),
              row,
            ]);
          let authorization: string | undefined;
          for (const rows of groups.values()) {
            const previous = await Promise.all(
              rows.map((r) => this.previous(tx, r.row_operation_id, ROW)),
            );
            const conflict = previous.some(
              (p, i) =>
                p &&
                canonicalBulk(p.payload.input) !==
                  canonicalBulk(this.semantic(request, rows[i])),
            );
            let applied: BulkRowResult[];
            if (
              conflict ||
              (previous.some(Boolean) && !previous.every(Boolean))
            )
              applied = rows.map((r, i) =>
                previous[i] &&
                canonicalBulk(previous[i]!.payload.input) ===
                  canonicalBulk(this.semantic(request, r))
                  ? (previous[i]!.payload.result as BulkRowResult)
                  : rejection(r, 'IDEMPOTENCY_CONFLICT'),
              );
            else if (previous.every(Boolean))
              applied = previous.map((p) => p!.payload.result as BulkRowResult);
            else {
              if (authorization === undefined)
                authorization = await this.identity.authorization(
                  AbortSignal.timeout(5000),
                );
              if (!/^Bearer [^\s]+$/i.test(authorization))
                throw new ServiceUnavailableException();
              try {
                applied = await tx.transaction(async (familyTx) => {
                  // No human identity is created: only a verified G6 service token goes to Taxonomy.
                  const results = await this.family(
                    familyTx,
                    request!,
                    rows,
                    authorization!,
                    message.correlation_id,
                  );
                  await familyTx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
                  await familyTx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
                  return results;
                });
              } catch (error) {
                const code = businessCode(error);
                if (!code) throw error;
                applied = rows.map((r) => rejection(r, code));
              }
            }
            for (let i = 0; i < rows.length; i++)
              if (!previous[i])
                await this.remember(
                  tx,
                  rows[i].row_operation_id,
                  ROW,
                  message,
                  {
                    input: this.semantic(request, rows[i]),
                    result: applied[i],
                  },
                );
            results.push(...applied);
          }
          name = 'catalog.bulk.upsert.completed';
          result = {
            batch_id: request.batch_id,
            batch_operation_id: request.batch_operation_id,
            results,
          };
        }
        await this.remember(
          tx,
          String(message.data.batch_operation_id),
          COMMAND,
          message,
          { input: message.data, name, result },
        );
      }
      const reply = envelope(
        name,
        result,
        message.correlation_id,
        String(message.data.batch_operation_id),
        message.message_id,
      );
      await tx.insert(outbox).values({
        message_id: reply.message_id,
        event_name: reply.name,
        kind: reply.kind,
        schema_version: reply.schema_version,
        correlation_id: reply.correlation_id,
        operation_id: reply.operation_id,
        causation_id: reply.causation_id,
        occurred_at: new Date(reply.occurred_at),
        payload: reply.data,
      });
      await this.remember(tx, message.message_id, DELIVERY, message, message);
      return 'APPLIED';
    });
  }
}
