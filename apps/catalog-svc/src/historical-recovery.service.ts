import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';
import { catalogError, object } from './catalog-mutation.input.js';
import { envelope, UUID, type CatalogEnvelope } from './catalog-messages.js';
import {
  historicalRequests,
  type HistoricalRecoveryAccepted,
} from './historical-recovery.schema.js';
import { CatalogPersistenceError } from './database-errors.js';

export const HISTORICAL_RECOVERY_CAPABILITIES = Symbol(
  'HISTORICAL_RECOVERY_CAPABILITIES',
);
export const HISTORICAL_PRICING_CONTRACT = Symbol(
  'HISTORICAL_PRICING_CONTRACT',
);
export const HISTORICAL_RECOVERY_CAPABILITY =
  'CATALOG_RECUPERAR_PREPARACION_HISTORICA';

export interface HistoricalRecoveryCapabilities {
  allows(
    subject: string,
    capability: typeof HISTORICAL_RECOVERY_CAPABILITY,
  ): boolean;
}
/** Internal adapter port only. No discriminator or historical monetary field is defined here. */
export interface HistoricalPricingContract {
  command(context: {
    productId: string;
    skuBase: string;
    operationId: string;
    correlationId: string;
    requestId: string;
  }): CatalogEnvelope;
}
export function readHistoricalRecoveryCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): HistoricalRecoveryCapabilities {
  const raw = env.CATALOG_HISTORICAL_RECOVERY_ALLOWED_SUBJECTS;
  const subjects = raw === undefined || raw === '' ? [] : raw.split(',');
  if (
    subjects.some((subject) => !UUID.test(subject)) ||
    new Set(subjects.map((s) => s.toLowerCase())).size !== subjects.length
  )
    throw new Error('Invalid Catalog historical capability configuration');
  const allowed = new Set(subjects.map((subject) => subject.toLowerCase()));
  return {
    allows: (subject, capability) =>
      capability === HISTORICAL_RECOVERY_CAPABILITY &&
      allowed.has(subject.toLowerCase()),
  };
}

export interface HistoricalSelection {
  solicitudId: string;
  dependencias: Array<'PRICING' | 'INVENTARIO'>;
  variantIds: string[];
}
/** Explicit candidate DTO: no inferred dependencies, unknown fields, prices, or locations. */
export function parseHistoricalSelection(body: unknown): HistoricalSelection {
  if (
    !object(body) ||
    Object.keys(body).some(
      (key) => !['solicitudId', 'dependencias', 'variantIds'].includes(key),
    ) ||
    typeof body.solicitudId !== 'string' ||
    !UUID.test(body.solicitudId) ||
    !Array.isArray(body.dependencias) ||
    !body.dependencias.length ||
    body.dependencias.some(
      (item) => item !== 'PRICING' && item !== 'INVENTARIO',
    ) ||
    new Set(body.dependencias).size !== body.dependencias.length ||
    (body.variantIds !== undefined &&
      (!Array.isArray(body.variantIds) ||
        body.variantIds.some(
          (item) => typeof item !== 'string' || !UUID.test(item),
        )))
  )
    catalogError(400, 'VALIDACION');
  const ids = (body.variantIds ?? []) as string[];
  const normalizedIds = ids.map((id) => id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length)
    catalogError(400, 'VALIDACION');
  const dependencies = [
    ...body.dependencias,
  ].sort() as HistoricalSelection['dependencias'];
  if (normalizedIds.length && !dependencies.includes('INVENTARIO'))
    catalogError(400, 'VALIDACION');
  return {
    solicitudId: body.solicitudId.toLowerCase(),
    dependencias: dependencies,
    variantIds: normalizedIds.sort(),
  };
}

@Injectable()
export class HistoricalRecoveryService {
  constructor(
    private readonly transactions: CatalogTransactionManager,
    private readonly repository: PostgresCatalogWriteRepository,
    @Inject(HISTORICAL_RECOVERY_CAPABILITIES)
    private readonly capabilities: HistoricalRecoveryCapabilities,
    @Optional()
    @Inject(HISTORICAL_PRICING_CONTRACT)
    private readonly pricing?: HistoricalPricingContract,
  ) {}

