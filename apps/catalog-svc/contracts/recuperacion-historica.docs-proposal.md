# Propuesta para Docs — CONTRATO_CANDIDATO, no publicación

Fuentes: autorización escrita del encargo 06/11/2026, Catalog #194,
Pricing #205 @7398e6fbc577ec3d595a6c04d4aa9f884fbf527d e Inventory #176
@56aa4322725060b529bf316872f891582d7d1b2e. No se modificó Docs master.

## Delta nuevo que Marco debe aprobar

En el DTO HTTP candidato, `moneda` explícita obligatoria solo si incluye PRICING;
tres letras mayúsculas ISO conocidas por ICU del runtime, sin default ni importe.
Es afirmación humana, no autoridad monetaria; Pricing valida contra su snapshot.
Inventory-only no requiere moneda y se propone rechazarla si se suministra.
La moneda forma parte del fingerprint: misma solicitud con moneda diferente
conflicta aunque el adaptador esté deshabilitado. No usar GET demo, inferencias
o PEN por defecto. La aprobación anterior de la operación no aprueba este delta.

## OpenAPI

Auditoría semántica posterior de #194: corregidas las descripciones 400/409
(comas en un flow mapping introducían propiedades nulas) y la condición
variantIds vacía/ausente cuando no se selecciona INVENTARIO. El candidato
declara application/problem+json y su cuerpo real para 400/401/403/404/409/503,
además de 500 sanitizado y 413 VALIDACION por tamaño HTTP. La regresión HTTP
reprodujo que el filtro convertía entity.too.large en 500; ahora conserva 413
sin exponer cuerpo, detalles ni aceptar estados arbitrarios de errores.

### Evaluación de cardinalidad de variantIds

No existe un máximo normativo por producto/solicitud ni un presupuesto aprobado
de duración total de la transacción. El límite JSON existente de Nest/Express
es 100 KiB, y query_timeout/statement_timeout son 10 s por consulta, no por
transacción completa. Ninguno justifica elegir arbitrariamente 50/100 variantes.
Pruebas: 1024 UUID únicos se aceptan estructuralmente y caben en el cuerpo;
4096 UUID exceden el límite y producen 413 antes de admisión. El primer caso
HTTP usa DB indisponible explícita y no se presenta como transacción masiva.

Antes de habilitar producción, Poma/Marco deben fijar presupuesto de admisión
y volumen por producto, medir latencia/grants/rollback bajo contención en
PostgreSQL TLS representativo y probar N/N+1, atomicidad y replay. Si se adopta
N, debe concordar en DTO y maxItems del contrato aprobado. Se recomienda ese
límite explícito para acotar trabajo bajo lock; hoy no se inventa un número ni
se afirma que el límite de cuerpo garantice una transacción corta. La restricción
productiva del adaptador Pricing permanece intacta.

Integrar/revisar el fragmento `recuperacion-historica.openapi.candidate.yaml`:
ruta, DTO, 202 y errores 400/401/403/404/409/413/500/503. El operationId
propuesto tampoco se presenta como publicado. Errores usan Problem existente,
sin divulgar detalles internos. Mantener userBearer/rol y capacidad interna
default cerrado; no añadir scopes G7. Gateway requiere trabajo externo separado.

## SPEC-003 y FLOW-003

Agregar sección de recuperación histórica administrativa independiente de alta
y retry: solo BORRADOR para admisión nueva; dependencia explícita; selección
atómica, recibo/fingerprint, unicidad y locks solicitud→producto; PENDING+Outbox
en una transacción. Sin SQL manual sobre estados comerciales. Pricing adopta
histórico real mediante modalidad, nunca precio inventado. No reabrir checks
PENDING/REJECTED/COMPLETED. Replay autorizado idéntico devuelve recibo antes
de verificar disponibilidad del adaptador. Activar solo después de resultados
legítimos COMPLETED y restantes invariantes existentes.

## SPEC-004 y FLOW-004

Padre tiene Pricing una vez; su sku_base no crea inicialización Inventory ni
saldo. Cada variante física explícitamente seleccionada tiene su operación
Inventory. No completar variantes ajenas/no seleccionadas. Mantener activación
de variantes elegibles y después del padre; no rehacer el flujo ordinario.
La identidad persistida de variante usa variant_id, product_id puede ser NULL
en sku_identity: no introducir falsos requisitos de ambos IDs.

## SPEC-013 / AsyncAPI

Usar el patch del owner sin inventar otro mensaje o discriminador:
[patch de Vera](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/7398e6fbc577ec3d595a6c04d4aa9f884fbf527d/apps/pricing-svc/contracts/recuperacion-historica-docs.patch)
y [schema candidato](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/7398e6fbc577ec3d595a6c04d4aa9f884fbf527d/apps/pricing-svc/contracts/historical-initialization.schema.json).
Mismo requested v1, data.modalidad explícita RECUPERACION_HISTORICA,
moneda requerida, precio opcional exclusivamente histórico; Catalog lo omite.
ALTA_PRODUCTO mantiene importe obligatorio. channel_id=null y motivo_cambio
ALTA_PRODUCTO como metadata. Pricing persiste corte/vigencia/decisión por
operación, replay estable, sin DML monetario ni pricing.price.changed.
Completed real con price_version/vigencia_id; rechazo durable sin falso éxito.

## Persistencia y operación

0004 es candidata aditiva compatible con 0001–0003, exige po_catalog_owner,
RLS y SELECT/INSERT para catalog_app; sin UPDATE/DELETE ni acceso ajeno.
Requiere aplicación separada, aprobación y revisión por owner DB antes de uso
compartido. No se aplicó a Supabase y bootstrap no migra. La base compartida
auditada externamente no contiene esta tabla: su ausencia bloquea la operación
autorizada allí; no se crea silenciosamente ni se simula persistencia.

CATALOG_HISTORICAL_PRICING_CANDIDATE_ENABLED=false/ausente es cerrado;
true solo permitido NODE_ENV=test. Capacidad humana por concesión interna
separada. Producción necesita contrato publicado y nueva autorización operativa
para revisar ese bloqueo, más migración, ACL/red AMQP, grants G7 y prueba del
SHA desplegado. Nada de lo anterior queda concedido por la CI descartable.
