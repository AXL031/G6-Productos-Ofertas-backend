# G6 — Productos y Ofertas (Backend Monorepo)

Monorepo NestJS oficial con TypeScript y npm para el backend de **Productos y Ofertas (G6)**.

> **IMPORTANTE PARA DESARROLLADORES Y AGENTES:**
> Es obligatorio leer [AGENTS.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/master/AGENTS.md) completo antes de abordar cualquier Issue o editar cualquier archivo.

Repositorio de documentación normativa: [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs)

---

## 1. Ramas de Trabajo y Ownership

El repositorio utiliza **seis ramas personales permanentes**, una por integrante del equipo. No se crean ramas por tarea (`feat/...`, `fix/...`). Cada desarrollador implementa sus Issues y abre Pull Requests hacia `master` exclusivamente desde su rama asignada:

| Rama | Desarrollador | Aplicaciones Propias Autorizadas |
|---|---|---|
| `castilla` | Castilla | `apps/bulk-svc`, `apps/combos-svc` |
| `poma` | Poma | `apps/catalog-svc` |
| `cueva` | Cueva | `apps/promotions-svc` |
| `lopez` | Lopez | `apps/taxonomy-svc` |
| `vera` | Vera | `apps/pricing-svc`, `apps/price-audit-svc` |
| `taco` | Taco | `apps/inventory-svc` |

*Nota:* `apps/api-gateway` es transversal y requiere Issue explícito y coordinación. La rama `infra/foundation` (PR #2) es una excepción temporal de inicialización y no forma parte del flujo de desarrollo regular. Consulta la matriz detallada y reglas de gobernanza en [AGENTS.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/master/AGENTS.md#3-matriz-de-ownership-de-aplicaciones).

---

## 2. Requisitos de Entorno

- **Node.js:** `^22.22.3 || >= 24.15.0` (fijado en `.nvmrc` y `.node-version` a `v24.15.0`)
- **npm:** `>= 10.0.0`
- **TypeScript:** `6.x`

---

## 3. Instalación

Instalación limpia y reproducible desde `package-lock.json`:

```bash
npm ci
```

---

## 4. Microservicios del Monorepo

| Aplicación | Puerto por defecto | Variable de Entorno | Responsabilidad |
|---|---|---|---|
| `api-gateway` | `3000` | `API_GATEWAY_PORT` | Entrada/BFF, enrutamiento, agregación de lecturas |
| `catalog-svc` | `3001` | `CATALOG_SVC_PORT` | Productos, variantes, SKU, atributos, imágenes, estados |
| `pricing-svc` | `3002` | `PRICING_SVC_PORT` | Precios regulares/oferta, vigencias, canal, versiones |
| `price-audit-svc` | `3003` | `PRICE_AUDIT_SVC_PORT` | Auditoría de precios, registro append-only, exportación |
| `promotions-svc` | `3004` | `PROMOTIONS_SVC_PORT` | Promociones, cupones, cross-sell y upsell |
| `inventory-svc` | `3005` | `INVENTORY_SVC_PORT` | Saldos, reservas, consumo, liberación, ajustes, Kardex |
| `taxonomy-svc` | `3006` | `TAXONOMY_SVC_PORT` | Categorías, marcas, características, tipos y SEO |
| `combos-svc` | `3007` | `COMBOS_SVC_PORT` | Definición, composición y proyección de combos |
| `bulk-svc` | `3008` | `BULK_SVC_PORT` | Importación y exportación masiva, validación por fila |

*Estado actual:* La Foundation (PR #2) provee arranque independiente y endpoints de salud (`GET /health`). No contiene endpoints de negocio simulados ni conexiones externas activas.

---

## 5. Scripts de Ejecución y Desarrollo

### Iniciar microservicios

Se distinguen claramente dos modos de ejecución:

1. **Modo Desarrollo con hot-reload / watch:**
   ```bash
   npm run start:dev:catalog-svc
   npm run start:dev:inventory-svc
   # O cualquier otro servicio: npm run start:dev:<servicio>
   ```

2. **Ejecutar JavaScript previamente compilado (producción / runtime):**
   ```bash
   npm run build:all               # O compilación individual: npm run build:catalog-svc
   npm run start:catalog-svc       # Ejecuta node dist/apps/catalog-svc/main.js
   npm run start:inventory-svc     # Ejecuta node dist/apps/inventory-svc/main.js
   ```

### Calidad de Código y Pruebas

```bash
# Verificación de tipos TypeScript estricto
npm run typecheck

# Linter rápido (oxlint)
npm run lint

# Formato y verificación Prettier
npm run format
npm run format:check

# Pruebas unitarias (vitest)
npm test

# Pruebas e2e / health endpoints (vitest)
npm run test:e2e
```

---

## 6. Variables de Entorno

Copiar `.env.example` a `.env` para personalizar puertos locales:

```bash
cp .env.example .env
```

---

## 7. Flujo de Trabajo

Para colaborar en este repositorio, revisa la guía de contribución en [CONTRIBUTING.md](./CONTRIBUTING.md) y las normas en [AGENTS.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/master/AGENTS.md).

## Integración G1 Marketplace — Hito 4

El punto obligatorio de entrada para cambios Backend relacionados con G1 es [`integraciones/g1-marketplace/README.md`](integraciones/g1-marketplace/README.md). Incluye M-01–M-09 aceptados por G6 y comunicados a G1, matriz operación/owner/estado, pruebas y evidencia. La autoridad contractual permanece en Docs [Acuerdo H4](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/a8d89296b0eac37315ef30a9390f1e4e30933136/integraciones/ACUERDO_G1_G6_H4_2026-10-20.md) y [OpenAPI](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/contratos/http/openapi.yaml). Los servicios no deben describirse como únicamente scaffolds: cada capacidad se califica por operación y por SHA, con límites documentados en su ficha.
