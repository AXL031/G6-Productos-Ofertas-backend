# Bloque 04 — Consultas comerciales en demo sin JWT

Fecha: 17 de octubre de 2026. Rama: `taco`. Base: `bcbc829`. Issues: [#25](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/25) y [#100](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/100). Estado final: **PARTIAL**, con implementación y validaciones locales terminadas para las dos operaciones comerciales.

## Fuentes y alcance

Se leyó completo `AGENTS.md`, se verificó rama/ownership y se consultaron los issues vigentes #25/#100 y la decisión demo de [#107](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/107). Docs local y master remoto: `c36bd9a18f4fdb188df0d7e5158a431cf4b4ea7b`; OpenAPI `0.6.0-rc.1`, `Contrato_Api.md` y DEC-F-002/005: autoridad única, disponibilidad comercial minimizada, resolución de una ubicación y verificación sin reserva/efectos.

Gateway master remoto verificado: `6bf7ddbfa3a66a1980313202f52109d7bab2f3ba` (merge de PR #130). La prueba usa su head preservado `32153bffb35daa8761272c7b55fe23dc1df70007`, descargado con fetch de ese SHA tras autorización de acceso de red. No se incorporaron commits ni se mezclaron ramas. El checkout local de Gateway conserva su código anterior; el artefacto de prueba se transpiló desde los objetos Git a una carpeta aislada bajo `dist/`.

Clasificación: `IMPLEMENTAR_PARCIAL`. Se habilitan únicamente los dos handlers comerciales explícitos en #25. El alcance de las restantes consultas de #100 y las escrituras sigue protegido; #107 permite reenviarlas sin JWT en Gateway, pero #25 exige preservar las operaciones restringidas upstream. No se fabrica un consumidor técnico, operador humano ni identidad a partir del canal para resolver esa frontera.

## Cambios realizados

- Flag `INVENTORY_DEMO_NO_AUTH_ENABLED`, apagado por defecto y validado estrictamente; activarlo exige `INVENTORY_DEMO_GATEWAY_IPS` válido. Las IPs se verifican contra la conexión TCP y se normalizan entre IPv4/IPv6; no se usan headers reenviados ni `request.ip`.
- Metadatos locales solo en GET comercial y POST verificador, con método exacto. `InventoryAuthGuard` se conserva y permite la excepción exclusivamente para esos handlers y peers configurados. No hay bypass en `UserAuthGuard` ni en las demás operaciones.
- Marca interna de solicitud para omitir únicamente la correspondencia de canal con un cliente autenticado en esa excepción. El enum MARKETPLACE/CHATBOT/RETAIL y las reglas de dominio se mantienen. No se asignan `user`, `clientId`, token, rol ni scope. Con flag apagado, el JWT y el control canal/cliente anterior vuelven a aplicar.
- Log de arranque identifica la excepción activa sin imprimir IPs/credenciales. Se documentan límites y configuración, sin activar la demo en ningún entorno.
- Pruebas HTTP de Inventario y pruebas contra el Gateway real en otro proceso. No hay importaciones entre aplicaciones en el código de Inventario; la integración usa HTTP. El artefacto de Gateway contiene su módulo/proxy/identity/registro publicados, sin parches, con bootstrap de prueba ligado a loopback y puerto efímero.

## Validación y resultados

| Comando | Resultado final |
| --- | --- |
| `npm.cmd test -- apps/inventory-svc/src/auth apps/inventory-svc/src/config` | PASS: 53 pruebas focalizadas |
| `node apps/inventory-svc/test/prepare-gateway-demo.mjs` | PASS: artefacto aislado del SHA fijado, sin cambiar archivos de Gateway |
| `npm.cmd run test:e2e -- apps/inventory-svc/test/inventory-commercial-demo.e2e-spec.ts`, con artefacto | PASS: 22 casos; 12 del provider y 10 de integración HTTP con Gateway |
| `npm.cmd test` | PASS: 244 pruebas, 18 omitidas; 32 archivos aprobados y uno omitido |
| `npm.cmd run test:e2e`, con artefacto | PASS: 91 pruebas en 11 archivos |
| `npm.cmd run typecheck` | PASS |
| `node_modules/.bin/tsc -p apps/inventory-svc/test/tsconfig.demo.json` | PASS: comprueba también los dos nuevos archivos de pruebas, excluidos del build normal |
| `npm.cmd run lint` | PASS |
| `npm.cmd run format:check` | PASS |
| `npm.cmd run build:inventory-svc` | PASS |
| `git diff --check` | PASS al cierre |
| PostgreSQL/RabbitMQ reales, firewall/runtime, CI remoto, homologación y despliegue | NO EJECUTADO |

Se comprueba: GET/POST de los tres canales sin JWT ni claves G7, Authorization entrante ignorado y no reenviado por Gateway, ausencia de identidad inventada y de efectos en saldo/reservas/operaciones/Kardex/Outbox/Inbox, `binding=false`, respuestas minimizadas, una sola ubicación, contexto inválido, agotamiento/ambigüedad de rutas, protección de lecturas privadas/escrituras, flag apagado, JWT productivo válido y canal incorrecto, peer no confiable pese a headers/trust proxy, caída DB sanitizada/recuperación y métodos/rutas desconocidos.

La suite usa Nest y HTTP reales con persistencia sintética en memoria. No es E2E React→Gateway→PostgreSQL ni prueba del broker. Los cuatro casos que caracterizan el defecto del Gateway comprueban el fallo observado, no la aceptación del contrato corregido. Sin `INVENTORY_GATEWAY_ARTIFACT_DIR` se omiten los diez casos de Gateway explícitamente; el resto continúa.

En la primera ejecución nueva se usó un modo de fulfillment incorrecto en el fixture: se corrigió a `ENVIO_DOMICILIO` y al campo físico `mode`. La comprobación adicional de tipos detectó una firma de helper demasiado específica y referencias sintéticas nulas; se corrigieron antes de las validaciones finales. No se modificaron ni desactivaron pruebas existentes.

## Brecha reproducida de Gateway — owner Marco / #107

Archivo externo: `apps/api-gateway/src/routing/contract-routes.ts`, operación `verificarCantidadComercial`. En el head de PR #130, `responses[status].codes` está vacío para sus errores, excepto 429. `gateway-problem.ts` rechaza esos códigos y los convierte en 500. El OpenAPI vigente sí publica el mapa en `x-error-codes`:

| Status | Código contractual que debe conservar Gateway |
| --- | --- |
| 400 | VALIDACION |
| 401 | TOKEN_INVALIDO |
| 403 | SCOPE_INSUFICIENTE |
| 422 | CONTEXTO_ABASTECIMIENTO_INVALIDO |
| 429 | RATE_LIMIT_EXCEDIDO |
| 500 | ERROR_INTERNO |
| 503 | SERVICIO_NO_DISPONIBLE |

Evidencia reproducida: cantidad cero devuelve 400/VALIDACION directamente y 500/ERROR_INTERNO vía Gateway; contexto inválido hace lo mismo con 422; flag de Inventory apagado con 401; DB no disponible con 503. GET comercial conserva 400 y 503 correctamente.

Corrección requerida en #107: incorporar/resolver `x-error-codes` y `const`/enums de los schemas al registro de respuestas de esa operación y añadir regresiones que esperen los códigos originales. No abrir el filtro a códigos arbitrarios. Condición de desbloqueo: revisión de Gateway con esa corrección y las mismas pruebas esperando 400/401/422/503 de extremo a extremo. No se editó ese componente ajeno al ownership de Taco ni se enviaron mensajes/comentarios a terceros.

## Reproducción local

Desde Backend, con dependencias instaladas y el objeto Git del SHA de Gateway disponible:

```powershell
node apps/inventory-svc/test/prepare-gateway-demo.mjs
# El comando imprime la carpeta aislada generada bajo dist/.
$inventoryOriginalArtifact = $env:INVENTORY_GATEWAY_ARTIFACT_DIR
try {
  $env:INVENTORY_GATEWAY_ARTIFACT_DIR = '<ruta absoluta impresa por el comando anterior>'
  npm.cmd run test:e2e -- apps/inventory-svc/test/inventory-commercial-demo.e2e-spec.ts
} finally {
  $env:INVENTORY_GATEWAY_ARTIFACT_DIR = $inventoryOriginalArtifact
}
```

Si falta el objeto, obtener únicamente `32153bffb35daa8761272c7b55fe23dc1df70007` con `git fetch --no-tags origin <sha>` (lectura remota; no merge/rebase). La preparación no descarga código por sí sola ni usa credenciales de runtime. El proceso Gateway finaliza al terminar la suite; los artefactos quedan en `dist/`, ignorado por Git.

## Archivos y pendientes

Todos los cambios versionados son de `apps/inventory-svc/`: nuevos `src/auth/commercial-demo.ts` y `.spec.ts`; cambios en `src/auth/inventory-auth.guard.ts`, `src/inventory.controller.ts`, `src/config/inventory.config.ts` y `.spec.ts`, `src/main.ts`; nuevos `test/inventory-commercial-demo.e2e-spec.ts`, `test/prepare-gateway-demo.mjs` y `test/tsconfig.demo.json`; `CONFIGURACION.md` y este informe.

Dependencias específicas: Marco/#107 para el mapa de errores y la definición del alcance anónimo adicional; Infraestructura G6 para IPs de salida, puertos privados y datos de demo aislados; Taco/entorno para PostgreSQL/RabbitMQ aislados y Node admitido; Catálogo/Poma para los filtros de dashboard pendientes de #100. Ninguna de estas pendientes invalida el desarrollo y las pruebas locales completadas.

Node local `22.16.0`, inferior al rango del repositorio. Se conserva la omisión de los 18 tests opt-in de infraestructura real y no se repitió la solicitud Docker rechazada. El archivo preexistente `test/inventory.real.integration.spec.ts` mantiene SHA-256 `07C4C9A86E66895349C259B3295EDFD62DE1A6E6790E48A1D960B39BF8E763AA` y queda excluido del commit.

Implementación local de las dos consultas demo: terminada. Integración HTTP aislada: éxito de ambas y defecto externo documentado en errores del POST. Integración de persistencia real, homologación, aislamiento productivo y despliegue: no acreditados. Errores obligatorios locales pendientes: ninguno. Cambios fuera del alcance: ninguno. No hubo push, PR, merge, cierre de issues, cambios de Frontend ni escrituras en infraestructura compartida.
