// Generated from Docs 5124eeae4ec65b22ea9146cd7b1ce3888c617c10, OpenAPI rc.2.
// Source SHA-256: 1054a29276b231477183e980339f8dcdca1e37e1cbb5eab1bb5b86fc846a6eb8
import type { HttpSchema } from '../../http/http-validation.js';
export const upstreamSchemas: Readonly<Record<string, HttpSchema>> = {
  ProductoDetalleComercial: {
    allOf: [
      {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
          },
          slug: {
            type: 'string',
          },
          name: {
            type: 'string',
          },
          categoria_id: {
            type: 'string',
          },
          tipo_producto_id: {
            type: 'string',
          },
          marca_id: {
            type: 'string',
          },
          tiene_variantes: {
            type: 'boolean',
          },
          sku_base: {
            type: ['string', 'null'],
          },
          images: {
            type: 'array',
            items: {
              type: 'string',
              format: 'uri',
            },
          },
          attributes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                caracteristica_id: {
                  type: 'string',
                },
                nombre: {
                  type: 'string',
                },
                valor_id: {
                  type: ['string', 'null'],
                },
                valor: {},
              },
              required: ['caracteristica_id', 'nombre', 'valor'],
            },
          },
        },
        required: [
          'product_id',
          'slug',
          'name',
          'categoria_id',
          'tipo_producto_id',
          'marca_id',
          'tiene_variantes',
        ],
      },
      {
        type: 'object',
        properties: {
          marca: {
            type: 'object',
            properties: {
              marca_id: {
                type: 'string',
              },
              name: {
                type: 'string',
              },
              logo_url: {
                type: ['string', 'null'],
                format: 'uri',
              },
              country_code: {
                type: ['string', 'null'],
              },
            },
            required: ['marca_id', 'name'],
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                variant_id: {
                  type: 'string',
                },
                sku: {
                  type: 'string',
                },
                identifying_attributes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      caracteristica_id: {
                        type: 'string',
                      },
                      nombre: {
                        type: 'string',
                      },
                      valor_id: {
                        type: ['string', 'null'],
                      },
                      valor: {},
                    },
                    required: ['caracteristica_id', 'nombre', 'valor'],
                  },
                },
                non_identifying_attributes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      caracteristica_id: {
                        type: 'string',
                      },
                      nombre: {
                        type: 'string',
                      },
                      valor_id: {
                        type: ['string', 'null'],
                      },
                      valor: {},
                    },
                    required: ['caracteristica_id', 'nombre', 'valor'],
                  },
                },
                images: {
                  type: 'array',
                  items: {
                    type: 'string',
                    format: 'uri',
                  },
                },
              },
              required: ['variant_id', 'sku'],
            },
          },
        },
        required: ['marca', 'variants'],
      },
    ],
  },
  PricingCatalogContext: {
    type: 'object',
    properties: {
      sku: {
        type: 'string',
      },
      productId: {
        type: 'string',
      },
      isVariant: {
        type: 'boolean',
      },
      active: {
        type: 'boolean',
      },
      eligible: {
        type: 'boolean',
      },
    },
    required: ['sku', 'productId', 'isVariant', 'active', 'eligible'],
    additionalProperties: false,
  },
  CategoriaAdmin: {
    type: 'object',
    properties: {
      categoriaId: {
        type: 'string',
      },
      nombre: {
        type: 'string',
      },
      descripcion: {
        oneOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
      },
      categoriaPadreId: {
        oneOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
      },
      orden: {
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
      imagenUrl: {
        oneOf: [
          {
            type: 'string',
            format: 'uri',
          },
          {
            type: 'null',
          },
        ],
      },
      estado: {
        type: 'string',
        enum: ['ACTIVO', 'INACTIVO'],
      },
      version: {
        type: 'integer',
        minimum: 0,
      },
      slug: {
        oneOf: [
          {
            type: 'string',
          },
          {
            type: 'null',
          },
        ],
      },
    },
    additionalProperties: true,
    required: ['categoriaId', 'nombre', 'estado', 'version'],
  },
};
