# Desarrollo funcional local — Promotions

Rama `cueva`, 01/11/2026. Configuración para desarrollar funcionalidad dejando G7 pendiente, según instrucción de Axel. Estado completo por issue: [AVANCE-ISSUES-2026-11-01.md](AVANCE-ISSUES-2026-11-01.md).

## Inicio local sin JWT

Con PostgreSQL/TLS propio configurado y disponible:

```powershell
$env:NODE_ENV = 'development'
$env:GATEWAY_DEMO_NO_AUTH_ENABLED = 'true'
npm run build:promotions-svc
npm run start:promotions-svc
```

Se reutiliza el flag existente. El listener se fija a `127.0.0.1` y el guard comprueba el par TCP loopback. Requiere NODE_ENV explícito development/test; producción o entorno omitido rechazan el arranque con demo activa. Esto no habilita Oracle ni acredita una demo compartida.

Las 22 operaciones conservan sus validaciones, correlación, transacciones y reglas. No se instala una identidad ficticia. El modo normal sigue siendo autenticado, sin fallback a demo ante fallo de G7.

## Conectar los proveedores HTTP desarrollados

Promotions reutiliza estas variables existentes para configurar los orígenes salientes:

| Variable                    | Destino                                |
| --------------------------- | -------------------------------------- |
| `GATEWAY_CATALOG_SVC_URL`   | Catálogo: producto y contexto SKU      |
| `GATEWAY_PRICING_SVC_URL`   | Pricing: precio por SKU/canal/instante |
| `GATEWAY_INVENTORY_SVC_URL` | Inventario: disponibilidad comercial   |
| `GATEWAY_TAXONOMY_SVC_URL`  | Taxonomía: categoría administrativa    |

Usar el origen completo con puerto, sin `/api/v1`, ruta, credenciales, query ni fragmento. En demo solo se admiten loopback o el alias exacto del servicio correspondiente (catalog-svc, pricing-svc, inventory-svc, taxonomy-svc). Los proveedores deben estar levantados y permitir la demo restringida; no se cambian sus permisos desde Promotions.

Con Catálogo/Pricing/Inventario completos se registra HttpCommercialContext para evaluación, validación de cupón y recomendaciones. Con Catálogo/Taxonomía completos se registra HttpAdminReferences para alta/edición/activación de promociones y reglas. Si falta la configuración requerida, la operación conserva 503. El arranque y las operaciones que no necesitan esas fuentes pueden avanzar independientemente.

El cliente usa respuestas reales; no genera precios, productos ni stock de muestra. Los campos se validan antes de guardar o calcular. Un 404 solo se interpreta como referencia no aplicable si corresponde al código contractual; un 503, DTO corrupto o timeout es un fallo técnico. Las lecturas tienen plazo total de 2500 ms y cancelación.

En modo autenticado, PROMOTIONS_SERVICE_TOKENS es el punto interno para conectar posteriormente la identidad propia modulo-productos, audiencia api-productos y scopes de las operaciones. Actualmente falta el proveedor G7 real: se falla sin reenviar el token del usuario ni pasar silenciosamente a demo.

## Trabajo que sigue aislado

- Composición multibeneficio HTTP: aceptación de consumidores y límites operativos pendientes; motor interno conservado.
- AMQP: cuatro adaptadores rc.4 registrados, pero consumidor/pump protegidos hasta resolver fuente de reserva/snapshot, procedencia/ACL/red y pruebas bilaterales. Demo HTTP no activa AMQP.
- DATA: propuesta y tests disponibles; falta aprobación BD/Marco y datos comerciales vigentes antes de cargar.
- Entorno compartido: faltan providers conformes, URLs/datos revisados y evidencia por SHA. La validación local no acredita despliegue.

## Evidencia local

310 pruebas unitarias de Promotions, 1039 unitarias generales y 397 E2E PASS. PostgreSQL/TLS con runtime restringido verifica 20 grupos, incluidos proveedores HTTP reales del módulo con servidores fixture explícitos y los cuatro eventos H4. PostgreSQL/RabbitMQ desechables verifican otros 23 grupos.

El recorrido existente en navegador también se ejecutó: React → Gateway → Promotions → PostgreSQL, con persistencia tras recarga y errores visibles. Una prueba del harness comercial y cinco de la entrada real de la aplicación pasaron. La sesión usa un proveedor G7 fixture contractual descartable; no se probó G7 compartido. No se modificó el frontend ni el Gateway.

Los contratos son Docs `5124eeae4ec65b22ea9146cd7b1ce3888c617c10`, OpenAPI rc.2 / AsyncAPI rc.4. Las pruebas no habilitan datos, permisos ni despliegue compartidos.