  async recover(
    productId: string,
    body: unknown,
    actor: { subject: string; correlationId: string },
  ): Promise<HistoricalRecoveryAccepted> {
    if (
      !this.capabilities.allows(actor.subject, HISTORICAL_RECOVERY_CAPABILITY)
    )
      throw new ForbiddenException({ code: 'SCOPE_INSUFICIENTE' });
    if (
      !UUID.test(productId) ||
      !UUID.test(actor.subject) ||
      !UUID.test(actor.correlationId)
    )
      catalogError(400, 'VALIDACION');
    const selection = parseHistoricalSelection(body);
    // Atomic selection: a request that includes Pricing admits nothing while its
    // shared representation is undefined. No amount is read, inferred, or fabricated.
    if (selection.dependencias.includes('PRICING') && !this.pricing)
      throw new ServiceUnavailableException({
        code: 'SERVICIO_NO_DISPONIBLE',
        details: { dependency: 'PRICING', reason: 'BLOCKED_CONTRACT' },
      });
    const product = productId.toLowerCase();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          productId: product,
          actor: actor.subject.toLowerCase(),
          dependencias: selection.dependencias,
          variantIds: selection.variantIds,
        }),
      )
      .digest('hex');
    return this.transactions
      .run(async (tx) => {
        // Fixed lock order: request identity, then aggregate. No network calls under locks.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${'catalog.historical:' + selection.solicitudId},0))`,
        );
        const [prior] = await tx
          .select()
          .from(historicalRequests)
          .where(eq(historicalRequests.request_id, selection.solicitudId));
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            catalogError(409, 'IDEMPOTENCY_CONFLICT');
          return prior.response_payload;
        }
        const row = await this.repository.lockProduct(tx, product);
        if (!row) catalogError(404, 'PRODUCTO_NO_ENCONTRADO');
        if (row.estado !== 'BORRADOR')
          catalogError(409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO');
        const aggregate = await this.repository.aggregate(tx, row);
        if (aggregate.tiene_variantes) {
          if (
            selection.dependencias.includes('INVENTARIO') &&
            !selection.variantIds.length
          )
            catalogError(400, 'VALIDACION');
          if (
            selection.variantIds.some(
              (id) => !aggregate.children.some((child) => child.id === id),
            )
          )
            catalogError(404, 'VARIANTE_NO_ENCONTRADA');
        } else if (selection.variantIds.length) catalogError(400, 'VALIDACION');

        const targets: Array<{
          dependencia: 'PRICING' | 'INVENTARIO';
          dependency: 'PRICING' | 'INVENTORY';
          sku: string;
          variantId: string | null;
        }> = [];
        if (selection.dependencias.includes('PRICING'))
          targets.push({
            dependencia: 'PRICING',
            dependency: 'PRICING',
            sku: aggregate.sku_base,
            variantId: null,
          });
        if (selection.dependencias.includes('INVENTARIO')) {
          if (!aggregate.tiene_variantes)
            targets.push({
              dependencia: 'INVENTARIO',
              dependency: 'INVENTORY',
              sku: aggregate.sku_base,
              variantId: null,
            });
          else
            for (const id of selection.variantIds) {
              const child = aggregate.children.find((item) => item.id === id)!;
              targets.push({
                dependencia: 'INVENTARIO',
                dependency: 'INVENTORY',
                sku: child.sku,
                variantId: child.id,
              });
            }
        }
        // All preconditions precede all writes. Existing PENDING/REJECTED/COMPLETED
        // are never reopened by this operation; only an exact receipt can replay.
        if (
          targets.some((target) =>
            aggregate.checks.some(
              (check) =>
                check.dependency === target.dependency &&
                check.sku === target.sku,
            ),
          )
        )
          catalogError(409, 'PREPARACION_NO_REINTENTABLE');
        const response: HistoricalRecoveryAccepted = {
          operation_id: selection.solicitudId,
          status: 'ACCEPTED',
          correlation_id: actor.correlationId,
          preparaciones: [],
        };
        for (const target of targets) {
          const operationId = randomUUID();
          const message =
            target.dependency === 'INVENTORY'
              ? envelope(
                  'inventory.sku.initialization.requested',
                  {
                    product_id: product,
                    variant_id: target.variantId,
                    sku: target.sku,
                  },
                  actor.correlationId,
                  operationId,
                  selection.solicitudId,
                )
              : this.pricing!.command({
                  productId: product,
                  skuBase: target.sku,
                  operationId,
                  correlationId: actor.correlationId,
                  requestId: selection.solicitudId,
                });
          // The unresolved Pricing adapter must not be used to smuggle a monetary
          // reconstruction or another operation through this admission boundary.
          if (
            message.operation_id !== operationId ||
            message.correlation_id !== actor.correlationId ||
            message.causation_id !== selection.solicitudId ||
            message.producer !== 'catalog-svc' ||
            message.kind !== 'command' ||
            (target.dependency === 'PRICING' &&
              (message.name !== 'pricing.product.initialization.requested' ||
                'precio_regular' in message.data ||
                message.data.product_id !== product ||
                message.data.sku_base !== target.sku))
          )
            throw new ServiceUnavailableException();
          await this.repository.insertActivationCheck(tx, {
            product_id: product,
            variant_id: target.variantId,
            sku: target.sku,
            dependency: target.dependency,
            operation_id: operationId,
            correlation_id: actor.correlationId,
            state: 'PENDING',
            request_payload: message.data,
          });
          await this.repository.insertOutboxMessage(tx, {
            message_id: message.message_id,
            schema_version: message.schema_version,
            event_name: message.name,
            kind: message.kind,
            operation_id: message.operation_id,
            correlation_id: message.correlation_id,
            causation_id: message.causation_id,
            occurred_at: new Date(message.occurred_at),
            payload: message.data,
          });
          response.preparaciones.push({
            dependencia: target.dependencia,
            sku: target.sku,
            variant_id: target.variantId,
            operation_id: operationId,
          });
        }
        await tx.insert(historicalRequests).values({
          request_id: selection.solicitudId,
          product_id: product,
          actor_subject: actor.subject.toLowerCase(),
          correlation_id: actor.correlationId,
          fingerprint,
          selection: {
            dependencias: selection.dependencias,
            variantIds: selection.variantIds,
          },
          response_payload: response,
        });
        return response;
      })
      .catch((error: unknown) => {
        if (error instanceof CatalogPersistenceError)
          throw new ServiceUnavailableException();
        throw error;
      });
  }
}
