# Fase 3: preparación G7_AUTHENTICATED

Este cambio prepara la integración común de Gateway y los ocho servicios con G7.
No activa Fase 3 en Azure ni certifica todas las operaciones de negocio. No cambia
Oracle, migraciones, datos compartidos o el emisor de pruebas.

## Contratos y alcance

- Backend #144; plan transversal de Fase 3 aprobado por el responsable del fork.
- Docs G6 a7778ec1a22811c1213a94ef096ab905911342cc: OpenAPI,
  POLITICA-SEGURIDAD-PROGRESIVA-G6 y ACUERDOS-INTEGRACION-INTERNA-G6-H4
  (DEC-G6-INT-01/04).
- Docs G7 216059de38cd08949c0aca1b9f2ea855ef52aa76: SPEC17 y matriz de scopes.
- Base de aplicaciones común con master oficial
  3f685dbcb616daad3414039059396823a0a0a9a2 antes de esta implementación.

El token humano G7 usa tipo=acceso, sub UUID y roles; no se exige una audiencia
inventada. La identidad M2M se obtiene del sub firmado, con audiencia y scope
requeridos y allowlist por operación. Los grants múltiples legítimos se admiten
sin ampliar la autorización. Las cuentas AMQP no representan clientes JWT G7.

## Cambios verificables

- Caché JWKS acotada: refresco y rotación, rechazo de claves desconocidas,
  retiro de claves y confianza previamente válida solo dentro de su vigencia.
  No se acepta una firma por indisponibilidad del proveedor.
- Introspección de las cinco operaciones sensibles de precios: DTO G7 completo,
  mismo sujeto, estado activo y rol vigente. Sin caché de la decisión humana.
  Gateway reutiliza y renueva su token técnico con verificación criptográfica.
- Los HTTP 401/403 de la credencial técnica se traducen a 503 de integración;
  una sesión inválida sigue siendo 401 y un permiso insuficiente 403.
- Catalog → Taxonomy usa su propio modulo-productos/catalogo:leer en Fase 3.
  Conserva la selección de rutas y reglas comerciales. Las allowlists internas
  de categorías/marcas y detalle de producto incluyen únicamente ese cliente
  adicional aprobado; no cambia la allowlist externa de Gateway.
- Inventory usa sub como identidad canónica y rechaza client_id divergente.
- Preflight Azure exige nueve configuraciones G7 coherentes, HTTPS y credenciales
  técnicas en los consumidores correspondientes; rechaza el simulador y las listas
  públicas residuales. El manifiesto ARM referencia secretos sin publicarlos.

## Operaciones cerradas por decisión expresa

En Fase 3 permanecen cerradas obtenerSeoPorSlug, resolverSlugAnterior,
listarTrasladosInventario, obtenerTrasladoInventario y
registrarRecepcionTrasladoInventario. Para SEO falta la política permanente;
para traslados, la fuente autorizada de capacidades locales. Un rol comercial
o una capacidad añadida al token no desbloquea esta decisión temporal.

Las excepciones anónimas de Fase 1 no sobreviven al cambio coordinado de modo.
obtenerContextoSku continúa exclusivamente interno en Fase 3. El entorno público
actual no se modifica con este commit.

## Verificación

Ejecutar npm test, npm run test:e2e, npm run typecheck, npm run lint,
npm run build:all y npm run format:check. E2E requiere Docker y OpenSSL para
bases PostgreSQL TLS desechables; nunca usar credenciales de la base compartida.
En Windows puede ser necesario incluir Git/usr/bin en el PATH del proceso.

Ejecutar además:

```sh
node --test ops/azure/container-apps/phase3-preflight.test.mjs ops/azure/container-apps/render-deployment.test.mjs
```

Las suites g7-phase3-trust.spec.ts usan claves y emisores criptográficos locales:
no son homologación G7. Las verificaciones reales usan archivos privados fuera
de Git y registran solo resultados sanitizados, nunca JWT, secretos o identidades.

## Estado real observado y pendientes

El 6 de noviembre de 2026 (America/Lima), discovery y JWKS oficiales respondieron 200. G7 emitió tokens técnicos con catalogo:leer, precios:leer, roles:leer y
tokens:introspeccion, audiencias api-productos y api-seguridad. Falta conceder y
probar inventario:disponibilidad:leer para las llamadas intra-G6 correspondientes;
no se concede por inferencia ni desde SQL de G6.

La sesión humana de pruebas GESTOR_COMERCIAL fue validada criptográficamente y
por introspección real. Los nueve componentes compilados aceptaron su perfil
en pruebas locales de autenticación/autorización sin ejecutar handlers de negocio.
Esto no acredita escrituras, persistencia, flujo frontend completo ni Azure E2E.

Se observó una diferencia temporal local de hasta un segundo al recibir tokens
técnicos recién emitidos. La validación estricta rechaza iat futuro y conserva
fail-closed (503 en adquisición técnica). La prueba directa de introspección
funciona con el token ya vigente. Comprobar sincronización de reloj en los
contenedores antes de certificar las cinco operaciones sensibles de extremo a
extremo; no cambiar la tolerancia para ocultar este resultado.

Antes del corte faltan CI del SHA definitivo, revisión/merge autorizados, imágenes
oficiales por digest, configuración privada G7 de los nueve componentes y una
ventana de activación con pruebas HTTPS y rollback seguro. No volver
automáticamente a PUBLIC_READ_ONLY ante un fallo de Fase 3.

RabbitMQ se valida por separado: TCP/TLS y autenticación AMQP desde cada servicio
no prueban por sí mismos exchanges, routing keys, reintentos o procesamiento.
No se activa mensajería por haber recibido credenciales.

## Resultado local de esta implementación

- Unitarias: 2497 aprobadas, 72 omitidas; 216 suites aprobadas y 2 omitidas.
- E2E: 993 aprobadas, 207 omitidas; 39 suites aprobadas y 15 omitidas.
- Tipos, lint, compilación y formato: aprobados.
- Preflight/render Azure: 10 pruebas aprobadas; agregador CI: 9 aprobadas.
- Las omisiones corresponden a las condiciones/gates existentes de cada suite;
  no se eliminaron ni deshabilitaron casos para obtener estos resultados.
- CI remota del commit final: pendiente de su publicación.

Al terminar, master oficial avanzó a d21c24fcec5fe587545a43b76fa921e91eb25e0a
(PR #213, readiness integrada H4; cuatro commits desde la base). Sus trece
archivos cambiados no coinciden con los archivos modificados de esta entrega.
No se incorporó ni resolvió esa divergencia automáticamente; revisar la
compatibilidad contra esa base antes de integrar. Las pruebas anteriores
corresponden a la base fijada y los cambios de esta entrega.
