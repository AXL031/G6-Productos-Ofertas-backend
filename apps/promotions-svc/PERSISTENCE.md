# Persistencia Promotions — #71

Owner: Axel Cueva. Rama única: `cueva`. Implementación interna y pruebas aisladas
del 22/10/2026; revisión/merge, integración autenticada compartida, homologación
y despliegue se registran por separado.

## Normativa y alcance

Modelo físico y migraciones 0001–0004 del repositorio oficial Docs, commit
[`51a5ce6e76bb0c61d93ef47416e46797bf5b9846`](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/tree/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/datos/promotions).
DEC-F-007/008/009/012 y SPEC-005/006/007 delimitan ownership, atomicidad,
idempotencia y evidencia. No se modifican SQL histórico, grants o contratos.

`src/infrastructure/persistence/schema.ts` mapea exclusivamente `promotions`:

- Maestros: promotions, promotion_scopes, combination_policy y coupons.
- Historia y recomendaciones: coupon_uses, recommendation_rules y recommendation_items.
- Lecturas locales: catalog_projection, price_projection y stock_projection.
- Mensajería: inbox, outbox y coupon_command_receipts.

Las claves, FK internas con DELETE RESTRICT, unique/check e índices corresponden
al modelo oficial. La unicidad de precio global usa NULLS NOT DISTINCT sobre
SKU/canal. `numeric` retorna strings y `bigint` retorna bigint; los timestamps
con zona se leen como strings para conservar precisión. Los triggers y funciones
pertenecen a las migraciones oficiales; el mapping no sustituye su ejecución.
No se mapea el ledger de migraciones como tabla funcional del servicio.

## Uso y atomicidad

El provider `PromotionsPersistence` se registra con el pool de `COUPON_RESOURCES`.
Su construcción no abre conexiones ni ejecuta DDL. Ese recurso conserva la
propiedad del cierre del pool después de drenar el runtime.

`transaction(async repositories => ...)` adquiere un único cliente. Todos los
repositorios del callback usan Drizzle sobre ese cliente. La misma unidad
`inPromotionsTransaction` se usa en el procesador de cupones, que conserva sus
locks, savepoints, recibo/efecto/Inbox/Outbox y replay originales. No se duplica
la lógica de consumo/restauración ni se abre una segunda transacción para ella.

Se configura statement_timeout de 5s y lock_timeout de 3s por transacción.
Una falla de sentencia, del callback o de una constraint diferida al COMMIT
provoca ROLLBACK. Si falla el rollback se destruye esa conexión al liberarla.
`read(...)` usa BEGIN READ ONLY y PostgreSQL rechaza escrituras dentro de él.
Los errores expuestos por persistencia contienen un código técnico fijo y,
cuando está disponible, SQLSTATE; no incluyen SQL, parámetros ni causas crudas.

Los repositorios permiten crear/consultar/actualizar los tres agregados y leer
proyecciones/historial/recibos/Inbox/Outbox. Los agregados se crean dentro de la
transacción externa; las constraints diferidas exigen hijos completos al commit.
Los handlers HTTP, autorización y reglas completas corresponden a #72/#73/#74.
Estas funciones internas no constituyen endpoints implementados.

## Pruebas reproducibles

```powershell
npm run build:promotions-svc
npm test -- apps/promotions-svc --maxWorkers=1
npm run test:e2e -- apps/promotions-svc --maxWorkers=1
node apps/promotions-svc/test/persistence.isolated.smoke.mjs
```

La prueba real necesita Docker y `python` con cryptography para generar un
certificado descartable. Puede seleccionarse Python mediante `G6_TEST_PYTHON`.
Como alternativa y en CI, definir `G6_TEST_OPENSSL=openssl` evita esa dependencia
Python. No se acepta URL de base de datos ni se leen archivos `.env` privados.

El helper descarga las cuatro migraciones del commit normativo inmutable y
verifica SHA-256; la caché queda bajo node_modules/.cache. No instala un runner
de migraciones en producción. Crea una sola instancia PostgreSQL descartable,
ligada a loopback y con TLS verificado, aplica el SQL oficial con un owner de
fixture y prueba con un login runtime sin privilegios administrativos. El
contenedor y el certificado temporal se eliminan al terminar.

Los ocho grupos reales prueban:

1. Paridad de las 13 tablas: columnas, tipos, nullabilidad, constraints e índices.
2. Identidad runtime/TLS; rechazo de DDL y SELECT en otro schema.
3. Commit de promoción/alcance/política/cupón, consultas parametrizadas,
   normalización de código y exactitud decimal.
4. Rollback por unicidad, FK/trigger, porcentaje/canal/fecha/alcance inválidos,
   agregado incompleto al commit y escritura dentro de transacción de lectura.
5. Rollback del callback, sanitización y reutilización posterior del pool.
6. Persistencia de regla/items de recomendación y completitud diferida.
7. JSON, bigint mayor que el entero seguro JS y claves de precio global/canal.
8. Núcleo de cupones con el mismo pool; uso único tras replay; lectura Drizzle
   de receipt/Inbox/Outbox y denegación de mutaciones del historial/fingerprint.

PASS local con PostgreSQL 17.11, tanto certificado Python como OpenSSL.
Cuatro unitarias adicionales cubren fallas de adquisición, BEGIN, COMMIT y
ROLLBACK/liberación. Se repitieron los 11 escenarios existentes de cupones con
PostgreSQL/RabbitMQ reales descartables y los 7 escenarios de probes reales.

## Límites y dependencias

El smoke usa evidencia de reserva/snapshot exclusivamente sintética para aislar
persistencia; no acredita el provider real de #33. El consumidor y pump siguen
deshabilitados y protegidos. No se prueban grants del entorno compartido ni se
amplían permisos para solventar una dependencia.

AsyncAPI vigente es rc.3; los bindings físicos del adaptador anterior son rc.2.
Adaptar esa frontera en #75/#33 exige resolver la configuración contractual y
verificarla con el owner AMQP. No se aprovisionan exchanges, colas, retry/DLX o
ACL compartidos. DATA #15 continúa pendiente de referencias y aprobación, sin
carga comercial. #112 conserva su dry-run sin modo persistente y su owner actual.

La única excepción al ownership del servicio es `.github/workflows/ci.yml`,
autorizada expresamente por Axel en este chat: se preserva el workflow actual de
master, se añade el smoke de Promotions con configuración sintética y un job
independiente de persistencia PostgreSQL TLS. No se sincroniza otra ruta de
master. El CI remoto debe acreditarse para el nuevo SHA y para la combinación
del PR, sin reutilizar como prueba la ejecución histórica de otra punta.
