# React / Gateway / flujo integrado — #77 y #78

Owner: Axel Cueva. Rama `cueva` en Backend y Frontend. Estado:
IMPLEMENTAR_PARCIAL. Fuentes: Docs G6 `1ee0d9e5a788dbe559a376bf96a60c6117af3956`,
OpenAPI 0.6.0-rc.1, AsyncAPI 0.6.0-rc.3, SPEC-005/006/007 y DEC-F-007/008/009/012.
El cambio documental desde `51a5ce6` solo afecta onboarding RabbitMQ; los contratos
usados por las etapas anteriores no cambiaron. El instalador/túnel individual no
acredita handlers, integración comercial ni homologación. No se utiliza aquí.

## Implementación y límites

El frontend incorpora `createHttpPromotionServices` para los puertos ya usados por
Cupones, Promociones y Recomendaciones. Usa exclusivamente rutas administrativas
oficiales y traduce DTOs/enum/canales/fechas a los modelos de presentación existentes.
El proveedor se inyecta explícitamente en `PromotionApiContext`; el modo API sin
proveedor permanece bloqueado y no carga mocks ni implementaciones del módulo.
La sesión se recibe mediante el cliente G7 de login/MFA/refresh/logout del
Frontend, conectado al callback HTTP con URLs explícitas y tokens solo en
memoria. El modo API sin configuración sigue bloqueado; no acredita G7 compartido.

Las consultas y escrituras de Cupones se prueban con PostgreSQL real. Promociones
y reglas disponen del adaptador administrativo. El frontend incorpora selectores
HTTP tipados de productos, variantes y categorías con sesión de usuario; su
integración compartida sigue pendiente de configuración y prueba autenticada.
Las altas/ediciones/activaciones que requieren verificación independiente de
referencias en el backend conservan su dependencia específica, descrita en
[REFERENCIAS-CATALOGO.md](REFERENCIAS-CATALOGO.md). Evaluar,
validar una cesta, consumir o restaurar no son acciones de la administración React.

No se modifica el Gateway. El runner inicia sus entrypoints compilados y los de
Promotions como procesos nativos, usando HTTP real entre servicios y PostgreSQL
con certificado verificado/login restringido. No importa código de negocio entre
aplicaciones. Un servidor HTTPS descartable publica JWKS para JWT RS256 sintéticos
de usuario/servicio. Ambos procesos verifican firma/issuer/claims con sus providers
de autenticación reales, sin overrides ni relajación de TLS.

El navegador ejecuta las páginas/componentes existentes a 1440×900. Un servidor
Vite de prueba, configurado en una carpeta temporal, dirige `/api` al Gateway y
sirve el harness en las rutas comerciales. No cambia Vite productivo ni añade
rutas a los contratos. Los tokens de prueba se inyectan solo en memoria del
navegador; la entrada de test no se incluye en el build normal.

## Recorrido comprobable

El paso 6 amplía este runner con cinco pruebas de la entrada real `src/main.tsx`,
sesión G7 de contrato por HTTPS verificado, Gateway/PG nativos y consistencia
AMQP. Se conserva el recorrido anterior. Una ejecución conjunta y la matriz
de autoridades/fronteras están en [FLUJO-E2E.md](FLUJO-E2E.md).

- Gateway: usuario válido, expirado, firma alterada, rol insuficiente, token de
  servicio y scopes; respuestas 200/401/403 con JWKS HTTPS real.
- Cupones: crear inactivo, leer, editar código/límite, activar y desactivar;
  duplicado 409, entrada inválida 400 y recurso ausente 404. DTO y correlación
  conservados a través del proxy.
- React: crear cupón normalizado, editar límite, confirmar activación, volver a
  listar y recargar conservando el dato; duplicado conserva formulario; 401/403
  bloquean escritura y se muestran visiblemente. Consulta promociones y reglas
  persistidas, distingue 404 y no muestra datos de demostración en modo API.
