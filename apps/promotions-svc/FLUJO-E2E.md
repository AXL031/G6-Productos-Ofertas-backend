# Paso 6 — #78: flujo completo local de Promotions

Owner Axel Cueva, rama `cueva`. Implementación de pruebas locales completada;
integración compartida/homologación/despliegue pendientes por frontera concreta.
Fuentes: Docs G6 `1ee0d9e5a788dbe559a376bf96a60c6117af3956`, OpenAPI
0.6.0-rc.1, AsyncAPI 0.6.0-rc.3, SPEC-005/006/007 y DEC-F-007/008/009/012;
G7 `bf819dd216294f5e2d5d8d4d73b60554dc9d7b62`, OpenAPI/SPEC-06/FRONT-00/H-11.

## Una ejecución reproducible

Requiere Docker activo, dependencias instaladas, Chromium Playwright del
Frontend, migraciones oficiales cacheadas según PERSISTENCE.md y Python con
cryptography para generar certificados descartables. No utiliza `.env`
compartidos, Supabase, RabbitMQ Oracle ni credenciales personales.

```powershell
npm run build:all
$env:G6_TEST_PYTHON = '<python con cryptography>'
$env:G6_PROMOTIONS_FRONTEND_ROOT = (Resolve-Path '../G6-Productos-Ofertas-frontend').Path
$env:G6_PROMOTIONS_E2E_OUTPUT_DIR = '<carpeta local para evidencia>'
node apps/promotions-svc/test/flow.isolated.e2e.mjs
```

El runner exige el Frontend con su prueba de sesión: no permite acreditar el
paso omitiendo el navegador. Ejecuta primero Gateway/PG/UI y después PG/AMQP.
`flow-evidence.json` conserva ambos resultados, SHAs, ramas, estado del árbol,
hash SHA256 por archivo de los alcances ejecutados y hash agregado. Si cambian
los archivos o los commits durante la ejecución, falla. Un árbol MODIFIED no
se declara una ejecución limpia de HEAD. Los contenedores/certificados y
procesos se eliminan al finalizar por los runners correspondientes.

## Recorridos y autoridades reales

| Recorrido | Qué se ejecuta realmente | Frontera explícita de prueba |
| --- | --- | --- |
| HTTP/PG existente | Providers, repositorios, funciones oficiales, permisos TLS restringidos, CRUD y errores contractuales. | Referencias/hechos comerciales de escenarios aislados no prueban fuentes compartidas. |
| React/Gateway existente | Páginas reales, Gateway y Promotions nativos, JWT RS256/JWKS HTTPS y PG/TLS real. | Harness anterior con token sintético sigue separado y conservado. |
| Sesión desde main | `src/main.tsx`, G7Session, gate, páginas, HTTP real, Gateway/Promotions sin overrides, PostgreSQL real. | Solo G7 es proveedor HTTPS de contrato descartable; no representa G7 implementado ni homologado. |
| Consumo/restauración | Mensajes contractuales v2 por RabbitMQ real, handler, evidencia autoritativa propia, repositorios/función SQL, Inbox/receipt/Outbox y confirms. | Fuente externa de reserva/snapshot es fixture explícito; actor guest→Ventas solo se mapea dentro del broker descartable. |

La aplicación del nuevo recorrido de sesión **no recibe tokens inyectados**,
no intercepta HTTP con Playwright ni usa su harness. Las URLs se configuran en
Vite temporal; `/api` lleva al Gateway real y `/g7` al issuer de prueba con TLS
verificado mediante su CA, sin `secure:false`, ignorar certificados ni cambios
en configuración productiva. Los servicios verifican firma/issuer/rol reales.

Cinco pruebas adicionales comprueban:

1. Error de credenciales, login, crear/editar/activar cupón por Gateway/PG,
   normalización, 409 que conserva entradas, recarga con nuevo login y logout.
2. MFA no llama a la API antes de enviar/verificar el código; un código erróneo
   no inicia sesión. Tras verificar lee el cupón persistido en PostgreSQL.
3. Un JWT verdaderamente expirado es rechazado por el Gateway con 401; el
   cliente renueva una sola vez y obtiene 200. Logout usa el token rotado.
4. Refresh revocado devuelve al login sin bucle ni datos mock.
5. Usuario firmado con rol CLIENTE recibe 403 real y escritura deshabilitada.

El issuer de prueba cuenta login, OTP, refresh, logout y reuso: las aserciones
exigen un número exacto de llamadas y cero reutilizaciones. Nunca persiste sus
tokens o contraseñas en logs; los diagnósticos se sanitizan. Capturas a 1440×900.
Administrar/consultar no cambia usos, receipts, Inbox ni Outbox: se compara SQL
antes y después de todos los recorridos de navegador.

## Consistencia por RabbitMQ y PostgreSQL

Se conservan todos los casos previos. La ampliación integra la clase real
`AuthoritativeCouponEvidence` con entregas y resultados del broker real:

- Consumo con alcance/mínimo verificados y último cupo serializado.
- Pérdida de ACK después del commit, reentrega real y replay con otro
  message_id: mismo resultado/uso y ninguna recarga de evidencia.
- ACK observa receipt, Inbox y Outbox durables desde otra conexión.
- Restauración y segunda operación de restauración preservan historial y fecha;
  después solo se puede reutilizar el cupo una vez.
- Mínimo insuficiente produce rechazo contractual durable sin consumir.
- Publicación de todos los resultados por Outbox con confirms/persistencia;
  lo recibido coincide exactamente con el payload SQL y no quedan filas pendientes.

Estas escrituras ocurren únicamente en las bases y broker descartables. El
runtime y pump productivos permanecen desactivados/protegidos; no se cambia
ningún provider, permiso, contrato, migración o configuración compartida.

## Dimensiones pendientes, sin bloquear el flujo local

| Owner | Frontera | Desbloqueo verificable |
| --- | --- | --- |
| G7 + integración G6 | Sesión externa autenticada | URL operativa, CORS/orígenes, issuer/JWKS/roles reales y ejecución autenticada repetible con ese entorno. |
| G5, Inventario/Taco + Marco/G7 | Evidencia externa #33 | Fuente contractual autorizada de reserva/snapshot desde las referencias del comando, condiciones durables completas e identidad/grants propios. No convertir reservation_id en operationId ni suplantar a Ventas. |
| Poma/Vera/Taco + Marco | Decoders productivos #75 y referencias comerciales | Campos/versiones/snapshot publicados y fuentes autorizadas; prueba con productores/handlers reales. No se reemplaza GenericData por campos fixture. |
| Infra/Marco #29 y G5 | AMQP compartido | ACL/red/identidad/vhost/bindings y recuperación acordados, más prueba bilateral. |
| Marco/infra #111 | E2E Oracle | Autorización individual de SHA/imagen/destino y prueba del entorno desplegado. |

Estado por dimensión en el JSON: `localFlow=PASS/FAIL`,
`authenticatedExternal=NOT_EXECUTED`, `homologation=NOT_DONE`,
`deployment=NOT_EXECUTED`. Un PASS local no cierra el issue ni concede
autorización para merge/despliegue.
