// Generated from Docs OpenAPI 0.6.0-rc.3; focused update: consultarDisponibilidadComercial.
import type { ContractRoute } from './contract-route.js';
export const CONTRACT_ROUTES: readonly ContractRoute[] = [
  {
    method: 'GET',
    path: '/api/v1/productos',
    operationId: 'listarProductos',
    service: 'catalog-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_INVALIDA', 'MARCA_INVALIDA'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos',
    operationId: 'crearProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['SKU_DUPLICADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'CATEGORIA_INVALIDA',
          'TIPO_PRODUCTO_INVALIDO',
          'MARCA_INVALIDA',
          'PERFIL_FISICO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/productos/{productoId}',
    operationId: 'obtenerProducto',
    service: 'catalog-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/productos/{productoId}',
    operationId: 'actualizarProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT', 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'CATEGORIA_INVALIDA',
          'MARCA_INVALIDA',
          'PERFIL_FISICO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias',
    operationId: 'listarCategorias',
    service: 'taxonomy-svc',
    security: ['serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/categorias',
    operationId: 'crearCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_PADRE_INACTIVA', 'SLUG_DUPLICADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PROFUNDIDAD_CATEGORIA_EXCEDIDA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/marcas',
    operationId: 'listarMarcas',
    service: 'taxonomy-svc',
    security: ['serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/marcas',
    operationId: 'crearMarca',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['multipart/form-data'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['MARCA_DUPLICADA'],
        headers: [],
      },
      '413': {
        types: ['application/problem+json'],
        codes: ['LOGO_EXCEDE_LIMITE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LOGO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios',
    operationId: 'consultarPrecios',
    service: 'pricing-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'precios:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/skus/{sku}',
    operationId: 'obtenerPrecioSku',
    service: 'pricing-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'precios:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/precios/skus/{sku}',
    operationId: 'actualizarPrecioSku',
    service: 'pricing-svc',
    security: ['userBearer'],
    role: 'GESTOR_COMERCIAL',
    introspection: true,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION', 'MOTIVO_CAMBIO_REQUERIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT', 'VIGENCIA_SUPERPUESTA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'PRECIO_INVALIDO',
          'OFERTA_INVALIDA',
          'ACCION_OFERTA_INVALIDA',
          'SCOPE_PRECIO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/promociones',
    operationId: 'listarPromociones',
    service: 'promotions-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'promociones:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/promociones',
    operationId: 'crearPromocion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/promociones/evaluar',
    operationId: 'evaluarPromociones',
    service: 'promotions-svc',
    security: ['serviceBearer'],
    scope: 'promociones:evaluar',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cupones/validar',
    operationId: 'validarCupon',
    service: 'promotions-svc',
    security: ['serviceBearer'],
    scope: 'cupones:validar',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/recomendaciones',
    operationId: 'obtenerRecomendaciones',
    service: 'promotions-svc',
    security: ['serviceBearer'],
    scope: 'recomendaciones:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/combos/{comboId}',
    operationId: 'obtenerCombo',
    service: 'combos-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'combos:leer',
    audience: 'api-productos',
    clients: [],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['COMBO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/combos/{comboId}',
    operationId: 'actualizarCombo',
    service: 'combos-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['COMBO_NO_ENCONTRADO', 'SKU_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'COMBO_ANIDADO_NO_PERMITIDO',
          'COMBO_COMPONENTES_INSUFICIENTES',
          'COMBO_COMPONENTE_DUPLICADO',
          'COMBO_PRECIO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/disponibilidad',
    operationId: 'consultarDisponibilidad',
    service: 'inventory-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'inventario:disponibilidad:leer',
    audience: 'api-productos',
    clients: ['modulo-ventas', 'modulo-postventa'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/reservas',
    operationId: 'solicitarReserva',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:reservar',
    audience: 'api-productos',
    clients: ['modulo-ventas'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['CANTIDAD_INVALIDA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/reservas/{reservaId}/confirmar',
    operationId: 'confirmarReserva',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:consumir',
    audience: 'api-productos',
    clients: ['modulo-ventas'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['RESERVA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'IDEMPOTENCY_CONFLICT',
          'RESERVA_NO_ACTIVA',
          'RESERVA_EXPIRADA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/reservas/{reservaId}/liberar',
    operationId: 'liberarReserva',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:liberar',
    audience: 'api-productos',
    clients: ['modulo-ventas'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['RESERVA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT', 'RESERVA_NO_ACTIVA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/datos-fisicos/consulta',
    operationId: 'consultarDatosFisicos',
    service: 'catalog-svc',
    security: ['serviceBearer'],
    scope: 'productos:fisicos:leer',
    audience: 'api-productos',
    clients: ['modulo-despacho'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['SKU_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/seo/categorias/slug/resolver',
    operationId: 'resolverSlugCategoriaCreacion',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/seo/{slug}',
    operationId: 'obtenerSeoPorSlug',
    service: 'taxonomy-svc',
    security: [],
    introspection: false,
    headers: [],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SLUG_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/seo/resoluciones/{slugAnterior}',
    operationId: 'resolverSlugAnterior',
    service: 'taxonomy-svc',
    security: [],
    introspection: false,
    headers: [],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SLUG_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/activar',
    operationId: 'activarProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'DATOS_INCOMPLETOS',
          'CATEGORIA_INVALIDA',
          'TIPO_PRODUCTO_INVALIDO',
          'MARCA_INVALIDA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/desactivar',
    operationId: 'desactivarProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/reactivar',
    operationId: 'reactivarProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'DATOS_INCOMPLETOS',
          'CATEGORIA_INVALIDA',
          'TIPO_PRODUCTO_INVALIDO',
          'MARCA_INVALIDA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/productos/por-slug/{slug}',
    operationId: 'obtenerProductoPorSlug',
    service: 'catalog-svc',
    security: ['serviceBearer', 'userBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/productos/{productoId}/preparacion',
    operationId: 'obtenerPreparacionProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/preparacion/reintentar',
    operationId: 'reintentarPreparacionProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['PREPARACION_NO_REINTENTABLE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/productos/{productoId}/variantes',
    operationId: 'listarVariantesProducto',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/variantes',
    operationId: 'crearVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'COMBINACION_DUPLICADA',
          'SKU_DUPLICADO',
          'PRODUCTO_NO_ADMITE_VARIANTES',
        ],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'SKU_INVALIDO',
          'ATRIBUTO_IDENTIFICADOR_INVALIDO',
          'IMAGEN_INVALIDA',
          'PERFIL_FISICO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}',
    operationId: 'obtenerVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}',
    operationId: 'actualizarVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT', 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['IMAGEN_INVALIDA', 'PERFIL_FISICO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}/activar',
    operationId: 'activarVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'DATOS_INCOMPLETOS',
          'SKU_INVALIDO',
          'ATRIBUTO_IDENTIFICADOR_INVALIDO',
          'IMAGEN_INVALIDA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}/desactivar',
    operationId: 'desactivarVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}/reactivar',
    operationId: 'reactivarVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'DATOS_INCOMPLETOS',
          'SKU_INVALIDO',
          'ATRIBUTO_IDENTIFICADOR_INVALIDO',
          'IMAGEN_INVALIDA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/{productoId}/variantes/{variantId}/preparacion/reintentar',
    operationId: 'reintentarPreparacionVariante',
    service: 'catalog-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRODUCTO_NO_ENCONTRADO', 'VARIANTE_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['PREPARACION_NO_REINTENTABLE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/combos',
    operationId: 'listarCombosAdmin',
    service: 'combos-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/combos',
    operationId: 'crearCombo',
    service: 'combos-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SKU_NO_ENCONTRADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'COMBO_ANIDADO_NO_PERMITIDO',
          'COMBO_COMPONENTES_INSUFICIENTES',
          'COMBO_COMPONENTE_DUPLICADO',
          'COMBO_PRECIO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/combos/{comboId}/desactivar',
    operationId: 'desactivarCombo',
    service: 'combos-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['COMBO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/combos/{comboId}/disponibilidad',
    operationId: 'consultarDisponibilidadCombo',
    service: 'combos-svc',
    security: ['userBearer', 'serviceBearer'],
    scope: 'combos:leer',
    audience: 'api-productos',
    clients: [],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['COMBO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/cupones',
    operationId: 'listarCupones',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cupones',
    operationId: 'crearCupon',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['CUPON_DUPLICADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LIMITE_CUPON_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/cupones/{cuponId}',
    operationId: 'obtenerCuponAdmin',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CUPON_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/cupones/{cuponId}',
    operationId: 'actualizarCupon',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CUPON_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['CUPON_DUPLICADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LIMITE_CUPON_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cupones/{cuponId}/activar',
    operationId: 'activarCupon',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CUPON_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cupones/{cuponId}/desactivar',
    operationId: 'desactivarCupon',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CUPON_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/promociones/{promocionId}',
    operationId: 'obtenerPromocionAdmin',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/promociones/{promocionId}',
    operationId: 'actualizarPromocion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_NO_ENCONTRADA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_INVALIDA', 'ALCANCE_PROMOCION_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/promociones/{promocionId}/activar',
    operationId: 'activarPromocion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/promociones/{promocionId}/desactivar',
    operationId: 'desactivarPromocion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PROMOCION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas',
    operationId: 'listarReglasRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas',
    operationId: 'crearReglaRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'REGLA_RECOMENDACION_INVALIDA',
          'PRODUCTO_RECOMENDADO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/recomendaciones/reglas/{reglaId}',
    operationId: 'obtenerReglaRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/recomendaciones/reglas/{reglaId}',
    operationId: 'actualizarReglaRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'REGLA_RECOMENDACION_INVALIDA',
          'PRODUCTO_RECOMENDADO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas/{reglaId}/activar',
    operationId: 'activarReglaRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/recomendaciones/reglas/{reglaId}/desactivar',
    operationId: 'desactivarReglaRecomendacion',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['REGLA_RECOMENDACION_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias/arbol',
    operationId: 'obtenerArbolCategoriasAdmin',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}',
    operationId: 'obtenerCategoriaAdmin',
    service: 'taxonomy-svc',
    clients: ['modulo-productos'],
    audience: 'api-productos',
    scope: 'catalogo:leer',
    security: ['userBearer', 'serviceBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/categorias/{categoriaId}',
    operationId: 'actualizarCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'CICLO_CATEGORIA',
          'CATEGORIA_PADRE_INACTIVA',
          'VERSION_CONFLICT',
        ],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PROFUNDIDAD_CATEGORIA_EXCEDIDA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/categorias/{categoriaId}/desactivar',
    operationId: 'solicitarDesactivacionCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'CATEGORIA_CON_SUBCATEGORIAS_ACTIVAS',
          'BAJA_MAESTRA_EN_PROCESO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/categorias/{categoriaId}/reactivar',
    operationId: 'reactivarCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_PADRE_INACTIVA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/caracteristicas',
    operationId: 'listarCaracteristicas',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas',
    operationId: 'crearCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['VALOR_NUMERICO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/caracteristicas/{caracteristicaId}',
    operationId: 'obtenerCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/caracteristicas/{caracteristicaId}',
    operationId: 'actualizarCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['TIPO_CARACTERISTICA_INMUTABLE', 'VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['VALOR_NUMERICO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores',
    operationId: 'listarValoresCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores',
    operationId: 'crearValorCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['VALOR_LISTA_LIMITE_EXCEDIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}',
    operationId: 'actualizarValorCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/desactivar',
    operationId: 'solicitarDesactivacionValorCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VALOR_LISTA_EN_USO', 'BAJA_MAESTRA_EN_PROCESO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas/{caracteristicaId}/valores/{valorId}/reactivar',
    operationId: 'reactivarValorCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas/{caracteristicaId}/desactivar',
    operationId: 'desactivarCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['BAJA_MAESTRA_EN_PROCESO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/caracteristicas/{caracteristicaId}/reactivar',
    operationId: 'reactivarCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/tipos-producto',
    operationId: 'listarTiposProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/tipos-producto',
    operationId: 'crearTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/tipos-producto/{tipoProductoId}',
    operationId: 'obtenerTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TIPO_PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/tipos-producto/{tipoProductoId}/desactivar',
    operationId: 'solicitarDesactivacionTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TIPO_PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['BAJA_MAESTRA_EN_PROCESO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/tipos-producto/{tipoProductoId}/reactivar',
    operationId: 'reactivarTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TIPO_PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas',
    operationId: 'obtenerEsquemaTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TIPO_PRODUCTO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas',
    operationId: 'asociarCaracteristicaTipoProducto',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TIPO_PRODUCTO_NO_ENCONTRADO', 'CARACTERISTICA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['ASOCIACION_DUPLICADA', 'VERSION_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LIMITE_CARACTERISTICAS_EXCEDIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas/{caracteristicaId}',
    operationId: 'actualizarAsociacionTipoCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['ASOCIACION_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/tipos-producto/{tipoProductoId}/caracteristicas/{caracteristicaId}/desasociar',
    operationId: 'solicitarDesasociacionTipoCaracteristica',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['ASOCIACION_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'ASOCIACION_EN_USO',
          'BAJA_MAESTRA_EN_PROCESO',
          'VERSION_CONFLICT',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/marcas/{marcaId}',
    operationId: 'obtenerMarcaAdmin',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['MARCA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/marcas/{marcaId}',
    operationId: 'actualizarMarca',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['multipart/form-data'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['MARCA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['MARCA_DUPLICADA', 'VERSION_CONFLICT'],
        headers: [],
      },
      '413': {
        types: ['application/problem+json'],
        codes: ['LOGO_EXCEDE_LIMITE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LOGO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/marcas/{marcaId}/desactivar',
    operationId: 'solicitarDesactivacionMarca',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['MARCA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: [
          'ENTIDAD_MAESTRA_CON_PRODUCTOS_ACTIVOS',
          'BAJA_MAESTRA_EN_PROCESO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/marcas/{marcaId}/reactivar',
    operationId: 'reactivarMarca',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['MARCA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/taxonomia/operaciones/{operationId}',
    operationId: 'obtenerOperacionMaestra',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['OPERACION_MAESTRA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}/seo',
    operationId: 'obtenerSeoCategoriaAdmin',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/categorias/{categoriaId}/seo',
    operationId: 'actualizarSeoCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['SLUG_DUPLICADO'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['METADATOS_SEO_INVALIDOS'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias/{categoriaId}/seo/historial',
    operationId: 'listarHistorialSlugCategoria',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CATEGORIA_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/skus/{sku}/programaciones',
    operationId: 'listarProgramacionesPrecioSku',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/precios/skus/{sku}/programaciones',
    operationId: 'programarPrecioSku',
    service: 'pricing-svc',
    security: ['userBearer'],
    role: 'GESTOR_COMERCIAL',
    introspection: true,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION', 'MOTIVO_CAMBIO_REQUERIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VIGENCIA_SUPERPUESTA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PRECIO_INVALIDO', 'OFERTA_INVALIDA', 'SCOPE_PRECIO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/precios/importaciones/prevalidar',
    operationId: 'prevalidarImportacionPrecios',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['multipart/form-data'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_INVALIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '413': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_EXCEDE_LIMITE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PLANTILLA_INCOMPATIBLE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/precios/importaciones',
    operationId: 'crearImportacionPrecios',
    service: 'pricing-svc',
    security: ['userBearer'],
    role: 'GESTOR_COMERCIAL',
    introspection: true,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['multipart/form-data'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_INVALIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '413': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_EXCEDE_LIMITE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PLANTILLA_INCOMPATIBLE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/importaciones/{batchId}',
    operationId: 'obtenerImportacionPrecios',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/importaciones/{batchId}/reporte',
    operationId: 'descargarReporteImportacionPrecios',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['text/csv'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/auditoria-precios',
    operationId: 'listarAuditoriaPrecios',
    service: 'price-audit-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/auditoria-precios/{auditId}',
    operationId: 'obtenerAuditoriaPrecio',
    service: 'price-audit-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['AUDITORIA_PRECIO_NO_ENCONTRADA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/auditoria-precios/exportaciones',
    operationId: 'crearExportacionAuditoriaPrecios',
    service: 'price-audit-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['LIMITE_EXPORTACION_AUDITORIA_EXCEDIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/auditoria-precios/exportaciones/{exportId}',
    operationId: 'obtenerExportacionAuditoriaPrecios',
    service: 'price-audit-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/auditoria-precios/exportaciones/{exportId}/archivo',
    operationId: 'descargarExportacionAuditoriaPrecios',
    service: 'price-audit-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['text/csv', 'application/pdf'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/plantilla',
    operationId: 'descargarPlantillaProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: [
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/carga-masiva/productos/importaciones',
    operationId: 'crearImportacionGeneralProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['multipart/form-data'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_INVALIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '413': {
        types: ['application/problem+json'],
        codes: ['ARCHIVO_EXCEDE_LIMITE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PLANTILLA_INCOMPATIBLE', 'CONTENIDO_ACTIVO_NO_PERMITIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/importaciones/{batchId}',
    operationId: 'obtenerImportacionGeneralProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/importaciones/{batchId}/reporte',
    operationId: 'descargarReporteImportacionGeneral',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['text/csv'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/carga-masiva/productos/importaciones/{batchId}/reanudar',
    operationId: 'reanudarImportacionGeneral',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/carga-masiva/productos/exportaciones',
    operationId: 'crearExportacionGeneralProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '202': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/exportaciones/{exportId}',
    operationId: 'obtenerExportacionGeneralProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/carga-masiva/productos/exportaciones/{exportId}/archivo',
    operationId: 'descargarExportacionGeneralProductos',
    service: 'bulk-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: [
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['LOTE_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/umbrales',
    operationId: 'obtenerUmbralesInventario',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PUT',
    path: '/api/v1/inventario/umbrales/global',
    operationId: 'actualizarUmbralGlobal',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PUT',
    path: '/api/v1/inventario/umbrales/skus/{sku}',
    operationId: 'establecerUmbralSku',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SKU_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'DELETE',
    path: '/api/v1/inventario/umbrales/skus/{sku}',
    operationId: 'eliminarUmbralSku',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '204': {
        types: [],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['SKU_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/dashboard',
    operationId: 'obtenerDashboardInventario',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/categorias/administracion',
    operationId: 'listarCategoriasAdmin',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/marcas/administracion',
    operationId: 'listarMarcasAdmin',
    service: 'taxonomy-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/promociones/administracion',
    operationId: 'listarPromocionesAdmin',
    service: 'promotions-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/productos/{productoId}',
    operationId: 'obtenerPrecioBaseProducto',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'PATCH',
    path: '/api/v1/precios/productos/{productoId}',
    operationId: 'actualizarPrecioBaseProducto',
    service: 'pricing-svc',
    security: ['userBearer'],
    role: 'GESTOR_COMERCIAL',
    introspection: true,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION', 'MOTIVO_CAMBIO_REQUERIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VERSION_CONFLICT', 'VIGENCIA_SUPERPUESTA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'PRECIO_INVALIDO',
          'OFERTA_INVALIDA',
          'ACCION_OFERTA_INVALIDA',
          'SCOPE_PRECIO_INVALIDO',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/precios/productos/{productoId}/programaciones',
    operationId: 'listarProgramacionesPrecioProducto',
    service: 'pricing-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/precios/productos/{productoId}/programaciones',
    operationId: 'programarPrecioBaseProducto',
    service: 'pricing-svc',
    security: ['userBearer'],
    role: 'GESTOR_COMERCIAL',
    introspection: true,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION', 'MOTIVO_CAMBIO_REQUERIDO'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['PRECIO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['VIGENCIA_SUPERPUESTA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['PRECIO_INVALIDO', 'OFERTA_INVALIDA', 'SCOPE_PRECIO_INVALIDO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/incidencias',
    operationId: 'reportarIncidenciaInventario',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:incidencias:reportar',
    audience: 'api-productos',
    clients: ['modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '201': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT', 'STOCK_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'CANTIDAD_INVALIDA',
          'SKU_NO_ENCONTRADO',
          'SKU_INACTIVO',
          'UBICACION_NO_ENCONTRADA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/incidencias/{incidenciaId}/resolver',
    operationId: 'resolverIncidenciaInventario',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:incidencias:resolver',
    audience: 'api-productos',
    clients: ['modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['INCIDENCIA_NO_ENCONTRADA'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT', 'INCIDENCIA_NO_ACTIVA'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['RESOLUCION_INCIDENCIA_INVALIDA', 'CANTIDAD_INVALIDA'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/reintegros',
    operationId: 'reintegrarInventario',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:reintegrar',
    audience: 'api-productos',
    clients: ['modulo-ventas', 'modulo-postventa'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'REINTEGRO_NO_APLICABLE',
          'CANTIDAD_INVALIDA',
          'SKU_NO_ENCONTRADO',
          'UBICACION_NO_ENCONTRADA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/conciliaciones-offline',
    operationId: 'conciliarVentaOffline',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:conciliar-offline',
    audience: 'api-productos',
    clients: ['modulo-ventas'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'CANTIDAD_INVALIDA',
          'SKU_NO_ENCONTRADO',
          'SKU_INACTIVO',
          'UBICACION_NO_ENCONTRADA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/traslados',
    operationId: 'listarTrasladosInventario',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/traslados/{trasladoId}',
    operationId: 'obtenerTrasladoInventario',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TRASLADO_NO_ENCONTRADO'],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/traslados/{trasladoId}/recepciones',
    operationId: 'registrarRecepcionTrasladoInventario',
    service: 'inventory-svc',
    security: ['userBearer'],
    introspection: false,
    headers: [
      {
        name: 'idempotency-key',
        required: true,
        minLength: 8,
        maxLength: 128,
      },
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['TRASLADO_NO_ENCONTRADO'],
        headers: [],
      },
      '409': {
        types: ['application/problem+json'],
        codes: ['IDEMPOTENCY_CONFLICT', 'TRASLADO_NO_RECIBIBLE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: [
          'CANTIDAD_RECIBIDA_EXCEDE_TRASLADO',
          'DISPOSICION_RECEPCION_INVALIDA',
        ],
        headers: [],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/productos/codigos-barras/resolver',
    operationId: 'resolverCodigoBarras',
    service: 'catalog-svc',
    security: ['serviceBearer'],
    scope: 'catalogo:leer',
    audience: 'api-productos',
    clients: ['modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: ['CODIGO_BARRAS_NO_ENCONTRADO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/disponibilidad/comercial',
    operationId: 'consultarDisponibilidadComercial',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:disponibilidad:leer',
    audience: 'api-productos',
    clients: [
      'modulo-marketplace',
      'modulo-chatbot',
      'modulo-retail',
      'modulo-productos',
    ],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
  {
    method: 'GET',
    path: '/api/v1/inventario/operaciones/{operationId}',
    operationId: 'consultarOperacionInventario',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:operaciones:leer',
    audience: 'api-productos',
    clients: ['modulo-ventas'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: [],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
      '404': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: [],
        headers: [],
      },
    },
  },
  {
    method: 'POST',
    path: '/api/v1/inventario/disponibilidad/comercial/verificar',
    operationId: 'verificarCantidadComercial',
    service: 'inventory-svc',
    security: ['serviceBearer'],
    scope: 'inventario:disponibilidad:leer',
    audience: 'api-productos',
    clients: ['modulo-marketplace', 'modulo-chatbot', 'modulo-retail'],
    introspection: false,
    headers: [
      {
        name: 'x-correlation-id',
        required: false,
      },
    ],
    requestTypes: ['application/json'],
    responses: {
      '200': {
        types: ['application/json'],
        codes: [],
        headers: [],
      },
      '400': {
        types: ['application/problem+json'],
        codes: ['VALIDACION'],
        headers: [],
      },
      '401': {
        types: ['application/problem+json'],
        codes: ['TOKEN_INVALIDO'],
        headers: [],
      },
      '403': {
        types: ['application/problem+json'],
        codes: ['SCOPE_INSUFICIENTE'],
        headers: [],
      },
      '422': {
        types: ['application/problem+json'],
        codes: ['CONTEXTO_ABASTECIMIENTO_INVALIDO'],
        headers: [],
      },
      '429': {
        types: ['application/problem+json'],
        codes: ['RATE_LIMIT_EXCEDIDO'],
        headers: ['retry-after'],
      },
      '500': {
        types: ['application/problem+json'],
        codes: ['ERROR_INTERNO'],
        headers: [],
      },
      '503': {
        types: ['application/problem+json'],
        codes: ['SERVICIO_NO_DISPONIBLE'],
        headers: [],
      },
    },
  },
];
