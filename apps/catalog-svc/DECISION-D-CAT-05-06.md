# D-CAT-05/06 — Elegibilidad comercial global

## Autorización y estado

Gabriel Poma entregó la propuesta «Propuesta de resolución D-CAT-05/06 —
Elegibilidad comercial por canal» (21-10-2026) y solicitó implementar esta primera
duda en su rama `poma`. Este registro conserva la regla suministrada y su
implementación candidata para #45/#46; no constituye una nueva DEC-F.

El adjunto mantiene pendiente la ratificación de Marco/Arquitectura y las
confirmaciones de consumidores. La instrucción directa de Gabriel autoriza el
desarrollo interno. No acredita ratificación, homologación, permisos ni deploy.

## Regla implementada

| Agregado | Visible comercialmente |
| --- | --- |
| Simple | `products.estado = ACTIVO`; `sku_base` es vendible |
| Con variantes | Padre `ACTIVO` y al menos una hija `ACTIVA` |
| Detalle del padre | Solo hijas `ACTIVA`; su `sku_base` conserva identidad base |
| Padre BORRADOR/INACTIVO | No visible, aunque tenga hijas activas |

La misma regla rige MARKETPLACE, CHATBOT, RETAIL y VENTAS. `canal` sigue validado
según el contrato, pero no exige asignaciones ni cambia esta elegibilidad.
No se autoriza `modulo-ventas`: se conserva la allowlist existente.

Listado, ID y slug comparten el predicado SQL sobre tablas oficiales. `EXISTS`
correlacionado evita duplicar padres con varias hijas; usa el índice oficial
`ix_variants_product_id (product_id, estado)`. COUNT y página usan el mismo filtro
y snapshot de solo lectura `repeatable read`, con desempate por ID.

Una consulta sin coincidencias devuelve 200/vacío; ID o slug no visible devuelve
404 `PRODUCTO_NO_ENCONTRADO`. Fallos de persistencia en la lectura comercial se
traducen a 503 `SERVICIO_NO_DISPONIBLE`, sin fabricar vacío ni exponer errores DB.
Readiness verifica identidad real y lectura comercial, incluso con catálogo
vacío; no requiere `catalog.sku_channel_eligibility`.

Se retiran el provider, la selección previa de IDs y el adaptador candidato de
esa tabla. No hay tablas nuevas, migraciones, SQL compartido ni eliminación de
tablas en ambientes existentes. Las consultas administrativas autorizadas y los
modos demo explícitos conservan su comportamiento. Activación/reactivación,
preparación, Pricing, Inventario y eventos no cambian.

## Contraste normativo

Fuentes consultadas en Docs, master `99456d8f08b1ab7bf08e256ca38070654552e94d`:

- `contratos/http/openapi.yaml`, 0.6.0-rc.1: operationIds `listarProductos`,
  `obtenerProducto` y `obtenerProductoPorSlug`, DTO, parámetros y seguridad.
- `contratos/eventos/asyncapi.yaml`, 0.6.0-rc.3: sin cambios de mensajería.
- SPEC-003 y SPEC-004: identidad SKU, estados e independencia padre/variante.
- Registro DEC-F, matriz de trazabilidad y matriz intermodular: DEC-F-001, -002,
  -006 y -011, separación entre identidad, precio, stock y perfil físico.
- Guías Oracle de backend: GUIA_DEVTEAM, CONTRATO_DESPLIEGUE,
  servicios/catalog-svc, MATRIZ_DEPENDENCIAS, RABBITMQ_COMPATIBILIDAD y
  CHECKLIST_PREDEPLOY.

**Diferencia documental pendiente:** la extensión histórica de SPEC-003 todavía
afirma «ACTIVO no implica visibilidad automática en todos los canales» y deja
D-CAT-05/06 abiertas. La decisión entregada cambia esa semántica. OpenAPI mantiene
la expresión «elegible para el canal», sin especificar persistencia/default.
No se editan unilateralmente contratos compartidos ni se publica esta candidata
como homologada. Deben alinearse descripciones, SPEC y modelos en Docs conservando
las interfaces y la seguridad.

## Validación y límites

