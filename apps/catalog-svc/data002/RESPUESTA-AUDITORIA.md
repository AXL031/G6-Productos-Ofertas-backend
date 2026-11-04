# Respuesta a la auditoría de PR #175

Rama poma, DATA-002 #12. Excel, snapshots históricos, identidades y las 220
medidas originales preservados. No se ejecutaron escrituras en Supabase ni
cambios de permisos, RLS, propietarios o Storage. El administrador gestiona
los permisos de Storage fuera de este paquete. El PR permanece en borrador.

## 1. Calidad de los perfiles

`METODOLOGIA-PERFILES.md` recoge la metodología aportada por el usuario:
investigación comercial, uso de referencias comparables, estimación heurística,
ajustes aproximados por talla y reutilización explícita de plantillas.
`template-reuse.csv` enumera cada SKU y su plantilla; la revisión automática
comprueba 213 estimaciones, siete referencias publicadas no homologadas,
27 combinaciones y 39 SKU con combinaciones compartidas. No se modificaron
medidas ni se afirma que existan 55 mediciones individuales.

## 2. Artículo frente a embalaje: decisión pendiente

El [modelo físico](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/f903f0bb0485bc0c6a6a7c6545446e972286daf6/datos/catalog-svc/physical-model.md)
§4 y §8.9 excluye empaque y paquetes del perfil; el OpenAPI
`consultarDatosFisicos` y SPEC-003 atribuyen a G6 medidas intrínsecas y a G2
empaque/peso/volumen operativos. SPEC-004 también excluye empaque del alcance
de Catálogo. Estos contratos no quedan modificados por un Excel académico.

La fuente describe 51 presentaciones con bolsa/envoltorio/caja y cuatro balones
inflados sin embalaje. La mezcla es una discrepancia semántica real, aun cuando
los números sean estructuralmente válidos. **55 READY solo acredita inserción
estructural, no conformidad semántica ni autorización.** El preflight añade
`PENDING_INTRINSIC_OR_ACADEMIC_EXCEPTION`; las matrices muestran este pendiente.

Propuesta preferida: conservar este Excel como fuente de simulación logística
y preparar, en una futura propuesta separada, medidas intrínsecas del artículo
para G6. No restar una tara inventada, convertir pares en unidades individuales
ni cambiar los 220 valores actuales. Se necesita una fuente/criterio explícito
para cualquier nuevo conjunto.

Alternativa a decidir por Marco/Arquitectura y, si afecta su consumo, G2:
aprobar una excepción académica delimitada para exactamente estos 55 SKU y
documentar/versionar la interpretación autorizada antes de solicitar carga.
La aprobación de estimaciones no equivale a esa excepción. No se crean campos
de embalaje ni se cambia unilateralmente el contrato.

El SQL propuesto E ahora falla con `DATA002_PHYSICAL_SEMANTICS_NOT_APPROVED`
salvo constancia explícita de esa decisión en el procedimiento aprobado mediante
`catalog.data002_physical_semantics=ACADEMIC_LOGISTIC_EXCEPTION_APPROVED`.
El script no configura ese valor. La simulación solo lo establece en PostgreSQL
desechable; también prueba que la ejecución sin decisión se rechaza. Este control
no sustituye la posterior autorización independiente de ejecutar en Supabase.

## 3. Referencias por variante

Se mantiene `modelo_ref_original` y se añade la referencia revisada sin tocar el
Excel ni medidas. `sources/model-color-review.json` documenta las fuentes;
`reference-image-review.csv/json` asigna referencia y evidencia a cada SKU.

