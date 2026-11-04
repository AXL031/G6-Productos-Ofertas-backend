// Official Docs 51a5ce6e76bb0c61d93ef47416e46797bf5b9846, OpenAPI 0.6.0-rc.1.
// Source SHA-256: 46d850ee61505af5b096e9c66741bc0518c95de52741deab72ed7585892cb4ff
// Regenerate with test/generate-http-contract.mjs; no runtime contract download.
import type { HttpOperation } from './http-validation.js';
const conditionalThen = 'then' as const;
export const httpContracts: Readonly<Record<string, HttpOperation>> = {
  listarPromociones: {
    method: 'GET',
    path: '/api/v1/promociones',
    security: ['userBearer', 'serviceBearer'],
    scope: 'promociones:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    query: {
      canal: {
        required: true,
        schema: {
          type: 'string',
          enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
        },
      },
      vigentes: {
        required: false,
        schema: {
          type: 'boolean',
          default: true,
        },
      },
      estado: {
        required: false,
        schema: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
      },
    },
    response: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              promotion_id: {
                type: 'string',
              },
              name: {
                type: 'string',
              },
              status: {
                type: 'string',
                enum: ['ACTIVA', 'INACTIVA'],
              },
              valid_from: {
                type: 'string',
                format: 'date-time',
              },
              valid_until: {
                type: ['string', 'null'],
                format: 'date-time',
              },
              channels: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
                },
              },
            },
            required: [
              'promotion_id',
              'name',
              'status',
              'valid_from',
              'channels',
            ],
          },
        },
      },
      required: ['items'],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '429': ['RATE_LIMIT_EXCEDIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  crearPromocion: {
    method: 'POST',
    path: '/api/v1/promociones',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          minLength: 1,
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
      ],
    },
    response: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        puedeCambiarModalidad: {
          type: 'boolean',
          readOnly: true,
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'promotionId',
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
        'puedeCambiarModalidad',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '422': ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  evaluarPromociones: {
    method: 'POST',
    path: '/api/v1/promociones/evaluar',
    security: ['serviceBearer'],
    scope: 'promociones:evaluar',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    query: {},
    body: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
        },
        at: {
          type: ['string', 'null'],
          format: 'date-time',
        },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: {
                type: ['string', 'null'],
              },
              sku: {
                type: 'string',
              },
              quantity: {
                type: 'integer',
                minimum: 1,
              },
            },
            required: ['sku', 'quantity'],
          },
          minItems: 1,
        },
        coupon_code: {
          type: ['string', 'null'],
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
      },
      required: ['channel_id', 'lines'],
    },
    response: {
      type: 'object',
      properties: {
        promotion_id: {
          type: ['string', 'null'],
        },
        original_amount: {
          type: 'number',
          minimum: 0,
        },
        discount_amount: {
          type: 'number',
          minimum: 0,
        },
        result_amount: {
          type: 'number',
          minimum: 0,
        },
        currency: {
          type: 'string',
          default: 'PEN',
        },
        reason: {
          type: ['string', 'null'],
        },
      },
      required: [
        'original_amount',
        'discount_amount',
        'result_amount',
        'currency',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '422': ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
      '429': ['RATE_LIMIT_EXCEDIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  validarCupon: {
    method: 'POST',
    path: '/api/v1/cupones/validar',
    security: ['serviceBearer'],
    scope: 'cupones:validar',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    query: {},
    body: {
      type: 'object',
      properties: {
        coupon_code: {
          type: 'string',
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
          enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
        },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: {
                type: ['string', 'null'],
              },
              sku: {
                type: 'string',
              },
              quantity: {
                type: 'integer',
                minimum: 1,
              },
            },
            required: ['sku', 'quantity'],
          },
          minItems: 1,
        },
      },
      required: ['coupon_code', 'channel_id', 'lines'],
    },
    response: {
      type: 'object',
      properties: {
        valid: {
          type: 'boolean',
        },
        rejection_reason: {
          type: ['string', 'null'],
        },
        benefit: {
          oneOf: [
            {
              type: 'object',
              properties: {
                promotion_id: {
                  type: 'string',
                },
              },
              required: ['promotion_id'],
            },
            {
              type: 'null',
            },
          ],
        },
        discount_amount: {
          type: 'number',
          minimum: 0,
        },
        result_amount: {
          type: 'number',
          minimum: 0,
        },
        currency: {
          type: 'string',
          default: 'PEN',
        },
        code: {
          oneOf: [
            {
              type: 'string',
              enum: [
                'CUPON_NO_ENCONTRADO',
                'CUPON_INACTIVO',
                'CUPON_FUERA_DE_VIGENCIA',
                'MONTO_MINIMO_NO_ALCANZADO',
                'CUPON_AGOTADO',
                'LIMITE_CUPON_CLIENTE_ALCANZADO',
                'CUSTOMER_REF_REQUERIDO',
                'CUPON_NO_COMBINABLE',
              ],
            },
            {
              type: 'null',
            },
          ],
        },
      },
      required: ['valid', 'discount_amount', 'result_amount', 'currency'],
      allOf: [
        {
          if: {
            properties: {
              valid: {
                const: false,
              },
            },
            required: ['valid'],
          },
          [conditionalThen]: {
            required: ['code'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'CUPON_NO_ENCONTRADO',
                  'CUPON_INACTIVO',
                  'CUPON_FUERA_DE_VIGENCIA',
                  'MONTO_MINIMO_NO_ALCANZADO',
                  'CUPON_AGOTADO',
                  'LIMITE_CUPON_CLIENTE_ALCANZADO',
                  'CUSTOMER_REF_REQUERIDO',
                  'CUPON_NO_COMBINABLE',
                ],
              },
            },
          },
        },
        {
          if: {
            properties: {
              valid: {
                const: true,
              },
            },
            required: ['valid'],
          },
          [conditionalThen]: {
            properties: {
              code: {
                type: 'null',
              },
            },
          },
        },
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '429': ['RATE_LIMIT_EXCEDIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  obtenerRecomendaciones: {
    method: 'GET',
    path: '/api/v1/recomendaciones',
    security: ['serviceBearer'],
    scope: 'recomendaciones:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    query: {
      productoId: {
        required: true,
        schema: {
          type: 'string',
        },
      },
      canal: {
        required: true,
        schema: {
          type: 'string',
          enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
        },
      },
    },
    response: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: {
                type: 'string',
              },
              type: {
                type: 'string',
                enum: ['CROSS_SELL', 'UPSELL'],
              },
              rule_priority: {
                type: 'integer',
                minimum: 0,
              },
              presentation_order: {
                type: 'integer',
                minimum: 1,
              },
              current_price: {
                type: ['number', 'null'],
                minimum: 0,
              },
              availability: {
                type: 'string',
                enum: ['DISPONIBLE', 'STOCK_BAJO', 'AGOTADO'],
              },
            },
            required: [
              'product_id',
              'type',
              'rule_priority',
              'presentation_order',
              'availability',
            ],
          },
        },
      },
      required: ['recommendations'],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '429': ['RATE_LIMIT_EXCEDIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  listarCupones: {
    method: 'GET',
    path: '/api/v1/cupones',
    security: ['userBearer'],
    query: {
      pagina: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          default: 1,
        },
      },
      tamanio: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
        },
      },
      estado: {
        required: false,
        schema: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
      },
    },
    response: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cuponId: {
                type: 'string',
              },
              codigo: {
                type: 'string',
              },
              promocionId: {
                type: 'string',
              },
              estado: {
                type: 'string',
                enum: ['ACTIVO', 'INACTIVO'],
              },
              montoMinimo: {
                oneOf: [
                  {
                    type: 'number',
                    exclusiveMinimum: 0,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              maxUsosGlobal: {
                oneOf: [
                  {
                    type: 'integer',
                    minimum: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              maxUsosPorCliente: {
                oneOf: [
                  {
                    type: 'integer',
                    minimum: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              politicaCancelacion: {
                type: 'string',
                enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
              },
              usosGlobalesConsumidos: {
                type: 'integer',
                minimum: 0,
              },
              usosDisponibles: {
                oneOf: [
                  {
                    type: 'integer',
                    minimum: 0,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              createdAt: {
                type: 'string',
                format: 'date-time',
              },
              updatedAt: {
                type: 'string',
                format: 'date-time',
              },
            },
            additionalProperties: true,
            required: [
              'cuponId',
              'codigo',
              'promocionId',
              'estado',
              'politicaCancelacion',
              'usosGlobalesConsumidos',
              'createdAt',
              'updatedAt',
            ],
          },
        },
        meta: {
          type: 'object',
          properties: {
            pagina: {
              type: 'integer',
              minimum: 1,
            },
            tamanio: {
              type: 'integer',
              minimum: 1,
            },
            total: {
              type: 'integer',
              minimum: 0,
            },
            totalPaginas: {
              type: 'integer',
              minimum: 0,
            },
          },
          additionalProperties: true,
          required: ['pagina', 'tamanio', 'total', 'totalPaginas'],
        },
      },
      additionalProperties: true,
      required: ['items', 'meta'],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  crearCupon: {
    method: 'POST',
    path: '/api/v1/cupones',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        codigo: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]+$',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
      },
      additionalProperties: true,
      required: ['codigo', 'promocionId', 'estado', 'politicaCancelacion'],
    },
    response: {
      type: 'object',
      properties: {
        cuponId: {
          type: 'string',
        },
        codigo: {
          type: 'string',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
        usosGlobalesConsumidos: {
          type: 'integer',
          minimum: 0,
        },
        usosDisponibles: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      additionalProperties: true,
      required: [
        'cuponId',
        'codigo',
        'promocionId',
        'estado',
        'politicaCancelacion',
        'usosGlobalesConsumidos',
        'createdAt',
        'updatedAt',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '409': ['CUPON_DUPLICADO'],
      '422': ['LIMITE_CUPON_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  obtenerCuponAdmin: {
    method: 'GET',
    path: '/api/v1/cupones/{cuponId}',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        cuponId: {
          type: 'string',
        },
        codigo: {
          type: 'string',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
        usosGlobalesConsumidos: {
          type: 'integer',
          minimum: 0,
        },
        usosDisponibles: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      additionalProperties: true,
      required: [
        'cuponId',
        'codigo',
        'promocionId',
        'estado',
        'politicaCancelacion',
        'usosGlobalesConsumidos',
        'createdAt',
        'updatedAt',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['CUPON_NO_ENCONTRADO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  actualizarCupon: {
    method: 'PATCH',
    path: '/api/v1/cupones/{cuponId}',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        codigo: {
          type: 'string',
          pattern: '^[A-Za-z0-9_-]+$',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
      },
      additionalProperties: true,
    },
    response: {
      type: 'object',
      properties: {
        cuponId: {
          type: 'string',
        },
        codigo: {
          type: 'string',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
        usosGlobalesConsumidos: {
          type: 'integer',
          minimum: 0,
        },
        usosDisponibles: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      additionalProperties: true,
      required: [
        'cuponId',
        'codigo',
        'promocionId',
        'estado',
        'politicaCancelacion',
        'usosGlobalesConsumidos',
        'createdAt',
        'updatedAt',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['CUPON_NO_ENCONTRADO'],
      '409': ['CUPON_DUPLICADO'],
      '422': ['LIMITE_CUPON_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  activarCupon: {
    method: 'POST',
    path: '/api/v1/cupones/{cuponId}/activar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        cuponId: {
          type: 'string',
        },
        codigo: {
          type: 'string',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
        usosGlobalesConsumidos: {
          type: 'integer',
          minimum: 0,
        },
        usosDisponibles: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      additionalProperties: true,
      required: [
        'cuponId',
        'codigo',
        'promocionId',
        'estado',
        'politicaCancelacion',
        'usosGlobalesConsumidos',
        'createdAt',
        'updatedAt',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['CUPON_NO_ENCONTRADO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  desactivarCupon: {
    method: 'POST',
    path: '/api/v1/cupones/{cuponId}/desactivar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        cuponId: {
          type: 'string',
        },
        codigo: {
          type: 'string',
        },
        promocionId: {
          type: 'string',
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        montoMinimo: {
          oneOf: [
            {
              type: 'number',
              exclusiveMinimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosGlobal: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        maxUsosPorCliente: {
          oneOf: [
            {
              type: 'integer',
              minimum: 1,
            },
            {
              type: 'null',
            },
          ],
        },
        politicaCancelacion: {
          type: 'string',
          enum: ['RESTAURAR_EN_CANCELACION', 'NO_RESTAURAR'],
        },
        usosGlobalesConsumidos: {
          type: 'integer',
          minimum: 0,
        },
        usosDisponibles: {
          oneOf: [
            {
              type: 'integer',
              minimum: 0,
            },
            {
              type: 'null',
            },
          ],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      additionalProperties: true,
      required: [
        'cuponId',
        'codigo',
        'promocionId',
        'estado',
        'politicaCancelacion',
        'usosGlobalesConsumidos',
        'createdAt',
        'updatedAt',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['CUPON_NO_ENCONTRADO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  obtenerPromocionAdmin: {
    method: 'GET',
    path: '/api/v1/promociones/{promocionId}',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        puedeCambiarModalidad: {
          type: 'boolean',
          readOnly: true,
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'promotionId',
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
        'puedeCambiarModalidad',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['PROMOCION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  actualizarPromocion: {
    method: 'PATCH',
    path: '/api/v1/promociones/{promocionId}',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          minLength: 1,
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
    },
    response: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        puedeCambiarModalidad: {
          type: 'boolean',
          readOnly: true,
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'promotionId',
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
        'puedeCambiarModalidad',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['PROMOCION_NO_ENCONTRADA'],
      '422': ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  activarPromocion: {
    method: 'POST',
    path: '/api/v1/promociones/{promocionId}/activar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        puedeCambiarModalidad: {
          type: 'boolean',
          readOnly: true,
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'promotionId',
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
        'puedeCambiarModalidad',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['PROMOCION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  desactivarPromocion: {
    method: 'POST',
    path: '/api/v1/promociones/{promocionId}/desactivar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipoDescuento: {
          type: 'string',
          enum: ['PORCENTAJE', 'MONTO_FIJO'],
        },
        valor: {
          type: 'number',
          exclusiveMinimum: 0,
        },
        modalidad: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        alcance: {
          type: 'object',
          properties: {
            productIds: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            skus: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
          additionalProperties: true,
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        canalesHabilitados: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'string',
            enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
          },
        },
        puedeCambiarModalidad: {
          type: 'boolean',
          readOnly: true,
        },
        politicaCombinacion: {
          type: 'object',
          properties: {
            ofertaPricing: {
              type: 'boolean',
            },
            promocionAutomatica: {
              type: 'boolean',
            },
            cupon: {
              type: 'boolean',
            },
          },
          additionalProperties: true,
          required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
        },
      },
      additionalProperties: true,
      required: [
        'promotionId',
        'nombre',
        'tipoDescuento',
        'valor',
        'modalidad',
        'estado',
        'validFrom',
        'validUntil',
        'alcance',
        'prioridad',
        'canalesHabilitados',
        'politicaCombinacion',
        'puedeCambiarModalidad',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['PROMOCION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  listarReglasRecomendacion: {
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas',
    security: ['userBearer'],
    query: {
      pagina: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          default: 1,
        },
      },
      tamanio: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
        },
      },
      estado: {
        required: false,
        schema: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
      },
      tipo: {
        required: false,
        schema: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
      },
    },
    response: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reglaId: {
                type: 'string',
              },
              nombre: {
                type: 'string',
              },
              tipo: {
                type: 'string',
                enum: ['CROSS_SELL', 'UPSELL'],
              },
              origen: {
                type: 'object',
                properties: {
                  tipo: {
                    type: 'string',
                    enum: ['PRODUCTO', 'CATEGORIA'],
                  },
                  id: {
                    type: 'string',
                  },
                },
                additionalProperties: true,
                required: ['tipo', 'id'],
              },
              prioridad: {
                type: 'integer',
                minimum: 1,
              },
              estado: {
                type: 'string',
                enum: ['ACTIVO', 'INACTIVO'],
              },
              validFrom: {
                type: 'string',
                format: 'date-time',
              },
              validUntil: {
                type: 'string',
                format: 'date-time',
              },
              recomendados: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    productId: {
                      type: 'string',
                    },
                    orden: {
                      type: 'integer',
                      minimum: 1,
                    },
                    criterioSuperioridad: {
                      oneOf: [
                        {
                          type: 'string',
                          enum: [
                            'MAYOR_RENDIMIENTO',
                            'MEJOR_MATERIAL',
                            'MAYOR_CAPACIDAD',
                            'FUNCIONALIDAD_ADICIONAL',
                          ],
                        },
                        {
                          type: 'null',
                        },
                      ],
                    },
                    justificacionComercial: {
                      oneOf: [
                        {
                          type: 'string',
                          maxLength: 500,
                        },
                        {
                          type: 'null',
                        },
                      ],
                    },
                  },
                  additionalProperties: true,
                  required: ['productId', 'orden'],
                },
                minItems: 1,
              },
            },
            additionalProperties: true,
            required: [
              'reglaId',
              'nombre',
              'tipo',
              'origen',
              'prioridad',
              'estado',
              'validFrom',
              'validUntil',
              'recomendados',
            ],
          },
        },
        meta: {
          type: 'object',
          properties: {
            pagina: {
              type: 'integer',
              minimum: 1,
            },
            tamanio: {
              type: 'integer',
              minimum: 1,
            },
            total: {
              type: 'integer',
              minimum: 0,
            },
            totalPaginas: {
              type: 'integer',
              minimum: 0,
            },
          },
          additionalProperties: true,
          required: ['pagina', 'tamanio', 'total', 'totalPaginas'],
        },
      },
      additionalProperties: true,
      required: ['items', 'meta'],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  crearReglaRecomendacion: {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          minLength: 1,
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    response: {
      type: 'object',
      properties: {
        reglaId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'reglaId',
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '422': ['REGLA_RECOMENDACION_INVALIDA', 'PRODUCTO_RECOMENDADO_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  obtenerReglaRecomendacion: {
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas/{reglaId}',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        reglaId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'reglaId',
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  actualizarReglaRecomendacion: {
    method: 'PATCH',
    path: '/api/v1/recomendaciones/reglas/{reglaId}',
    security: ['userBearer'],
    query: {},
    body: {
      type: 'object',
      properties: {
        nombre: {
          type: 'string',
          minLength: 1,
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
    },
    response: {
      type: 'object',
      properties: {
        reglaId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'reglaId',
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    errors: {
      '400': ['VALIDACION'],
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
      '422': ['REGLA_RECOMENDACION_INVALIDA', 'PRODUCTO_RECOMENDADO_INVALIDO'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  activarReglaRecomendacion: {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas/{reglaId}/activar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        reglaId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'reglaId',
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  desactivarReglaRecomendacion: {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas/{reglaId}/desactivar',
    security: ['userBearer'],
    query: {},
    response: {
      type: 'object',
      properties: {
        reglaId: {
          type: 'string',
        },
        nombre: {
          type: 'string',
        },
        tipo: {
          type: 'string',
          enum: ['CROSS_SELL', 'UPSELL'],
        },
        origen: {
          type: 'object',
          properties: {
            tipo: {
              type: 'string',
              enum: ['PRODUCTO', 'CATEGORIA'],
            },
            id: {
              type: 'string',
            },
          },
          additionalProperties: true,
          required: ['tipo', 'id'],
        },
        prioridad: {
          type: 'integer',
          minimum: 1,
        },
        estado: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
        validFrom: {
          type: 'string',
          format: 'date-time',
        },
        validUntil: {
          type: 'string',
          format: 'date-time',
        },
        recomendados: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: {
                type: 'string',
              },
              orden: {
                type: 'integer',
                minimum: 1,
              },
              criterioSuperioridad: {
                oneOf: [
                  {
                    type: 'string',
                    enum: [
                      'MAYOR_RENDIMIENTO',
                      'MEJOR_MATERIAL',
                      'MAYOR_CAPACIDAD',
                      'FUNCIONALIDAD_ADICIONAL',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              justificacionComercial: {
                oneOf: [
                  {
                    type: 'string',
                    maxLength: 500,
                  },
                  {
                    type: 'null',
                  },
                ],
              },
            },
            additionalProperties: true,
            required: ['productId', 'orden'],
          },
          minItems: 1,
        },
      },
      additionalProperties: true,
      required: [
        'reglaId',
        'nombre',
        'tipo',
        'origen',
        'prioridad',
        'estado',
        'validFrom',
        'validUntil',
        'recomendados',
      ],
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '404': ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
  listarPromocionesAdmin: {
    method: 'GET',
    path: '/api/v1/promociones/administracion',
    security: ['userBearer'],
    query: {
      pagina: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          default: 1,
        },
      },
      tamanio: {
        required: false,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
        },
      },
      estado: {
        required: false,
        schema: {
          type: 'string',
          enum: ['ACTIVO', 'INACTIVO'],
        },
      },
      modalidad: {
        required: false,
        schema: {
          type: 'string',
          enum: ['AUTOMATICA', 'CUPON'],
        },
      },
    },
    response: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              promotionId: {
                type: 'string',
              },
              nombre: {
                type: 'string',
              },
              tipoDescuento: {
                type: 'string',
                enum: ['PORCENTAJE', 'MONTO_FIJO'],
              },
              valor: {
                type: 'number',
                exclusiveMinimum: 0,
              },
              modalidad: {
                type: 'string',
                enum: ['AUTOMATICA', 'CUPON'],
              },
              estado: {
                type: 'string',
                enum: ['ACTIVO', 'INACTIVO'],
              },
              validFrom: {
                type: 'string',
                format: 'date-time',
              },
              validUntil: {
                type: 'string',
                format: 'date-time',
              },
              alcance: {
                type: 'object',
                properties: {
                  productIds: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  skus: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                },
                additionalProperties: true,
              },
              prioridad: {
                type: 'integer',
                minimum: 1,
              },
              canalesHabilitados: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: {
                  type: 'string',
                  enum: ['MARKETPLACE', 'CHATBOT', 'RETAIL', 'VENTAS'],
                },
              },
              puedeCambiarModalidad: {
                type: 'boolean',
                readOnly: true,
              },
              politicaCombinacion: {
                type: 'object',
                properties: {
                  ofertaPricing: {
                    type: 'boolean',
                  },
                  promocionAutomatica: {
                    type: 'boolean',
                  },
                  cupon: {
                    type: 'boolean',
                  },
                },
                additionalProperties: true,
                required: ['ofertaPricing', 'promocionAutomatica', 'cupon'],
              },
            },
            additionalProperties: true,
            required: [
              'promotionId',
              'nombre',
              'tipoDescuento',
              'valor',
              'modalidad',
              'estado',
              'validFrom',
              'validUntil',
              'alcance',
              'prioridad',
              'canalesHabilitados',
              'politicaCombinacion',
              'puedeCambiarModalidad',
            ],
          },
        },
        meta: {
          type: 'object',
          properties: {
            pagina: {
              type: 'integer',
              minimum: 1,
            },
            tamanio: {
              type: 'integer',
              minimum: 1,
            },
            total: {
              type: 'integer',
              minimum: 0,
            },
            totalPaginas: {
              type: 'integer',
              minimum: 0,
            },
          },
          additionalProperties: true,
          required: ['pagina', 'tamanio', 'total', 'totalPaginas'],
        },
      },
      required: ['items', 'meta'],
      additionalProperties: true,
    },
    errors: {
      '401': ['TOKEN_INVALIDO'],
      '403': ['SCOPE_INSUFICIENTE'],
      '500': ['ERROR_INTERNO'],
      '503': ['SERVICIO_NO_DISPONIBLE'],
    },
  },
};
