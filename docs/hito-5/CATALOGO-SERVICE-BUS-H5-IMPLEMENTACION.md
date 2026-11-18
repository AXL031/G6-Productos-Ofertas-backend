# Catalog — integración Service Bus H5

## Resumen y estado

Esta entrega conecta el runtime H5 local de `catalog-svc` con NestJS, valida mensajes recibidos y crea entregas H5 a partir del Outbox dentro de la transacción PostgreSQL. H4 RabbitMQ sigue siendo el modo predeterminado. No se migraron recursos compartidos ni se habilitó tráfico Azure.

| Capacidad | Estado |
|---|---|
| Runtime Nest, ciclo de vida y readiness H5 | IMPLEMENTADO; falta validación con namespace/identidad reales |
| Receptor Peek-Lock e Inbox existente | IMPLEMENTADO; pruebas locales con doubles |
| Outbox de negocio + entregas por destino | IMPLEMENTADO en migración candidata; pendiente ensayo PostgreSQL desechable |
| Relay con lease, token e ID estable | IMPLEMENTADO; pendiente prueba PostgreSQL asociada a este SHA |
| Baja de SKU vendible de producto simple | IMPLEMENTADO desde `catalog.sku_identity`; pendiente prueba PostgreSQL |
| Bulk V1/V2 | Conservado en el handler existente |
| Bulk V3 claim-check | BLOQUEADO_ESPECÍFICO: falta una operación privada autenticada publicada por Bulk; no se inventa una ruta ni se entrega una clave de Storage a Catalog |
| Azure real, RBAC, homologación y despliegue | PENDIENTE_VERIFICACION |

Baseline de trabajo: Backend `master` `c5c19d3b0d19d75a9113083db89533d790b9b0a7`; Docs `master` `f0f8d123c1c9d984c90032827c6ccc94c000c7a0`, AsyncAPI `0.7.0-rc.1` (`SEMIFINAL_G6`). La rama `poma` se avanzó por fast-forward desde el master vigente. Los cambios locales preexistentes en `scripts/seed/mcp/catalog/` y el archivo no rastreado `apps/catalog-svc/prod-ca-2021.crt` se preservaron y no pertenecen a esta entrega.

## Arquitectura y selección de transporte

```text
Mutación Catalog
  └─ PostgreSQL transaction (negocio + Outbox)
       └─ trigger H5 condicionado por catalog.messaging_provider
            └─ outbox_delivery (message_id, destination)
                 └─ claim SKIP LOCKED + lease/token
                      └─ Service Bus Basic (fuera de la transacción)

Service Bus Peek-Lock
  └─ validar cuerpo, envelope y metadatos del broker
       └─ handlers Catalog + Inbox/efecto transaccional
            └─ commit PostgreSQL
                 └─ CompleteMessage
```

- Sin `MESSAGING_PROVIDER=AZURE_SERVICE_BUS`, se conserva H4 y el runtime H5 no se crea.
- H5 exige `SERVICE_BUS_NAMESPACE_FQDN` válido y usa `ManagedIdentityCredential`; no se proporciona namespace ni secreto ficticio.
- `CATALOG_H5_DESTINATIONS` es una allowlist de destinos salientes habilitados después de verificar cada consumidor; su valor predeterminado vacío no crea entregas de salida.
- H5 y AMQP son excluyentes. `CATALOG_AMQP_ENABLED=true` junto con H5 provoca error de configuración.
- En producción H5 también exige `G6_SECURITY_MODE=G7_AUTHENTICATED`.
- Nest crea los cuatro receivers al arrancar, inicia el relay y los cierra durante shutdown. Readiness falla si el runtime H5 seleccionado no está iniciado.
- El productor textual se valida contra la cola, pero no reemplaza RBAC/identidad del broker.

## Cobertura contractual Catalog

| Relación | Mensajes | Cola/handler Catalog | Estado local | Dependencia y gate |
|---|---|---|---|---|
| R01 Bulk → Catalog | `catalog.bulk.upsert.requested` | `g6.catalog.from.bulk` / `CatalogBulkService.consume` | V1/V2 conservados; V3 pendiente | Bulk (`castilla`): operación privada autenticada, autorización por trabajo, bytes/checksum/retención y E2E; Bulk no debe emitir V3 antes |
| R04 Catalog → Bulk | `catalog.bulk.upsert.completed`, `.rejected` | `g6.bulk.from.catalog` / Outbox trigger y relay | Implementado localmente | Consumidor/Inbox Bulk y rollback por destinatario listos |
| R05 Catalog → Combos | `catalog.product.deactivated`, `catalog.sku.deactivated` | `g6.combos.from.catalog` | Implementado localmente | Consumer H5 Combos y prueba de redelivery/rollback |
| R06 Catalog → Inventory | `catalog.sku.deactivated`, `inventory.sku.initialization.requested` | `g6.inventory.from.catalog` | Implementado localmente | Consumer H5 Inventory, RBAC y E2E |
| R07 Catalog → Pricing | `catalog.sku.deactivated`, `pricing.product.initialization.requested` | `g6.pricing.from.catalog` | Implementado localmente | Consumer H5 Pricing y E2E de ambos eventos |
| R08 Catalog → Promotions | `catalog.product.deactivated`, `catalog.sku.deactivated` | `g6.promotions.from.catalog` | Implementado localmente | Consumer H5 Promotions, idempotencia y rollback |
| R09 Catalog → Taxonomy | `catalog.master.deactivation.checked` | `g6.taxonomy.from.catalog` | Implementado localmente | Consumer H5 Taxonomy; verificar correlación/barrera |
| R11 Inventory → Catalog | `inventory.sku.initialization.completed`, `.rejected` | `g6.catalog.from.inventory` / `CatalogMessageService.consume` | Handler existente conectado | Outbox/Inbox y entrega Inventory, RBAC y E2E |
| R15 Pricing → Catalog | `pricing.product.initialization.completed`, `.rejected` | `g6.catalog.from.pricing` / `CatalogMessageService.consume` | Handler existente conectado | Outbox/Inbox y entrega Pricing, RBAC y E2E |
| R18 Taxonomy → Catalog | seis eventos Taxonomy | `g6.catalog.from.taxonomy` / handlers Taxonomy/Master | Handlers existentes conectados | Outbox/Inbox Taxonomy, correlación/versiones y E2E |

