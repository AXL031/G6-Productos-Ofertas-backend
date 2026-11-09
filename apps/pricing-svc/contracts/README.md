# Contrato acordado de recuperación histórica A1

Confirmado expresamente por el usuario el 2026-11-05 para la adaptación de Vera:

- Mismo comando `pricing.product.initialization.requested`, envelope v1 y topología.
- Discriminador `data.modalidad` opcional: `ALTA_PRODUCTO` por defecto, o
  `RECUPERACION_HISTORICA` explícito; jamás inferido por motivo/datos existentes.
- `precio_regular` number positivo obligatorio en alta, opcional solo en recuperación;
  si se proporciona, se compara exactamente, sin redondeo ni tolerancia.
  null/string no sustituyen su omisión. `moneda` siempre obligatoria.
- `motivo_cambio=ALTA_PRODUCTO` permanece como metadata del comando compatible;
  no discrimina modalidad ni cambia el motivo de la vigencia adoptada.
- DTO completed/rejected existente: READY con versión/id reales de la vigencia
  adoptada, o REJECTED/HISTORICAL_PRICE_CONFLICT. Intención distinta por
  operation_id produce OPERATION_ID_CONFLICT. Precio omitido vs afirmado son
  intenciones distintas; ALTA implícita y explícita son la misma intención.

Fuente consultada: G6 Docs master `a7778ec1a22811c1213a94ef096ab905911342cc`,
SPEC-013 y AsyncAPI 0.6.0-rc.4. El cambio compartido se entrega **preparado**,
no publicado ni fusionado en Docs. No se declara aceptación por silencio de Catalog.

## Artefactos

El schema limita el valor numérico a centavos y al rango numeric(12,2).
JSON Schema no conserva la representación textual del número: la validación
runtime también rechaza exponentes o más de dos decimales en el texto JSON.
El validador debe usar aritmética decimal exacta para `multipleOf`: algunos
validadores con flotantes binarios rechazan erróneamente importes como 0.29.

- `recuperacion-historica-docs.patch`: modificaciones concordantes de
  `contratos/eventos/asyncapi.yaml` y
  `requisitos/specs/SPEC-013-gestion-precios-individuales-masivos.md`.
- `historical-initialization.schema.json`: snapshot exacto del schema de request
  actualizado, validado con JSON Schema Draft 2020-12.
- `../test/fixtures/historical-initialization.json`: data contractual usada por
  el productor fixture de la suite. product_id/sku_base y envelope se generan
  en la prueba para aislar cada escenario; resultados proceden del handler real.

Aplicar primero sobre el SHA Docs citado, en la rama autorizada de su owner;
si el contrato evolucionó, revisar antes de aplicar. El patch utiliza cero líneas
contextuales para no introducir whitespace dentro del artefacto. Desde Docs:

```powershell
git apply --unidiff-zero --check <ruta-absoluta-al-patch>
git apply --unidiff-zero <ruta-absoluta-al-patch>
```

El clon local de revisión contiene ambos archivos actualizados y se verificó
la aplicación inversa del patch. Publicación/CI/PR de Docs y adopción del
productor Catalog siguen separadas de la PR DRAFT de Pricing. No se cambia
la versión del envelope ni se inventa un segundo comando/campos monetarios.

## Persistencia y replay

Sin migración ni DDL: Inbox.processed_at conserva el corte obtenido con
clock_timestamp() después de locks, preservado con microsegundos UTC; payload conserva intención original.
El resultado Outbox conserva vigencia_id, price_version y decisión con el
mismo instante en completed_at. El replay usa esos valores, cambia solo la
identidad/correlación/causalidad del nuevo envío y no consulta reloj de negocio
ni vigencias. Una nueva operación sí evalúa un corte nuevo.

El intervalo se compara en SQL para no truncar límites históricos a Date.
Selección bajo lock de operación y definición exacta global; la misma fila
se bloquea en las mutaciones normales. Se exige una sola vigencia no cancelada
con valid_from <= corte y corte < valid_until (o fin abierto). La versión
retornada es la del snapshot adoptado, incluso si existe otro snapshot futuro
con versión más nueva. No cambia definición, ofertas, fechas, motivos ni historial.
No se generan hechos monetarios ni inicialización artificial.

## Representación monetaria e índice de Inbox

El runtime toma el token JSON del campo `data.precio_regular` efectivo; ante
claves duplicadas se usa la última, también si el nombre utiliza escapes Unicode.
Homónimos anidados no participan. Exponentes y más de dos decimales se rechazan
sin redondear. JSON Schema valida el valor matemático y no puede validar estas
restricciones de representación ni detectar claves duplicadas.

Inbox guarda metadatos internos versionados para reintentos nuevos. Las filas
antiguas carecen del token original: se conserva su lectura previa, pero no puede
reconstruirse si un número llegó en exponente o con precisión perdida.

La migración aditiva `0003_initialization_operation_index.sql` requiere aplicación
separada por el propietario del esquema; no se ejecuta al iniciar el servicio.
En PostgreSQL 16 descartable, con 100.001 filas sintéticas y buffers calientes,
EXPLAIN ANALYZE midió 25,7–27,3 ms sin índice y 0,072 ms con el índice candidato.
La migración normativa compartida y su aplicación siguen pendientes de Marco.