Las pruebas SQL aisladas verifican los cuatro canales, el predicado anterior a
COUNT/LIMIT/OFFSET, ID/slug, orden estable, estados administrativos y fallo DB.
Las pruebas HTTP verifican éxito/vacío autenticado con JWT RSA y los clientes
existentes, 401/403, 404, 503, correlación y modos demo.

La suite PostgreSQL desechable incluye 19 casos: añade paginación y total con
productos activos/borradores/inactivos en los cuatro canales, detalle con dos
variantes activas y hermanas no publicables, y padre inactivo con hija activa.
Las consultas no modifican Outbox. La suite de arranque TLS comprueba readiness
200 con el esquema oficial vacío y 503 al detener la base. Estas suites requieren
Docker/OpenSSL; un skip local no acredita integración real.

## Dependencias que siguen separadas

Validación local ejecutada:

| Comando | Resultado |
| --- | --- |
| `npm test -- --no-file-parallelism apps/catalog-svc` | PASS, 323 pruebas |
| `npm run test:e2e -- --no-file-parallelism apps/catalog-svc` | PASS, 67 pruebas; 35 omitidas |
| `npm test -- --no-file-parallelism` | PASS, 752 pruebas |
| `npm run test:e2e -- --no-file-parallelism` | PASS, 422 pruebas; 88 omitidas |
| `npm run build:all` / `npm run typecheck` | PASS |
| `npm run lint` / `npm run format:check` / `git diff --check` | PASS |
| Compilación TypeScript explícita de E2E modificadas | PASS |

Las omisiones locales incluyen PostgreSQL, RabbitMQ e integración configurable.
La CI del commit candidato debe consultarse por SHA antes de afirmar que las
pruebas desechables se ejecutaron; los resultados locales no las reemplazan.

En `fb73cac7a8bc6fc14653c71bc21488dac7f51166`, la CI
[40060234883](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/40060234883)
aprobó 752 unitarias y 450 E2E (60 omitidas), incluidos los 19 casos de persistencia
y los 4 de arranque/TLS de Catálogo. El run global falló en el smoke compartido
porque esperaba 503 para el listado vacío que ahora devuelve correctamente 200.

Gabriel autorizó expresamente modificar **únicamente**
`scripts/ci/marketplace-probe.mjs`, como excepción puntual al alcance compartido de
AGENTS.md §3: validar listado vacío 200, slug inexistente 404, readiness 200,
conservar 401/403 y comprobar 503 de listado/readiness al detener PostgreSQL.
Se incorpora el código contractual 404 en el helper de aserciones; no se alteran
Gateway, configuración, permisos ni datos compartidos. `node --check` y
`git diff --check` pasan. La nueva ejecución completa de CI se identifica por el
SHA que contiene este ajuste; el run anterior no se presenta como CI global PASS.

La ejecución `40060791828` de `c193fac` pasó el smoke online, el proveedor real
Drizzle/Taxonomy y el smoke offline, incluidos los nuevos 503 de Catálogo. Detectó
una carrera al recuperar PostgreSQL: el script solo esperaba a Taxonomy, mientras
Catálogo puede conservar una comprobación fallida hasta drenar su trabajo
subyacente (timeout HTTP 2 s, pool 10 s). La prueba espera ahora readiness 200 de
Catálogo durante un máximo de 30 s; solo admite 503 contractual como estado
transitorio y falla ante otro status o al agotar el plazo. El control del servicio
no se modifica ni se acepta un 503 como resultado final satisfactorio.

| Owner | Operación o cierre | Condición verificable |
| --- | --- | --- |
| Marco/Arquitectura + owner Docs | Ratificación/documentación D-CAT-05/06 | Aprobación registrada y publicación versionada alineada en Docs |
| Marketplace, Chatbot y Retail con G6 | Homologación de visibilidad | Aceptación identificable de la regla y pruebas autenticadas por consumidor |
| Pricing + Arquitectura | `precioMin`/`precioMax` | Semántica y frontera de integración aprobadas; permanecen en 503 |
| Plataforma + Marco | Despliegue y AMQP | Gates Oracle, topología/permisos/red reconciliados y autorización de release |

No se resuelven aquí D-CAT-01..04 (código de barras), otras dudas de la auditoría,
grants G7, Docker remoto ni deploy. Implementación interna, pruebas locales, CI,
integración autenticada externa, homologación y despliegue son evidencias distintas.