`catalog.product.deactivated` y `catalog.sku.deactivated` se guardan juntos cuando un producto simple se da de baja. El SKU vendible se obtiene de `catalog.sku_identity`; no se copia `sku_base`. Para variantes, solo se emite el SKU cambiado y el evento de producto solo si el padre transiciona.

## Persistencia y recuperación

La migración candidata `apps/catalog-svc/migrations-candidate/h5/0001_outbox_delivery.sql` crea la entrega por destinatario, índice parcial y trigger `catalog.enqueue_h5_outbox_deliveries`. El trigger crea las filas solo cuando la transacción ejecuta con proveedor H5; los Outbox históricos H4 no generan entregas. El par `(message_id, destination)` es único.

El relay reclama una fila con `FOR UPDATE SKIP LOCKED`, establece lease y token, publica fuera de la transacción y confirma solo si conserva el token. Cada intento y destino son independientes; un timeout conserva la identidad del mensaje. El receiver completa después del commit del handler. Mensajes malformados/permanentemente inválidos se envían a DLQ; excepciones de persistencia se abandonan para redelivery. Inbox, operaciones obsoletas y resultados terminales usan la lógica de Catalog ya existente.

No ejecutar esta migración en Supabase compartido desde esta entrega. El archivo permanece como candidata y requiere el preflight, autorización y procedimiento de despliegue aprobados.

## Cuerpo recibido y seguridad

El receptor admite `Uint8Array` (incluido Buffer), cadena JSON y objeto JSON decodificado, verifica UTF-8/JSON y limita el cuerpo a 256 KiB. Valida `contentType`, envelope, identidad de productor permitida por cola y coincidencia de `messageId`, `correlationId` y `subject`. El SDK real todavía requiere prueba contra el namespace vigente.

No se leen claves de Storage en Catalog. El contrato AsyncAPI V3 define `content_ref` (`content_id`, SHA-256, longitud y tipo), pero el contrato publicado no define la ruta/identidad de descarga privada. Responsable: Bulk (`castilla`). Desbloqueo: publicar y homologar esa operación interna, probar autorización por trabajo/404 uniforme/503, `Content-Length`, tamaño, tipo y SHA exactos, retención mínima y procesar las filas verificadas mediante el motor existente.

## Pruebas y evidencia

| Prueba | Comando | Resultado en esta entrega | Ambiente/límite |
|---|---|---|---|
| Unitarias Catalog | `npm test -- apps/catalog-svc/src/catalog-service-bus.spec.ts apps/catalog-svc/src/readiness.controller.spec.ts apps/catalog-svc/src/catalog-mutation.service.spec.ts` | PASS (3 archivos, 13 pruebas) | Local; doubles para Service Bus, no es SDK/Azure real |
| TypeScript monorepo | `npm run typecheck` | PASS | Local, rama `poma` después del fast-forward |
| Lint Backend | `npm run lint` | PASS (4 advertencias preexistentes en Bulk/Promotions fuera de Catalog) | Local |
| Build Catalog | `npm run build:catalog-svc` | PASS | Local |
| PostgreSQL trigger, claim concurrente, fallo ambiguo y recuperación | `docs/hito-4/probar-catalogo-postgres.ps1 -PostgresBin <directorio>` con `-IncludeH5` | BLOQUEADO_ENTORNO | No hay `pg_ctl.exe` disponible; no se ejecutó ni se usó una base compartida |
| Azure Service Bus, Managed Identity y RBAC | No ejecutada | PENDIENTE_VERIFICACION | No se proporcionó ambiente autorizado |

Las pruebas unitarias, typecheck, lint y build corresponden al árbol de trabajo final de esta entrega. El ensayo PostgreSQL no se pudo ejecutar en este entorno; Azure real, homologación y despliegue no se probaron.

## Preflight, habilitación y reversión

1. Verificar disponibilidad de los cuatro productores/consumidores por relación, colas preaprovisionadas, RBAC por identidad y límites Basic.
2. Aplicar la migración candidata mediante el procedimiento aprobado y comprobar permisos/readiness.
3. Ejecutar pruebas PostgreSQL de inserción atómica, fan-out, redelivery, lease vencido y confirmación tardía.
4. Desplegar con `MESSAGING_PROVIDER=RABBITMQ` (default histórico) hasta que exista aprobación explícita por flujo.
5. Habilitar H5 en un ambiente controlado con `SERVICE_BUS_NAMESPACE_FQDN`, identidad administrada autorizada y `G6_SECURITY_MODE=G7_AUTHENTICATED`; correr smoke, revisar backlog/DLQ y conciliar Inbox/Outbox.
6. Para revertir, detener escrituras/relay H5, conciliar cada `(message_id,destination)` con estado terminal del consumidor y reactivar H4 solo después de decidir los pendientes. No publicar por ambos brokers ni reenviar Outbox histórico H4 automáticamente.

La habilitación productiva permanece bloqueada por homologación/identidad Azure, y por los consumidores indicados en la matriz. No se ejecutó despliegue ni migración compartida.
