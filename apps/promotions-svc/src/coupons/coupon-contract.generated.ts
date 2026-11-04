// Generated from G6 Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, AsyncAPI 0.6.0-rc.3.
// Source SHA-256: 10a61ce14468dbab3439270d0e008acb0695f7e256d4bd6e49d75e61e19dc5d0
import type { MessageContract } from './schema-validator.js';
export const couponContracts: Readonly<Record<string, MessageContract>> = {
  'promotions.coupon.consumption.requested': {
    exchange: 'po.comandos.x',
    routingKey: 'promotions.coupon.consumption.requested',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'modulo-ventas',
            },
            kind: {
              type: 'string',
              const: 'command',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.consumption.requested',
            },
            data: {
              type: 'object',
              properties: {
                order_id: {
                  type: 'string',
                  minLength: 1,
                },
                coupon_code: {
                  type: 'string',
                  minLength: 1,
                },
                customer_ref: {
                  oneOf: [
                    {
                      type: 'string',
                      format: 'uuid',
                    },
                    {
                      type: 'null',
                    },
                  ],
                },
                channel_id: {
                  type: 'string',
                  enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL'],
                },
                reservation_id: {
                  type: 'string',
                  format: 'uuid',
                },
                commercial_snapshot_ref: {
                  type: 'string',
                  minLength: 1,
                },
                effective_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: [
                'order_id',
                'coupon_code',
                'channel_id',
                'effective_at',
                'reservation_id',
                'commercial_snapshot_ref',
              ],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
  'promotions.coupon.restoration.requested': {
    exchange: 'po.comandos.x',
    routingKey: 'promotions.coupon.restoration.requested',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'modulo-ventas',
            },
            kind: {
              type: 'string',
              const: 'command',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.restoration.requested',
            },
            data: {
              type: 'object',
              properties: {
                order_id: {
                  type: 'string',
                  minLength: 1,
                },
                consumption_operation_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                  description:
                    'Referencia de consumo original; opcional solo en transición, pendiente de conciliación por G5/G6.',
                },
                cancellation_reason: {
                  type: 'string',
                  minLength: 1,
                },
                cancelled_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: ['order_id', 'cancellation_reason', 'cancelled_at'],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
  'promotions.coupon.consumption.completed': {
    exchange: 'po.resultados.x',
    routingKey: 'promotions.coupon.consumption.completed',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'promotions-svc',
            },
            kind: {
              type: 'string',
              const: 'result',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.consumption.completed',
            },
            data: {
              type: 'object',
              properties: {
                order_id: {
                  type: 'string',
                  minLength: 1,
                },
                coupon_code: {
                  type: 'string',
                  minLength: 1,
                },
                reservation_id: {
                  type: 'string',
                  format: 'uuid',
                },
                commercial_snapshot_ref: {
                  type: 'string',
                  minLength: 1,
                },
                result_code: {
                  type: ['string', 'null'],
                },
                consumption_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                },
                decided_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: [
                'order_id',
                'coupon_code',
                'reservation_id',
                'commercial_snapshot_ref',
                'decided_at',
              ],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
  'promotions.coupon.consumption.rejected': {
    exchange: 'po.resultados.x',
    routingKey: 'promotions.coupon.consumption.rejected',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'promotions-svc',
            },
            kind: {
              type: 'string',
              const: 'result',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.consumption.rejected',
            },
            data: {
              type: 'object',
              description:
                'Rechazo de consumo de cupón; el código de negocio es obligatorio y no representa consumo exitoso.',
              properties: {
                order_id: {
                  type: 'string',
                  minLength: 1,
                },
                coupon_code: {
                  type: 'string',
                  minLength: 1,
                },
                reservation_id: {
                  type: 'string',
                  format: 'uuid',
                },
                commercial_snapshot_ref: {
                  type: 'string',
                  minLength: 1,
                },
                result_code: {
                  type: 'string',
                  minLength: 1,
                  pattern: '\\S',
                },
                consumption_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                },
                decided_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: [
                'order_id',
                'coupon_code',
                'reservation_id',
                'commercial_snapshot_ref',
                'decided_at',
                'result_code',
              ],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
  'promotions.coupon.restoration.completed': {
    exchange: 'po.resultados.x',
    routingKey: 'promotions.coupon.restoration.completed',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'promotions-svc',
            },
            kind: {
              type: 'string',
              const: 'result',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.restoration.completed',
            },
            data: {
              type: 'object',
              properties: {
                order_id: {
                  type: 'string',
                },
                cupon_id: {
                  type: ['string', 'null'],
                },
                consumption_operation_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                },
                restored: {
                  type: 'boolean',
                },
                outcome: {
                  type: 'string',
                  enum: [
                    'RESTORED',
                    'POLICY_KEEPS_CONSUMPTION',
                    'NO_CONSUMPTION',
                  ],
                },
                completed_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: ['order_id', 'restored', 'outcome', 'completed_at'],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
  'promotions.coupon.restoration.rejected': {
    exchange: 'po.resultados.x',
    routingKey: 'promotions.coupon.restoration.rejected',
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
            schema_version: {
              type: 'integer',
              const: 2,
            },
            operation_id: {
              type: 'string',
              format: 'uuid',
            },
            causation_id: {
              type: 'string',
              minLength: 1,
            },
            producer: {
              type: 'string',
              const: 'promotions-svc',
            },
            kind: {
              type: 'string',
              const: 'result',
            },
            name: {
              type: 'string',
              const: 'promotions.coupon.restoration.rejected',
            },
            data: {
              type: 'object',
              description:
                'Rechazo definitivo de restauración, separado de los outcomes de restauración completada.',
              properties: {
                order_id: {
                  type: 'string',
                  minLength: 1,
                },
                consumption_operation_id: {
                  type: ['string', 'null'],
                  format: 'uuid',
                  description:
                    'Referencia del consumo original, opcional durante la transición con Ventas.',
                },
                result_code: {
                  type: 'string',
                  minLength: 1,
                  pattern: '\\S',
                },
                completed_at: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              required: ['order_id', 'result_code', 'completed_at'],
            },
          },
          required: [
            'schema_version',
            'operation_id',
            'causation_id',
            'producer',
            'kind',
            'name',
            'data',
          ],
        },
      ],
    },
  },
};
