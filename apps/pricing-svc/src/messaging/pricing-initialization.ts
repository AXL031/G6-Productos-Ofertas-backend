import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { initializeProduct, PriceRuleError } from '../domain/price.js';
import { PricingRepository } from '../persistence/pricing.repository.js';
import {
  inbox,
  outbox,
  priceValidities,
  prices,
} from '../persistence/pricing.schema.js';
import { createPricingPriceChangedFacts } from './pricing-fact.js';

const HANDLER = 'pricing.product.initialization.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Envelope = {
  message_id: string;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  operation_id: string;
  producer: 'catalog-svc';
  kind: 'command';
  name: 'pricing.product.initialization.requested';
  data: Record<string, unknown>;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function parseEnvelope(value: unknown): Envelope {
  if (
    !object(value) ||
    !UUID.test(String(value.message_id)) ||
    value.schema_version !== 1 ||
    typeof value.occurred_at !== 'string' ||
    !Number.isFinite(Date.parse(value.occurred_at)) ||
    !UUID.test(String(value.correlation_id)) ||
    !(
      value.causation_id === undefined ||
      value.causation_id === null ||
      UUID.test(String(value.causation_id))
    ) ||
    !UUID.test(String(value.operation_id)) ||
    value.producer !== 'catalog-svc' ||
    value.kind !== 'command' ||
    value.name !== 'pricing.product.initialization.requested' ||
    !object(value.data)
  )
    throw new Error('PRICING_INVALID_MESSAGE_ENVELOPE');
  return value as unknown as Envelope;
}

