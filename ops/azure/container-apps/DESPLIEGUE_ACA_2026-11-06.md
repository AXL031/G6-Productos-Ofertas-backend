# Azure Container Apps — despliegue y validación parcial, 2026-11-06

Los nueve servicios y Caddy están desplegados en Chile Central, entorno WorkloadProfiles con solamente Consumption. La certificación funcional completa sigue pendiente.

SHA oficial de aplicación: `3f685dbcb616daad3414039059396823a0a0a9a2`. CI posterior: [19/19 satisfactorias](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/42261665995). Los nueve digests y workflows están en [official-release-3f685dbcb6.json](official-release-3f685dbcb6.json). Azure ejecuta esas mismas imágenes oficiales por digest.

Base HTTPS: https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io

## Catalog y Taxonomy: cinco lecturas verificadas

Se compararon anónimamente contra la VM: 5/5 HTTP 200 y JSON idéntico. Después de confirmar la desasignación de la VM se repitieron las cinco: 5/5 HTTP 200, sin reintentos. Los productos reales ya estaban publicados; no se modificaron datos ni estados desde este despliegue.

- https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1/categorias
- https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1/marcas
- https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1/productos?canal=MARKETPLACE
- https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1/productos/32a4172c-81b2-b643-1d0f-ae66f627f2ef?canal=MARKETPLACE
- https://api-gateway.calmgrass-aec0b33c.chilecentral.azurecontainerapps.io/api/v1/productos/por-slug/ent22-inka-athletics?canal=MARKETPLACE

La comparación registró arranques tras inactividad de 28–29 segundos en ACA para categorías/listado. Con los servicios despiertos, la verificación posterior respondió en 0.35–0.89 segundos. No es una prueba de carga ni garantía de latencia. minReplicas=0 y maxReplicas=1.

## VM anterior

`vm-g6-backend`, grupo `rg-g6-productos-azure`: estado confirmado `PowerState/deallocated`, por nueva autorización explícita del usuario después de verificar Catalog/Taxonomy. Se conservaron VM, discos e IP; no se creó otro apagado programado. La petición anterior de mantenerla encendida quedó sustituida por esta autorización.

## Bloqueos concretos

| Owner                                      | Operación o frontera                         | Evidencia / condición de desbloqueo                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vera / owner Price Audit                   | Lecturas y readiness                         | SQLSTATE 42703: falta `price_audit_log.target_type`. Revisar/aplicar mediante owner y ledger `apps/price-audit-svc/migrations/0002_typed_price_change.sql`; exige `po_price_audit_owner`. Repetir readiness y consultas.                                          |
| vera / owner Pricing                       | Programaciones por producto y readiness      | SQLSTATE 42703: falta `scheduled_prices.product_id`. Revisar migración `apps/pricing-svc/migrations/0002_schedule_effective_events.sql`. Readiness también exige `config.auth` aun en PUBLIC_READ_ONLY; revisar ese comportamiento sin inventar configuración G7. |
| castilla / owner Bulk                      | Lecturas de exportaciones                    | SQLSTATE 42703: falta `export_jobs.claim_token`. Revisar migración `apps/bulk-svc/migrations/0003_export_claim_lease.sql` y revalidar. No se aplicó.                                                                                                              |
| Responsable RabbitMQ + owners consumidores | Workers y readiness Bulk                     | Entregar AMQPS/topología/ACL reales y comprobar conexión; Bulk informa AMQP_DISABLED. Storage ya pasó prueba privada de escritura/lectura/eliminación de un CSV temporal, sin crear trabajos.                                                                     |
| Gateway/integración + Inventory (taco)     | consultarOperacionInventario, ID inexistente | Inventory devuelve 404 OPERACION_INVENTARIO_NO_ENCONTRADA internamente; Gateway publica 500. La proyección completa de columnas pasó. Revisar normalización/contrato de respuesta, no atribuirlo al esquema sin evidencia.                                        |
| Owners / QA                                | Certificación de 65 lecturas                 | Las dos rondas HTTP están en el JSON de evidencia. Hay respuestas 200, casos 404 por datos inexistentes y fallos 503/500; no equivalen a 65 positivos funcionales. Faltan fixtures negativos y archivos/trabajos existentes para todas las descargas.             |

## Seguridad y dependencias verificadas

Catalog→Taxonomy por HTTPS desde el contenedor Catalog respondió 200, ocho categorías. Health de los nueve respondió 200. Readiness: Catalog/Taxonomy/Inventory/Combos 200; Pricing/Price Audit 503; Bulk 503 AMQP_DISABLED; Promotions no implementa endpoint HTTP de readiness. No se sustituyó por liveness.

Las escrituras anónimas de Catalog y Taxonomy respondieron 401; ruta desconocida y producto/slug inexistentes 404. Un JWT inválido suministrado recibió 503 con G7 sin configurar: acceso denegado, sin fallback anónimo; no se presenta como certificación completa de errores JWT ni homologación G7. El emisor simulado sigue exclusivamente local.

La selección sigue siendo 65 (59 GET + seis POST de consulta). prevalidarImportacionPrecios está excluida. Los filtros comerciales permanecen; no se publicaron borradores por SQL.

## Configuración efectiva, evidencia y rollback

[deployment-evidence-3f685dbcb6.json](deployment-evidence-3f685dbcb6.json) contiene estados, imágenes efectivas, métricas observadas, resultados HTTP y comparación VM/ACA, sin credenciales ni parámetros runtime. Las configuraciones privadas, CA y release.psv permanecen fuera de Git.

Solo Gateway tiene ingress externo. Los ocho servicios usan ingress interno HTTPS, PostgreSQL verify-full y CA montada. No hay Log Analytics creado ni perfiles Dedicated. La reserva máxima configurada es 2.5 vCPU / 5 GiB incluyendo Caddy. Las métricas son observaciones de estas comprobaciones, no homologación de capacidad.

Se preparó y validó una propuesta adicional de CORS wildcard y timeout de 60 s, pero la revisión automática rechazó su activación/reinicio por requerir autorización específica. No se ejecutó. Se retiró del código y del plan operativo; el Gateway conserva timeout 30 s y Caddy 45 s. Ambos entornos devolvieron las mismas cabeceras CORS ausentes. No se acredita integración desde un navegador de Marketplace.

Rollback: conservar SHA/digests y configuración privada; antes de otro despliegue registrar la revisión activa, aplicar únicamente artefactos oficiales autorizados y comprobar health/readiness/HTTPS después de redirigir tráfico o restaurar configuración. La VM anterior está conservada y desasignada; su reactivación requiere una decisión operativa autorizada. No se ejecutó un ensayo real de rollback ni se afirma que exista otra release oficial compatible de los nueve servicios.

Estado: **PARTIAL** para la migración/certificación global; **PASS** para despliegue de nueve aplicaciones y para equivalencia HTTP de las cinco lecturas Catalog/Taxonomy con la VM desasignada.
