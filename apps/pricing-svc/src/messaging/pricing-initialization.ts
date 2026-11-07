import { selectHistoricalValidity } from '../domain/historical-price.js';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  ne,
  lte,
  gt,
  or,
  isNull,
  sql,
} from 'drizzle-orm';
import { initializeProduct, PriceRuleError } from '../domain/price.js';
import {
  PricingRepository,
  lockGlobalProduct,
} from '../persistence/pricing.repository.js';
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

function amountFromRawJson(token: string | undefined): string {
  if (token === undefined || !/^\d{1,10}(?:\.\d{1,2})?$/.test(token))
    throw new PriceRuleError('PRECIO_INVALIDO');
  const [whole, fraction = ''] = token.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function semanticInput(data: Record<string, unknown>, rawAmount?: string) {
  return {
    modalidad: data.modalidad === undefined ? 'ALTA_PRODUCTO' : data.modalidad,
    product_id: typeof data.product_id === 'string' ? data.product_id : '',
    sku_base: typeof data.sku_base === 'string' ? data.sku_base : '',
    precio_regular:
      rawAmount ??
      (Object.hasOwn(data, 'precio_regular')
        ? { invalid: data.precio_regular }
        : null),
    moneda: typeof data.moneda === 'string' ? data.moneda : '',
    channel_id: Object.hasOwn(data, 'channel_id')
      ? { present: true, value: data.channel_id }
      : { present: false },
    motivo_cambio: Object.hasOwn(data, 'motivo_cambio')
      ? { present: true, value: data.motivo_cambio }
      : { present: false },
  };
}

function semanticIntent(data: Record<string, unknown>, rawAmount?: string) {
  const field = (key: string) =>
    Object.hasOwn(data, key)
      ? { present: true, value: data[key] }
      : { present: false };
  return {
    ...semanticInput(data, rawAmount),
    product_id: field('product_id'),
    sku_base: field('sku_base'),
    moneda: field('moneda'),
  };
}

@Injectable()
export class PricingProductInitialization {
  constructor(private readonly repository: PricingRepository) {}

  async consume(raw: Buffer): Promise<'APPLIED' | 'DUPLICATE' | 'REJECTED'> {
    const rawText = raw.toString('utf8');
    let parsed: unknown;
    const sources = new WeakMap<object, string>();
    try {
      parsed = JSON.parse(
        rawText,
        function (key: string, value: unknown, context?: { source?: string }) {
          if (
            key === 'precio_regular' &&
            typeof value === 'number' &&
            context?.source
          )
            sources.set(this as object, context.source);
          return value;
        },
      ) as unknown;
    } catch {
      throw new Error('PRICING_INVALID_MESSAGE_JSON');
    }
    const message = parseEnvelope(parsed);
    const operationId = message.operation_id.toLowerCase();
    const input = semanticInput(message.data);
    const token = sources.get(message.data);
    if (typeof message.data.precio_regular === 'number' && token === undefined)
      throw new Error('PRICING_JSON_SOURCE_UNAVAILABLE');
    let amount: string | undefined;
    let domainCode: string | undefined;
    try {
      if (
        message.data.modalidad !== 'RECUPERACION_HISTORICA' ||
        Object.hasOwn(message.data, 'precio_regular')
      )
        amount = amountFromRawJson(token);
    } catch (error) {
      domainCode =
        error instanceof PriceRuleError ? error.code : 'PRECIO_INVALIDO';
    }
    const normalized = semanticInput(message.data, amount);
    const intent = semanticIntent(message.data, amount);
    if (token !== undefined && amount === undefined)
      intent.precio_regular = { invalid: { numericSource: token } };
    const savedPayload = {
      ...message,
      _pricing_initialization: {
        version: 1,
        intent,
        token: token ?? null,
        ...(object(parsed) && Object.hasOwn(parsed, '_pricing_initialization')
          ? { original: parsed._pricing_initialization }
          : {}),
      },
    };
    const historical = message.data.modalidad === 'RECUPERACION_HISTORICA';
    const validFields =
      (message.data.modalidad === undefined ||
        message.data.modalidad === 'ALTA_PRODUCTO' ||
        historical) &&
      typeof message.data.product_id === 'string' &&
      message.data.product_id.length > 0 &&
      typeof message.data.sku_base === 'string' &&
      message.data.sku_base.length > 0 &&
      typeof message.data.moneda === 'string' &&
      message.data.moneda.length === 3 &&
      message.data.channel_id === null &&
      message.data.motivo_cambio === 'ALTA_PRODUCTO';
    if (!validFields && !domainCode) domainCode = 'VALIDACION';
    if (historical && domainCode) domainCode = 'HISTORICAL_PRICE_CONFLICT';

    return this.repository.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationId}, 0))`,
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
        const previous = sameMessage.payload;
        const metadata = object(previous._pricing_initialization)
          ? previous._pricing_initialization
          : undefined;
        const { _pricing_initialization: _internal, ...withoutInternal } =
          previous;
        const originalPrevious =
          metadata?.version === 1
            ? {
                ...withoutInternal,
                ...(Object.hasOwn(metadata, 'original')
                  ? { _pricing_initialization: metadata.original }
                  : {}),
              }
            : previous;
        const normalizedPrevious = object(previous)
          ? {
              ...originalPrevious,
              operation_id:
                typeof previous.operation_id === 'string'
                  ? previous.operation_id.toLowerCase()
                  : previous.operation_id,
            }
          : previous;
        if (
          canonical(normalizedPrevious) !==
            canonical({ ...message, operation_id: operationId }) ||
          (metadata?.version === 1 && metadata.token !== (token ?? null))
        )
          throw new Error('PRICING_MESSAGE_ID_CONFLICT');
        return sameMessage.result === 'APPLIED' ? 'APPLIED' : 'DUPLICATE';
      }

      const priorOperation = await tx
        .select()
        .from(inbox)
        .where(
          and(
            eq(inbox.handler, HANDLER),
            ne(inbox.result, 'OPERATION_ID_CONFLICT'),
            ne(inbox.result, 'REJECTED_INVALID_ENVELOPE'),
            sql`lower(${inbox.payload}->>'operation_id') = ${operationId}`,
          ),
        )
        .orderBy(asc(inbox.createdAt), asc(inbox.id))
        .limit(1);
      if (priorOperation.length) {
        const prior = priorOperation[0].payload;
        const priorData = object(prior) && object(prior.data) ? prior.data : {};
        const metadata = object(prior._pricing_initialization)
          ? prior._pricing_initialization
          : undefined;
        const priorIntent =
          metadata?.version === 1 && object(metadata.intent)
            ? metadata.intent
            : semanticIntent(
                priorData,
                amountFromPrior(priorData) ?? undefined,
              );
        const sameIntent = canonical(priorIntent) === canonical(intent);
        if (sameIntent) {
          const [priorResult] = await tx
            .select()
            .from(outbox)
            .where(
              and(
                eq(outbox.operationId, message.operation_id),
                eq(outbox.causationId, priorOperation[0].messageId),
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
          const decisionAt =
            historical && typeof priorPayload.completed_at === 'string'
              ? priorPayload.completed_at
              : undefined;
          await this.insertInbox(
            tx,
            message,
            savedPayload,
            'DUPLICATE',
            decisionAt,
          );
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
            decisionAt,
          );
          return 'DUPLICATE';
        }
        await this.insertInbox(
          tx,
          message,
          savedPayload,
          'OPERATION_ID_CONFLICT',
        );
        await this.insertResult(
          tx,
          message,
          input,
          'REJECTED',
          'OPERATION_ID_CONFLICT',
        );
        return 'REJECTED';
      }

      await lockGlobalProduct(tx, normalized.product_id);
      if (historical) {
        return this.adoptHistorical(
          tx,
          message,
          savedPayload,
          normalized,
          amount,
          domainCode !== undefined,
        );
      }

      if (domainCode) {
        await this.insertInbox(tx, message, savedPayload, 'REJECTED');
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
          await this.insertInbox(tx, message, savedPayload, 'DUPLICATE');
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
        await this.insertInbox(tx, message, savedPayload, 'REJECTED');
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
          await this.insertInbox(tx, message, savedPayload, 'REJECTED');
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
        await this.insertInbox(tx, message, savedPayload, 'APPLIED');
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
          await this.insertInbox(tx, message, savedPayload, 'REJECTED');
          await this.insertResult(tx, message, input, 'REJECTED', error.code);
          return 'REJECTED';
        }
        throw error;
      }
    });
  }

  private async adoptHistorical(
    tx: Parameters<PricingRepository['transaction']>[0] extends (
      tx: infer T,
    ) => Promise<unknown>
      ? T
      : never,
    message: Envelope,
    parsed: unknown,
    input: ReturnType<typeof semanticInput>,
    expectedAmount: string | undefined,
    invalid: boolean,
  ): Promise<'APPLIED' | 'REJECTED'> {
    // Mismo lock de definición que las mutaciones; la operación ya está serializada.
    const definitions = await tx
      .select()
      .from(prices)
      .where(
        and(
          eq(prices.productId, input.product_id),
          sql`${prices.sku} IS NULL`,
          sql`${prices.channelId} IS NULL`,
        ),
      )
      .for('update');
    // Después de adquirir locks: ni occurred_at del emisor ni transaction_timestamp.
    const clock = await tx.execute<{ cutoff: string }>(
      sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`,
    );
    const cutoff = clock.rows[0].cutoff;
    const validities =
      definitions.length === 1
        ? await tx
            .select()
            .from(priceValidities)
            .where(
              and(
                eq(priceValidities.priceId, definitions[0].id),
                eq(priceValidities.isCancelled, false),
                lte(priceValidities.validFrom, sql`${cutoff}::timestamptz`),
                or(
                  isNull(priceValidities.validUntil),
                  gt(priceValidities.validUntil, sql`${cutoff}::timestamptz`),
                ),
              ),
            )
            .for('share')
        : [];
    const chosen = invalid
      ? undefined
      : selectHistoricalValidity(validities, input.moneda, expectedAmount);
    const compatible = chosen !== undefined;
    const status = compatible ? 'READY' : 'REJECTED';
    await this.insertInbox(
      tx,
      message,
      parsed,
      compatible ? 'APPLIED' : 'REJECTED',
      cutoff,
    );
    await this.insertResult(
      tx,
      message,
      input,
      status,
      compatible ? null : 'HISTORICAL_PRICE_CONFLICT',
      compatible ? Number(chosen!.priceVersion) : null,
      compatible ? chosen!.id : null,
      cutoff,
    );
    return compatible ? 'APPLIED' : 'REJECTED';
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
    processedAt?: Date | string,
  ) {
    return tx.insert(inbox).values({
      messageId: message.message_id,
      handler: HANDLER,
      eventName: message.name,
      correlationId: message.correlation_id,
      payload: payload as Record<string, unknown>,
      result,
      ...(processedAt
        ? {
            processedAt:
              typeof processedAt === 'string'
                ? sql`${processedAt}::timestamptz`
                : processedAt,
          }
        : {}),
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
    at: Date | string = new Date(),
  ) {
    const payload = {
      product_id: input.product_id,
      sku_base: input.sku_base,
      status,
      price_version: priceVersion,
      vigencia_id: validityId,
      code,
      completed_at: typeof at === 'string' ? at : at.toISOString(),
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
      occurredAt: typeof at === 'string' ? sql`${at}::timestamptz` : at,
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
