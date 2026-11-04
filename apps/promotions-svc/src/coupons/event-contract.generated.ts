// Generated from G6 Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, AsyncAPI 0.6.0-rc.3.
// Source SHA-256: 10a61ce14468dbab3439270d0e008acb0695f7e256d4bd6e49d75e61e19dc5d0
import type { MessageContract } from './schema-validator.js';
export const promotionsBrokerBinding = {
  queue: 'po.promociones.q',
  prefetch: 20,
  bindings: [
    {
      exchange: 'po.comandos.x',
      routing_key: 'promotions.coupon.consumption.requested',
    },
    {
      exchange: 'po.comandos.x',
      routing_key: 'promotions.coupon.restoration.requested',
    },
    {
      exchange: 'po.eventos.x',
      routing_key: 'catalog.product.deactivated',
    },
    {
      exchange: 'po.eventos.x',
      routing_key: 'catalog.sku.deactivated',
    },
    {
      exchange: 'po.eventos.x',
      routing_key: 'inventory.stock.changed',
    },
    {
      exchange: 'po.eventos.x',
      routing_key: 'pricing.price.changed',
    },
  ],
} as const;
export const assignedEventContracts: Readonly<
  Record<string, MessageContract & { producer: string }>
> = {
  'catalog.product.deactivated': {
    producer: 'catalog-svc',
    exchange: 'po.eventos.x',
    routingKey: 'catalog.product.deactivated',
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            message_id: {
              type: 'string',
              minLength: 1,
            },
            schema_version: {
              type: 'integer',
              minimum: 1,
            },
            occurred_at: {
              type: 'string',
              format: 'date-time',
            },
            correlation_id: {
              type: 'string',
              minLength: 1,
            },
            causation_id: {
              type: ['string', 'null'],
            },
            operation_id: {
              type: ['string', 'null'],
              format: 'uuid',
            },
            producer: {
              type: 'string',
              minLength: 1,
            },
            kind: {
              type: 'string',
              enum: ['event', 'command', 'result'],
            },
            name: {
              type: 'string',
              minLength: 1,
            },
            data: {
              type: 'object',
            },
          },
          required: [
            'message_id',
            'schema_version',
            'occurred_at',
            'correlation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
        {
          type: 'object',
          properties: {
            producer: {
              type: 'string',
              const: 'catalog-svc',
            },
            kind: {
              type: 'string',
              const: 'event',
            },
            name: {
              type: 'string',
              const: 'catalog.product.deactivated',
            },
            data: {
              type: 'object',
              description:
                'Payload específico del mensaje. Para mensajes P1 críticos se especializa mediante schemas dedicados.',
              additionalProperties: true,
            },
          },
          required: ['producer', 'kind', 'name', 'data'],
        },
      ],
    },
  },
  'catalog.sku.deactivated': {
    producer: 'catalog-svc',
    exchange: 'po.eventos.x',
    routingKey: 'catalog.sku.deactivated',
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            message_id: {
              type: 'string',
              minLength: 1,
            },
            schema_version: {
              type: 'integer',
              minimum: 1,
            },
            occurred_at: {
              type: 'string',
              format: 'date-time',
            },
            correlation_id: {
              type: 'string',
              minLength: 1,
            },
            causation_id: {
              type: ['string', 'null'],
            },
            operation_id: {
              type: ['string', 'null'],
              format: 'uuid',
            },
            producer: {
              type: 'string',
              minLength: 1,
            },
            kind: {
              type: 'string',
              enum: ['event', 'command', 'result'],
            },
            name: {
              type: 'string',
              minLength: 1,
            },
            data: {
              type: 'object',
            },
          },
          required: [
            'message_id',
            'schema_version',
            'occurred_at',
            'correlation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
        {
          type: 'object',
          properties: {
            producer: {
              type: 'string',
              const: 'catalog-svc',
            },
            kind: {
              type: 'string',
              const: 'event',
            },
            name: {
              type: 'string',
              const: 'catalog.sku.deactivated',
            },
            data: {
              type: 'object',
              description:
                'Payload específico del mensaje. Para mensajes P1 críticos se especializa mediante schemas dedicados.',
              additionalProperties: true,
            },
          },
          required: ['producer', 'kind', 'name', 'data'],
        },
      ],
    },
  },
  'pricing.price.changed': {
    producer: 'pricing-svc',
    exchange: 'po.eventos.x',
    routingKey: 'pricing.price.changed',
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            message_id: {
              type: 'string',
              minLength: 1,
            },
            schema_version: {
              type: 'integer',
              minimum: 1,
            },
            occurred_at: {
              type: 'string',
              format: 'date-time',
            },
            correlation_id: {
              type: 'string',
              minLength: 1,
            },
            causation_id: {
              type: ['string', 'null'],
            },
            operation_id: {
              type: ['string', 'null'],
              format: 'uuid',
            },
            producer: {
              type: 'string',
              minLength: 1,
            },
            kind: {
              type: 'string',
              enum: ['event', 'command', 'result'],
            },
            name: {
              type: 'string',
              minLength: 1,
            },
            data: {
              type: 'object',
            },
          },
          required: [
            'message_id',
            'schema_version',
            'occurred_at',
            'correlation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
        {
          type: 'object',
          properties: {
            producer: {
              type: 'string',
              const: 'pricing-svc',
            },
            kind: {
              type: 'string',
              const: 'event',
            },
            name: {
              type: 'string',
              const: 'pricing.price.changed',
            },
            data: {
              type: 'object',
              description:
                'Payload específico del mensaje. Para mensajes P1 críticos se especializa mediante schemas dedicados.',
              additionalProperties: true,
            },
          },
          required: ['producer', 'kind', 'name', 'data'],
        },
      ],
    },
  },
  'inventory.stock.changed': {
    producer: 'inventory-svc',
    exchange: 'po.eventos.x',
    routingKey: 'inventory.stock.changed',
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            message_id: {
              type: 'string',
              minLength: 1,
            },
            schema_version: {
              type: 'integer',
              minimum: 1,
            },
            occurred_at: {
              type: 'string',
              format: 'date-time',
            },
            correlation_id: {
              type: 'string',
              minLength: 1,
            },
            causation_id: {
              type: ['string', 'null'],
            },
            operation_id: {
              type: ['string', 'null'],
              format: 'uuid',
            },
            producer: {
              type: 'string',
              minLength: 1,
            },
            kind: {
              type: 'string',
              enum: ['event', 'command', 'result'],
            },
            name: {
              type: 'string',
              minLength: 1,
            },
            data: {
              type: 'object',
            },
          },
          required: [
            'message_id',
            'schema_version',
            'occurred_at',
            'correlation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
        {
          type: 'object',
          properties: {
            producer: {
              type: 'string',
              const: 'inventory-svc',
            },
            kind: {
              type: 'string',
              const: 'event',
            },
            name: {
              type: 'string',
              const: 'inventory.stock.changed',
            },
            data: {
              type: 'object',
              description:
                'Payload específico del mensaje. Para mensajes P1 críticos se especializa mediante schemas dedicados.',
              additionalProperties: true,
            },
          },
          required: ['producer', 'kind', 'name', 'data'],
        },
      ],
    },
  },
};