function amountFromRawJson(raw: string, parsed: unknown): string {
  const matches = [
    ...raw.matchAll(
      /"precio_regular"\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g,
    ),
  ];
  if (
    matches.length !== 1 ||
    !object(parsed) ||
    !object(parsed.data) ||
    typeof parsed.data.precio_regular !== 'number' ||
    !Number.isFinite(parsed.data.precio_regular)
  )
    throw new PriceRuleError('PRECIO_INVALIDO');
  const token = matches[0][1];
  if (
    Number(token) !== parsed.data.precio_regular ||
    !/^\d{1,10}(?:\.\d{1,2})?$/.test(token)
  )
    throw new PriceRuleError('PRECIO_INVALIDO');
  const [whole, fraction = ''] = token.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function semanticInput(data: Record<string, unknown>, rawAmount?: string) {
  return {
    product_id: typeof data.product_id === 'string' ? data.product_id : '',
    sku_base: typeof data.sku_base === 'string' ? data.sku_base : '',
    precio_regular: rawAmount ?? null,
    moneda: typeof data.moneda === 'string' ? data.moneda : '',
    channel_id: data.channel_id ?? 'INVALID',
    motivo_cambio: data.motivo_cambio ?? 'INVALID',
  };
}

@Injectable()
export class PricingProductInitialization {
  constructor(private readonly repository: PricingRepository) {}

  async consume(raw: Buffer): Promise<'APPLIED' | 'DUPLICATE' | 'REJECTED'> {
    const rawText = raw.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      throw new Error('PRICING_INVALID_MESSAGE_JSON');
    }
    const message = parseEnvelope(parsed);
    const input = semanticInput(message.data);
    let amount: string | undefined;
    let domainCode: string | undefined;
    try {
      amount = amountFromRawJson(rawText, parsed);
    } catch (error) {
      domainCode =
        error instanceof PriceRuleError ? error.code : 'PRECIO_INVALIDO';
    }
    const normalized = semanticInput(message.data, amount);
    const validFields =
      typeof message.data.product_id === 'string' &&
      message.data.product_id.length > 0 &&
      typeof message.data.sku_base === 'string' &&
      message.data.sku_base.length > 0 &&
      typeof message.data.moneda === 'string' &&
      message.data.moneda.length === 3 &&
      message.data.channel_id === null &&
      message.data.motivo_cambio === 'ALTA_PRODUCTO';
    if (!validFields && !domainCode) domainCode = 'VALIDACION';

    return this.repository.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${message.operation_id}, 0))`,
      );
      const [sameMessage] = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.messageId, message.message_id),
            eq(inbox.handler, HANDLER),
          ),
        )
        .limit(1);
      if (sameMessage) {
        if (canonical(sameMessage.payload) !== canonical(parsed))
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        return sameMessage.result === 'APPLIED' ? 'APPLIED' : 'DUPLICATE';
      }

      const priorOperation = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, HANDLER),
            sql`${inbox.payload}->>'operation_id' = ${message.operation_id}`,
          ),
        )
        .limit(1);
      if (priorOperation.length) {
        const prior = priorOperation[0].payload;
        const priorData = object(prior) && object(prior.data) ? prior.data : {};
        const sameIntent =
          JSON.stringify(
            semanticInput(priorData, amountFromPrior(priorData) ?? undefined),
          ) === JSON.stringify(normalized);
        if (sameIntent) {
          await this.insertInbox(tx, message, parsed, 'DUPLICATE');
          const [priorResult] = await tx
            .select()
            .from(outbox)
            .where(
              and(
                eq(outbox.operationId, message.operation_id),
                eq(outbox.kind, 'result'),
                inArray(outbox.eventName, [
                  'pricing.product.initialization.completed',
                  'pricing.product.initialization.rejected',
                ]),
              ),
            )
            .orderBy(asc(outbox.occurredAt))
            .limit(1);
          if (!priorResult)
            throw new Error('PRICING_INITIALIZATION_RESULT_MISSING');
          const priorPayload = priorResult.payload;
          await this.insertResult(
            tx,
            message,
            normalized,
            priorResult.eventName.endsWith('.completed') ? 'READY' : 'REJECTED',
            typeof priorPayload.code === 'string' ? priorPayload.code : null,
            typeof priorPayload.price_version === 'number'
              ? priorPayload.price_version
              : null,
            typeof priorPayload.vigencia_id === 'string'
              ? priorPayload.vigencia_id
              : null,
          );
          return 'DUPLICATE';
        }
        await this.insertInbox(tx, message, parsed, 'REJECTED');
        await this.insertResult(
          tx,
          message,
          input,
          'REJECTED',
          'OPERATION_ID_CONFLICT',
        );
        return 'REJECTED';
      }

      if (domainCode) {
        await this.insertInbox(tx, message, parsed, 'REJECTED');
        await this.insertResult(tx, message, input, 'REJECTED', domainCode);
        return 'REJECTED';
      }

      const existing = await tx
        .select()
        .from(prices)
        .where(
          and(
            eq(prices.productId, message.data.product_id as string),
            sql`${prices.sku} IS NULL`,
            sql`${prices.channelId} IS NULL`,
          ),
        )
        .limit(1)
        .for('update');
      if (existing.length) {
        const initial = await tx
          .select()
          .from(priceValidities)
          .where(eq(priceValidities.priceId, existing[0].id))
          .orderBy(priceValidities.priceVersion)
          .limit(1);
        if (
          initial.length &&
          initial[0].motivoCambio === 'ALTA_PRODUCTO' &&
          initial[0].precioRegular === amount &&
          initial[0].currency.trim() === message.data.moneda
        ) {
          await this.insertInbox(tx, message, parsed, 'DUPLICATE');
          await this.insertResult(
            tx,
            message,
            input,
            'READY',
            null,
            1,
            initial[0].id,
          );
          return 'DUPLICATE';
        }
        await this.insertInbox(tx, message, parsed, 'REJECTED');
        await this.insertResult(
          tx,
          message,
          input,
          'REJECTED',
          'PRODUCT_ALREADY_INITIALIZED',
        );
        return 'REJECTED';
      }

      try {
        const initialized = initializeProduct(
          {
            productId: message.data.product_id as string,
            skuBase: message.data.sku_base as string,
            precioRegular: amount!,
            currency: message.data.moneda as string,
            channelId: null,
            motivoCambio: 'ALTA_PRODUCTO',
          },
          new Date(message.occurred_at),
        );
        const [definition] = await tx
          .insert(prices)
          .values({
            productId: message.data.product_id as string,
            sku: null,
            channelId: null,
          })
          .onConflictDoNothing()
          .returning();
        if (!definition) {
          await this.insertInbox(tx, message, parsed, 'REJECTED');
          await this.insertResult(
            tx,
            message,
            input,
            'REJECTED',
            'PRODUCT_ALREADY_INITIALIZED',
          );
          return 'REJECTED';
        }
        const [validity] = await tx
          .insert(priceValidities)
          .values({
            ...initialized.definition.validities[0],
            priceId: definition.id,
          })
          .returning();
        const facts = createPricingPriceChangedFacts(
          {
            target: initialized.definition.target,
            channelId: null,
            priceVersion: 0n,
            validities: [],
          },
          initialized.definition,
          {
            actor: null,
            correlationId: message.correlation_id,
            at: new Date(message.occurred_at),
            operation: 'actualizarPrecioBaseProducto',
            productId: message.data.product_id as string,
            operationId: message.operation_id,
          },
        );
        await tx.insert(outbox).values(
          facts.map((fact) => ({
            ...fact,
            messageId: deterministicUuid(
              `${message.operation_id}:price-changed:${fact.payload.price_type}`,
            ),
            causationId: message.message_id,
            eventName: 'pricing.price.changed',
            kind: 'event' as const,
            schemaVersion: 1,
            occurredAt: new Date(message.occurred_at),
          })),
        );
        await this.insertInbox(tx, message, parsed, 'APPLIED');
        await this.insertResult(
          tx,
          message,
          normalized,
          'READY',
          null,
          1,
          validity.id,
        );
        return 'APPLIED';
      } catch (error) {
        if (error instanceof PriceRuleError) {
          await this.insertInbox(tx, message, parsed, 'REJECTED');
          await this.insertResult(tx, message, input, 'REJECTED', error.code);
          return 'REJECTED';
        }
        throw error;
      }
    });
  }

  private insertInbox(
    tx: Parameters<PricingRepository['transaction']>[0] extends (
      tx: infer T,
    ) => Promise<unknown>
      ? T
      : never,
    message: Envelope,
    payload: unknown,
    result: string,
  ) {
    return tx.insert(inbox).values({
      messageId: message.message_id,
      handler: HANDLER,
      eventName: message.name,
      correlationId: message.correlation_id,
      payload: payload as Record<string, unknown>,
      result,
    });
  }

  private insertResult(
    tx: Parameters<PricingRepository['transaction']>[0] extends (
      tx: infer T,
    ) => Promise<unknown>
      ? T
      : never,
    message: Envelope,
    input: ReturnType<typeof semanticInput>,
    status: 'READY' | 'REJECTED',
    code: string | null,
    priceVersion: number | null = null,
    validityId: string | null = null,
  ) {
    const payload = {
      product_id: input.product_id,
      sku_base: input.sku_base,
      status,
      price_version: priceVersion,
      vigencia_id: validityId,
      code,
      completed_at: new Date().toISOString(),
    };
    return tx.insert(outbox).values({
      messageId: deterministicUuid(
        `${message.message_id}:initialization-result`,
      ),
      eventName: `pricing.product.initialization.${status === 'READY' ? 'completed' : 'rejected'}`,
      kind: 'result',
      schemaVersion: 1,
      correlationId: message.correlation_id,
      causationId: message.message_id,
      operationId: message.operation_id,
      occurredAt: new Date(),
      payload,
    });
  }
}

function amountFromPrior(data: Record<string, unknown>): string | null {
  if (
    typeof data.precio_regular !== 'number' ||
    !Number.isFinite(data.precio_regular)
  )
    return null;
  const value = String(data.precio_regular);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
