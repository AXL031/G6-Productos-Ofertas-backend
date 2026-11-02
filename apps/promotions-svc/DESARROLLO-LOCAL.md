# Desarrollo funcional local — Promotions

Rama `cueva`. Revisión H4 vigente: [H4-REVISION-2026-11-02.md](H4-REVISION-2026-11-02.md). El avance del 01/11 se conserva como antecedente; no acredita el estado actual del entorno compartido.

## Inicio local sin JWT

Con PostgreSQL/TLS propio configurado y disponible:

```powershell
$env:NODE_ENV = 'development'
$env:GATEWAY_DEMO_NO_AUTH_ENABLED = 'true'
npm run build:promotions-svc
npm run start:promotions-svc
```

Se reutiliza `GATEWAY_DEMO_NO_AUTH_ENABLED`, deshabilitado por defecto. Con demo explícita y NODE_ENV development/test el listener sigue en `127.0.0.1`. En NODE_ENV production escucha en `0.0.0.0` para permitir contenedores separados; el guard solo admite loopback o la dirección privada del alias fijo `g6-api-gateway`, resuelto desde el contenedor, comparada con el par TCP real. DNS ausente, público, no coincidente o sin respuesta en 500 ms deniega acceso. No se usan cabeceras de identidad/IP como autorización. Un entorno omitido no permite activar demo.

Antes de activar en Oracle, Marco debe verificar el perímetro Caddy/Tailscale del Gateway, la propiedad del alias DNS y la red privada `g6-http`, sin puertos de negocio publicados directamente. El flag no prueba aislamiento ni autoriza despliegue. No se añaden variables ni permisos globales. Quitar el flag restablece JWT en los mismos handlers; issuer/JWKS ausentes o inválidos fallan cerrados. La suite de imagen incluye `test/restricted-demo.container.smoke.mjs`, con dos pares TCP reales y NODE_ENV production; no certifica el perímetro remoto.

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