- Se comparan usos, recibos, Inbox y Outbox antes/después: administrar y evaluar
  no generan consumo ni mensajería. La evaluación sin fuente comercial responde
  503 y no fabrica un precio.
- La suite provider existente se ejecuta completa primero. Como cierra su pool
  para verificar 503, el escenario Gateway abre después otro pool restringido;
  sus fixtures no alteran las aserciones originales de filtros/paginación/vacío.

## Ejecución reproducible, solo local/descartable

Requiere dependencias instaladas en ambos repositorios, Docker operativo y
Chromium de la versión Playwright del frontend. No lee `.env` compartidos ni
acepta una URL externa de base de datos. Las migraciones oficiales inmutables se
aplican únicamente en el PostgreSQL temporal.

```powershell
npm run build:all
$env:G6_TEST_PYTHON = '<python con cryptography, según PERSISTENCE.md>'
$env:G6_PROMOTIONS_FRONTEND_ROOT = (Resolve-Path '../G6-Productos-Ofertas-frontend').Path
# Opcional: carpeta para JSON, logs sanitizados y capturas.
$env:G6_PROMOTIONS_E2E_OUTPUT_DIR = '<carpeta de evidencias>'
node apps/promotions-svc/test/gateway.isolated.smoke.mjs
```

Sin `G6_PROMOTIONS_FRONTEND_ROOT`, el runner ejecuta Gateway/Promotions/PostgreSQL
y registra frontend como NO EJECUTADO. No declara el navegador aprobado por omisión.
Con frontend, ejecuta también su test Playwright dedicado. El test aparece omitido
en la suite frontend ordinaria y se acredita por separado en este runner.

Se generan `gateway-evidence.json`, `browser-results.log` y las capturas
`gateway-coupons-1440.png` / `gateway-session-error-1440.png`. El JSON registra SHA
Backend/Frontend, entorno y fronteras no probadas. Los resultados ejecutados se
registran por entrega; este documento por sí solo no declara PASS.

AMQP se verifica aparte con `coupons.isolated.smoke.mjs` y RabbitMQ/PostgreSQL
descartables. No se añade AMQP a una administración que no lo necesita, ni se
atribuye una reserva/snapshot sintéticos a G5/Inventario.

## Dependencias y dimensiones de evidencia

| Owner | Operación | Condición verificable de desbloqueo |
| --- | --- | --- |
| G7 / integración de sesión frontend | Operar estas pantallas en entorno compartido | Proveedor de access token de usuario real, issuer/JWKS/grants y origen Gateway configurados; prueba autenticada de sesión/roles por entorno. El harness no es un login. |
| Poma/Catálogo, López/Taxonomía + integración G6/G7 | Lecturas compartidas de selectores y referencias para altas/ediciones/activaciones | Configurar y probar la sesión de usuario de los selectores. Para la validación autoritativa backend, definir una operación/identidad propia autorizada para verificar actividad de producto/SKU/categoría, sin delegarla al navegador. |
| Catálogo/Pricing/Inventario + arquitectura | Consultas comerciales y recomendaciones enriquecidas | Adaptadores propios autenticados SKU/canal/instante; resolver D-REC-01/02 para varios SKU. |
| Marco/infra AMQP + G7 + G5/Inventario | Consumo/restauración compartida #33/#75 | Identidad/ACL/red/topología homologadas, reserva confirmada/snapshot durable y prueba bilateral v2. Runtime permanece protegido. |
| Marco / #111 y owners de entorno | E2E Oracle desplegado | Autorización individual de SHA/imagen/destino, configuración y comprobación autenticada del entorno. |

Implementación interna y pruebas locales son dimensiones separadas de integración
autenticada compartida, homologación y despliegue. Estas últimas NO se acreditan
con el JWKS fixture, el PostgreSQL temporal o la captura del navegador. #77/#78
permanecen parciales y abiertos; DATA #15/#112 sigue sin ejecución persistente.
