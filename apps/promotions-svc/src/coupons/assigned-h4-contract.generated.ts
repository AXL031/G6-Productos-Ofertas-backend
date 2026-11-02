// Generated from Docs 5124eeae4ec65b22ea9146cd7b1ce3888c617c10, AsyncAPI rc.4.
// SHA-256: 94f11994d8f53cea470d6f9801a3e8720ebdd8f36e2d4a3d18d21beb875bf5f3
// JSON Schema uses a non-callable then keyword.
/* oxlint-disable unicorn/no-thenable */
import type { MessageContract } from './schema-validator.js';
export const assignedH4Contracts: Readonly<
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
            schema_version: {
              type: 'integer',
              const: 1,
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
              properties: {
                product_id: {
                  type: 'string',
                  minLength: 1,
                },
                product_version: {
                  type: 'integer',
                  minimum: 1,
                },
                changed_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: ['product_id', 'product_version', 'changed_at'],
              additionalProperties: false,
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
            schema_version: {
              type: 'integer',
              const: 1,
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
              properties: {
                sku: {
                  type: 'string',
                  minLength: 1,
                },
                product_id: {
                  type: 'string',
                  minLength: 1,
                },
                sku_version: {
                  type: 'integer',
                  minimum: 1,
                },
                changed_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: ['sku', 'product_id', 'sku_version', 'changed_at'],
              additionalProperties: false,
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
            schema_version: {
              type: 'integer',
              const: 1,
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
              properties: {
                target_type: {
                  type: 'string',
                  enum: ['PRODUCTO', 'SKU'],
                },
                product_id: {
                  type: 'string',
                  minLength: 1,
                },
                sku: {
                  type: ['string', 'null'],
                },
                channel_id: {
                  oneOf: [
                    {
                      type: 'string',
                      enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
                    },
                    {
                      type: 'null',
                    },
                  ],
                },
                currency: {
                  type: 'string',
                  minLength: 3,
                  maxLength: 3,
                },
                price_type: {
                  type: 'string',
                  enum: ['REGULAR', 'OFERTA'],
                },
                previous_price: {
                  type: ['string', 'null'],
                  pattern:
                    '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.(?:0*[1-9][0-9]*))$',
                },
                new_price: {
                  type: ['string', 'null'],
                  pattern:
                    '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.(?:0*[1-9][0-9]*))$',
                },
                operation: {
                  type: 'string',
                  enum: ['CREACION', 'MODIFICACION', 'RETIRO_OFERTA'],
                },
                reason: {
                  type: 'string',
                  minLength: 1,
                },
                price_version: {
                  type: 'integer',
                  minimum: 1,
                },
                valid_from: {
                  type: 'string',
                  format: 'date-time',
                },
                batch_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                },
                actor: {
                  type: 'object',
                  properties: {
                    user_id: {
                      type: ['string', 'null'],
                    },
                    email: {
                      type: ['string', 'null'],
                      format: 'email',
                    },
                    ip: {
                      type: ['string', 'null'],
                    },
                  },
                  required: ['user_id', 'email', 'ip'],
                  additionalProperties: false,
                },
              },
              required: [
                'target_type',
                'product_id',
                'sku',
                'channel_id',
                'currency',
                'price_type',
                'previous_price',
                'new_price',
                'operation',
                'reason',
                'price_version',
                'valid_from',
                'batch_id',
                'actor',
              ],
              additionalProperties: false,
              allOf: [
                {
                  if: {
                    properties: {
                      target_type: {
                        const: 'PRODUCTO',
                      },
                    },
                    required: ['target_type'],
                  },
                  then: {
                    properties: {
                      sku: {
                        type: 'null',
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      target_type: {
                        const: 'SKU',
                      },
                    },
                    required: ['target_type'],
                  },
                  then: {
                    properties: {
                      sku: {
                        type: 'string',
                        minLength: 1,
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      operation: {
                        const: 'CREACION',
                      },
                    },
                    required: ['operation'],
                  },
                  then: {
                    properties: {
                      previous_price: {
                        type: 'null',
                      },
                      new_price: {
                        type: 'string',
                        pattern:
                          '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.(?:0*[1-9][0-9]*))$',
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      operation: {
                        const: 'MODIFICACION',
                      },
                    },
                    required: ['operation'],
                  },
                  then: {
                    properties: {
                      previous_price: {
                        type: 'string',
                        pattern:
                          '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.(?:0*[1-9][0-9]*))$',
                      },
                      new_price: {
                        type: 'string',
                        pattern:
                          '^(?:[1-9][0-9]*(?:\\.[0-9]+)?|0\\.(?:0*[1-9][0-9]*))$',
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      operation: {
                        const: 'RETIRO_OFERTA',
                      },
                    },
                    required: ['operation'],
                  },
                  then: {
                    properties: {
                      price_type: {
                        const: 'OFERTA',
                      },
                      new_price: {
                        type: 'null',
                      },
                    },
                  },
                },
                {
                  if: {
                    properties: {
                      target_type: {
                        const: 'PRODUCTO',
                      },
                      price_type: {
                        const: 'OFERTA',
                      },
                    },
                    required: ['target_type', 'price_type'],
                  },
                  then: {
                    properties: {
                      sku: {
                        type: 'null',
                      },
                    },
                  },
                },
              ],
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
            schema_version: {
              type: 'integer',
              const: 2,
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
              properties: {
                sku: {
                  type: 'string',
                  minLength: 1,
                },
                location_id: {
                  type: 'string',
                  format: 'uuid',
                },
                on_hand: {
                  type: 'integer',
                  minimum: 0,
                },
                reserved: {
                  type: 'integer',
                  minimum: 0,
                },
                blocked: {
                  type: 'integer',
                  minimum: 0,
                },
                available: {
                  type: 'integer',
                  minimum: 0,
                },
                estado: {
                  type: 'string',
                  enum: ['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'],
                },
                stock_version: {
                  type: 'integer',
                  minimum: 1,
                },
                updated_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: [
                'sku',
                'location_id',
                'on_hand',
                'reserved',
                'blocked',
                'available',
                'estado',
                'stock_version',
                'updated_at',
              ],
              additionalProperties: false,
            },
          },
          required: ['producer', 'kind', 'name', 'data'],
        },
      ],
    },
  },
};
