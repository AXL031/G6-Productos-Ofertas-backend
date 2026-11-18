import type {
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from '@azure/service-bus';
import type { CatalogSkuDeactivated } from './catalog-sku-deactivated.js';
import type { PricingProductInitialization } from './pricing-initialization.js';

const command = 'pricing.product.initialization.requested';
const deactivation = 'catalog.sku.deactivated';

type Settlement = Pick<
  ServiceBusReceiver,
  'completeMessage' | 'deadLetterMessage' | 'abandonMessage'
>;

export class PricingCatalogServiceBusHandler {
  constructor(
    private readonly initialization: Pick<
      PricingProductInitialization,
      'consume'
    >,
    private readonly skuDeactivated: Pick<CatalogSkuDeactivated, 'consume'>,
    private readonly receiver: Settlement,
  ) {}

  async handle(message: ServiceBusReceivedMessage): Promise<void> {
    const invalid = () =>
      this.receiver.deadLetterMessage(message, {
        deadLetterReason: 'INVALID_PRICING_CATALOG_MESSAGE',
        deadLetterErrorDescription: 'Contract or queue validation failed',
      });
    let raw: Buffer;
    try {
      if (
        !(message.body instanceof Uint8Array) ||
        message.body.byteLength > 256 * 1024 ||
        message.contentType !== 'application/json' ||
        (message.subject !== command && message.subject !== deactivation)
      )
        throw new Error('INVALID_PRICING_CATALOG_MESSAGE');
      raw = Buffer.from(message.body);
      const data: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(raw),
      );
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('INVALID_PRICING_CATALOG_MESSAGE');
      const body = data as Record<string, unknown>;
      const props = message.applicationProperties ?? {};
      if (
        message.messageId !== body.message_id ||
        message.correlationId !== body.correlation_id ||
        message.subject !== body.name ||
        body.producer !== 'catalog-svc' ||
        (Object.hasOwn(props, 'producer') &&
          props.producer !== body.producer) ||
        (Object.hasOwn(props, 'schema_version') &&
          props.schema_version !== body.schema_version) ||
        (Object.hasOwn(props, 'route_version') && props.route_version !== 1)
      )
        throw new Error('INVALID_PRICING_CATALOG_MESSAGE');
    } catch {
      await invalid();
      return;
    }
    try {
      if (message.subject === command) await this.initialization.consume(raw);
      else await this.skuDeactivated.consume(raw);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'PRICING_INVALID_MESSAGE_ENVELOPE',
          'PRICING_MESSAGE_ID_CONFLICT',
        ].includes(error.message)
      )
        await invalid();
      else await this.receiver.abandonMessage(message);
      return;
    }
    await this.receiver.completeMessage(message);
  }
}