| Presentación | Referencia revisada | Evidencia |
|---|---|---|
| Entrada 26 azul | JZ2506 | [adidas](https://www.adidas.es/camiseta-entrada26/JZ2506.html) |
| Entrada 26 blanco | JZ2508 | [adidas](https://www.adidas.pl/koszulka-entrada26/JZ2508.html) |
| Entrada 22 azul | HG6283 | [adidas](https://www.adidas.co.uk/entrada-22-jersey/HG6283.html) |
| Runfalcon gris | HP7552 | [adidas](https://www.adidas.com.au/runfalcon-3.0-shoes/HP7552.html) |
| Revolution 7 negro | FB2207-005 | [Nike](https://www.nike.com/sg/t/revolution-7-road-running-shoes-dC34tK/FB2207-005) |
| Ultra Play negro FG/AG | 107224_02 | [Puma](https://sa.puma.com/sa/en/pd/ultra-play-fg-ag-football-boots-men/107224.html) |
| Nike Pitch blanco/azul | FZ2636-101, no FZ2636-100 | [Nike](https://www.nike.ae/en/pitch-football/NKFZ2636-101.html) |
| Everyday Plus negro / blanco | FQ0327-010 / FQ0327-100 | Referencia separada por color; no usar un código compuesto en cada SKU |

Las referencias no revisadas de nuevo conservan su fuente histórica identificada
como tal, sin presentarla como nueva certificación. Los códigos de fabricante
no sustituyen los SKU internos ni se escriben en Supabase por esta tarea.

## 4. Atributos: tres asuntos independientes

La consulta actual `evidence/audit-followup-readonly.json` confirma los doce
atributos LISTA: `valor_id` activo, perteneciente a la característica activa.
OpenAPI `Atributo.valor: {}` admite JSON null; el modelo físico lo permite y lo
distingue de SQL NULL. `catalog-master.client.ts` valida LISTA mediante
`valor_id`; la clave identificadora se deriva de ese ID. **No hay obligación
contractual de normalizar los doce payloads a objetos redundantes.** No son
valores desconocidos y no se propone un UPDATE para hacerlos parecer válidos.

`attribute-review.json` conserva los doce IDs y su interpretación. La matriz
ya no los marca como datos desconocidos/bloqueantes. Revaluar individualmente
si cambia el contrato o deja de ser válida la referencia.

Las ocho asociaciones `product_identifying_characteristics` faltantes son un
problema local diferente de las asociaciones tipo/característica activas de
Taxonomy; quedan enumeradas para propuesta separada, sin DML ahora.
Nike Pitch carece de dos atributos obligatorios (Talla/Color): Talla 5 tiene
referencia existente; seleccionar el color publicado de la foto explícitamente
en Taxonomy antes de proponer su carga. No inferir IDs del SKU ni convertir estos
dos faltantes en un supuesto fallo de los doce valores LISTA válidos.

## 5. Correspondencia de imágenes

Se conservan las verificaciones de 23 objetos públicos HTTP 200 y sus URL,
object_id, bytes y SHA-256 en `evidence/storage-image-http.json`. La matriz de
55 SKU conserva las asociaciones SKU/color/referencia/fotografía y distingue
vínculos actuales y propuestos. Los nombres fueron asignados manualmente para
identificar producto, modelo y color: acreditan asociación documental, sin
acreditar inspección visual individual de los SKU. Se sustituye la clasificación
automática anterior por `ASOCIACION_POR_NOMBRE_Y_SKU` (52 filas, incluida Pitch
con su atributo de color pendiente). No se crean actas de inspección manual.
Se conservan las referencias comerciales, incluida FZ2636-101 de Nike Pitch,
sin convertir esas referencias en certificación visual de cada unidad.

Para los tres SKU RUNxCUSHIONED JD9558 se conserva **Negro** de Taxonomy. La
[página oficial adidas](https://www.adidas.co.uk/runxcushioned-socks-1-pair/JD9558.html)
identifica el código JD9558 y el color **Black / White / Black**. El tejido gris
jaspeado no contradice por sí solo esa denominación comercial.

La fotografía concreta de Storage coincide **byte a byte** con la imagen
principal enlazada desde esa página oficial: ambas respuestas HTTP 200,
30 170 bytes, SHA-256
`d528412f6e2f6f4dc684942bbb2f51bb547cc46ee1e1df3e6e02234b6b85e487`.
URLs, método, fecha y límites están registrados en
`evidence/jd9558-image-correspondence.json`. Las tres filas se clasifican
`IMAGEN_IDENTICA_A_FUENTE_OFICIAL_POR_SHA256`: una misma fotografía asociada a
tres tallas, sin afirmar tres inspecciones individuales ni acreditar talla o
autenticidad. Se retira el supuesto conflicto Negro/gris sin alterar fotos,
nombres, URLs, asociaciones ni atributos de Catálogo.

La evidencia binaria permite reincorporar RUNx a **B: 12 portadas propuestas**.
Las cuatro portadas adicionales permanecen separadas; no se incorporan a B.
Después de B el lote original tendría 15 imágenes de producto; si también se
aplica A, habría 16 globales. El postcheck histórico 004 permanece intacto y
se usan postchecks del mapeo nuevo. Ningún SQL se ejecutó en Supabase compartido.

## 6. PostgreSQL Ubuntu y CI

CI auditada: SHA 8316bf74e70c4e801c11e5bfea7f947df919883a,
[run 41741755610](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41741755610).
El fallo común de los 25 casos fue `terminating connection due to administrator
command` durante CREATE DATABASE. La espera por socket Unix aceptaba el servidor
temporal del entrypoint Docker; este se detiene antes del servidor definitivo.
Se espera ahora readiness TCP en 127.0.0.1, que no expone el servidor temporal,
y se falla explícitamente si no aparece. Se limpia el contenedor también si
falla el setup. El wrapper imprime el resultado de los 25 subcasos en la CI.
La causa se contrasta con el [entrypoint oficial de PostgreSQL Docker](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh):
el servidor temporal usa listen_addresses vacío antes de detenerse y arrancar
el servidor definitivo.

Se conservan todos los casos, incluidos carga exacta, no-op, rollback, perfiles
padre prohibidos, entradas inválidas, imágenes y migraciones. La negativa por
semántica pendiente y las revisiones de datos se comprueban dentro de esos casos.
No se cambia workflow, no se agregan filtros y no se desactivan suites.
La CI del nuevo HEAD debe finalizar con 25/25 Ubuntu y checks obligatorios
verdes; el enlace y el resultado final se registran en el PR, separados de la
evidencia local y de cualquier autorización de ejecución compartida.
