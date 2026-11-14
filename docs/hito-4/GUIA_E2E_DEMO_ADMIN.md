# Pruebas locales de demo H4

Usar un checkout aislado, Node 24, npm 10 o superior, Docker operativo y OpenSSL accesible por PATH. Los fixtures del repositorio deben crear contenedores descartables y usar loopback. Mantener secretos y variables de Oracle/Supabase compartidos fuera del shell de prueba.

```sh
npm ci
npm run test:e2e -- --maxWorkers=1 apps/api-gateway/test/routing.e2e-spec.ts apps/catalog-svc/test/catalog-http.e2e-spec.ts
CI=true npm run test:e2e -- --maxWorkers=1 apps/catalog-svc/test/gateway-catalog.authenticated.e2e-spec.ts apps/catalog-svc/test/postgres.persistence.e2e-spec.ts
CI=true npm run test:e2e
```

El primer comando de E2E usa proveedores de loopback y fixtures de casos de uso. Gateway verifica firma RS256 en ese escenario. El segundo usa el arnés real Gateway → Catalog y el fixture PostgreSQL TLS para `HTTP-50`. Ese fixture añade creación 201, listado y detalle 200 de BORRADOR, PATCH con la versión recién leída, relectura con la nueva versión y respuesta 404 al comprador Marketplace que consulta el borrador.

Para el recorrido con G7 real, disponer del ambiente aislado con los nueve procesos y las dependencias verificadas. Usar un gestor con la misma sesión para Taxonomy → Catalog → Pricing → Inventory → Combos → Promotions. Comprobar lectura posterior de cada escritura, auditoría de precios, descargas y los negativos de cada rol. La integración con grants, el origen del frontend publicado y la interoperabilidad bilateral requieren su propia evidencia HTTP.

Los fixtures son propietarios de sus contenedores, esquemas y archivos temporales. Verificar la limpieza al finalizar y conservar en evidencias solo SHAs, identificadores ficticios, estados HTTP y resultados de pruebas.

En Windows se verificó además Catálogo con PostgreSQL 16.15 nativo y TLS, sin Docker. El fixture usa `initdb`, `pg_ctl`, `psql` y OpenSSL. Los binarios PostgreSQL deben incluir su directorio `share`. Ejecutar desde PowerShell:

```powershell
.\docs\hito-4\probar-catalogo-postgres.ps1 -PostgresBin 'C:\ruta\postgres\bin' -OpenSsl 'C:\ruta\openssl.exe'
```

El script crea y elimina un clúster temporal, aplica las migraciones existentes y ejecuta el caso Gateway → Catálogo → PostgreSQL TLS con JWT RS256 local. Los peers de Taxonomy son fixtures de loopback. El archivo candidato de Pricing tiene un caso adicional en la suite PostgreSQL de Pricing. Ejecutarlo con `PRICING_TEST_POSTGRES=1` y Docker disponible.

## Configuración H4 de runtime y pruebas adicionales

- Para logos, configurar TAXONOMY_LOGO_DIRECTORY como volumen absoluto escribible y TAXONOMY_LOGO_PUBLIC_BASE_URL como base HTTPS con barra final que sirva ese volumen. Verificar que el archivo publicado devuelve los bytes esperados. Sin esa configuración, una carga sin URL explícita devuelve 503.
- En el ambiente autorizado, INVENTORY_G7_TRANSFER_GRANTS es un objeto JSON que asocia el sub UUID autenticado a INVENTARIO_TRASLADOS_LEER y/o INVENTARIO_TRASLADOS_RECIBIR. Se configura únicamente en Inventory. Tras verificar los operadores, habilitar GATEWAY_INVENTORY_LOCAL_GRANTS_ENABLED en Gateway. Con un mapa vacío no se concede ninguna capacidad.
- El parámetro CombosBaselineMigration de probar-catalogo-postgres.ps1 recibe la ruta del SQL inmutable de Docs datos/combos/migrations/0001_create_combos_persistence.sql. El script aplica además el recibo candidato solo al clúster descartable y ejecuta la suite HTTP de Combos.
- Promociones acepta G6_PROMOTIONS_TEST_PG_BIN para iniciar PostgreSQL nativo descartable. Configurar G6_TEST_OPENSSL y ejecutar node apps/promotions-svc/test/persistence.isolated.smoke.mjs después de compilar. G6_PROMOTIONS_GATEWAY_E2E=true activa el recorrido adicional de Gateway.
