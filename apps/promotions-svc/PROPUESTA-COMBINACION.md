# Propuesta de combinación de beneficios — versión 1

Owner: Axel Cueva · rama `cueva` · issue #72 · actualización 23/10/2026.

**Estado: composición v1 adoptada internamente por Marco el 26/10/2026; HTTP sin activar.**
Ver [registro de la decisión y dependencias](DECISIONES-MARCO-2026-10-26.md).
La comunicación fue aportada por Axel, quien autorizó su registro y verificación.
La aprobación interna no acredita compatibilidad ni homologación de consumidores.
No crea una DEC-F ni modifica OpenAPI, AsyncAPI, datos persistentes o runtime.

## Base normativa y decisiones nuevas

Fuentes G6 consultadas en el commit
`51a5ce6e76bb0c61d93ef47416e46797bf5b9846`:

- [HU-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/requisitos/hu/HU-006-gestion-ofertas-promociones.md),
  CA-06/07/10/11/14/15: monto fijo una vez, mejor alternativa permitida, alcance
  deduplicado, precios de Pricing y consultas sin consumo.
- [SPEC-006](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/requisitos/specs/SPEC-006-gestion-ofertas-promociones.md):
  identidad SKU/producto, canal, instante y separación entre evaluación y consumo.
- [Registro DEC-F](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/arquitectura/decisiones/REGISTRO_DEC_F.md):
  DEC-F-007 mantiene autoridad de beneficios en Promotions; DEC-F-008 conserva
  consumo atómico separado; DEC-F-012 exige versionar y verificar compatibilidad.
- [OpenAPI 0.6.0-rc.1](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/51a5ce6e76bb0c61d93ef47416e46797bf5b9846/contratos/http/openapi.yaml):
  `EvaluacionPromocionesResponse` contiene un solo `promotion_id`; no tiene lista
  contractual de beneficios aplicados ni asignación monetaria por línea.

La fórmula sucesiva, el reparto proporcional, el significado de la campaña
principal, el desempate de conjuntos y el redondeo de las secciones siguientes
fueron propuestas aquí y **adoptadas internamente por Marco** según el registro
anterior; no se atribuyen a una aprobación externa ni crean una DEC-F nueva.

## Regla elegida

1. Resolver primero la cesta con precios y elegibilidad autoritativos para el mismo
   canal, instante y moneda. Subtotal de línea = precio unitario × cantidad. Las
   líneas duplicadas del mismo SKU deben consolidarse antes del cálculo; una
   discrepancia de identidad, moneda o precio no se resuelve seleccionando un dato.
2. Incluir únicamente campañas activas, vigentes y con alcance aplicable. Un cupón
   debe superar las validaciones propias; se admite como máximo el único código
   presentado. Coincidir por producto y por SKU no duplica el descuento.
3. Construir todos los subconjuntos compatibles, incluidos los individuales. La
   autorización es bilateral para **cada pareja**: automática–automática requiere
   `automaticPromotion` en ambas; automática–cupón requiere `coupon` en la
   automática y `automaticPromotion` en la campaña del cupón. Un permiso ausente
   equivale a no permitir. No se suman dos cupones. Tener alcances distintos no
   evita esta comprobación.
4. Evaluar cada subconjunto sobre precios regulares. Además evaluarlo sobre las
   ofertas de Pricing cuando **todos** sus miembros permiten `pricingOffer`.
   Mantener también la alternativa de solo Pricing. El modo de precios se decide
   para la cesta completa; no se mezclan bases por campaña ni se modifica Pricing.
5. Dentro de un subconjunto, ordenar campañas por prioridad ascendente y luego por
   identificador estable, comparado literalmente. Ese orden es parte de la regla:
   no buscar permutaciones para maximizar el descuento.
6. Aplicar cada descuento al saldo restante de sus líneas elegibles. Para el
   porcentaje `p`: descuento de línea = saldo × p / 100. Para monto fijo `f`:
   `D = min(f, suma de saldos elegibles)` y `D_i = D × saldo_i / suma de saldos`.
   Restar `D_i` solo a la línea correspondiente. Si el subtotal es cero, omitir
   ese beneficio. El monto fijo se aplica una vez, incluso con varios SKU o unidades.
7. Comparar importes finales exactos de todos los subconjuntos permitidos; gana el
   menor. Empate: sin cupón que aporte descuento; luego comparar las listas de
   campañas que aportaron descuento, ordenadas por `(prioridad, id)`, de forma
   lexicográfica; si una lista es prefijo, preferir la más corta. Una alternativa
   sin campañas tiene prioridad conceptual infinita, como en el evaluador actual.
   Si persiste igualdad, conservar la primera alternativa idéntica; no cambia el
   importe ni las identidades aplicadas.
8. Conservar por separado descuento de Pricing, asignaciones de cada campaña y
   saldos finales. Debe cumplirse exactamente: original = descuento + resultado;
   cada asignación suma el descuento de su campaña; ningún saldo es negativo.
   Una campaña/cupón que no aporta ahorro no se atribuye como aplicada.

## Identidad y frontera contractual

La decisión interna establece que `EvaluacionPromocionesResponse.promotion_id` identifique la primera
campaña **efectivamente aplicada** según `(prioridad, id)`, o `null` si solo hay
oferta de Pricing o ningún beneficio. **No identifica todo el conjunto ni el cupón.**
No fabricar un UUID concatenado, una campaña sintética o un identificador de pedido.

Para `ValidarCuponResponse.benefit.promotion_id`, conservar la identidad de la
campaña del cupón real; no sustituirla por la campaña principal. La validación
individual no consume ni reserva, y no garantiza el ahorro marginal en una futura
combinación. El consumo posterior sigue validando el cupón real y sus límites.

El prototipo devuelve internamente `applied`, `primaryPromotionId` y
`couponPromotionId`; **no son campos nuevos del HTTP ni un snapshot durable**.
Antes de conectar la propuesta, G6 y los consumidores deben confirmar si el
campo singular con esta semántica basta. Si necesitan reconstruir la composición
en Ventas/Postventa, debe existir un contrato versionado de desglose/snapshot y su
homologación; no se puede reconstruir toda la combinación desde la campaña principal.

## Precisión y propuesta monetaria

El cálculo usa fracciones exactas, incluidas asignaciones como `1/3`. No se elige
una precisión decimal arbitraria durante el reparto ni se redondea cada paso.
Así se evita que el orden de las líneas cree o destruya descuento.

Para la salida monetaria, la decisión interna aprobada establece:

- PEN: dos decimales; otras monedas necesitan escala explícita acordada.
- Redondear el resultado total una sola vez, al más cercano y mitad hacia arriba.
- Repartir las unidades mínimas de los saldos finales por mayor resto fraccionario,
  con desempate por clave canónica de línea, hasta alcanzar ese total redondeado.
- No redondear de forma independiente original, descuento y resultado: derivar el
  descuento publicado del original monetario menos el resultado publicado, y
  verificar no negatividad y conservación.
- Antes de salida, exigir precios regulares/oferta representables en la escala de
  la moneda. Si no lo son, la integración debe resolver esa discrepancia con Pricing.

**Este redondeo está implementado y adoptado internamente; la activación HTTP sigue pendiente de compatibilidad externa.**
`projectBenefitMoney` exige escala explícita (0–6), devuelve unidades mínimas
`bigint`, valida precios representables y conserva total/saldos/descuento. No hay
registro implícito de monedas. El ejemplo PEN usa escala 2 como entrada explícita.
No se convierten fracciones a `number` ni se conectan al DTO.
La aprobación de Marco no acredita que Pricing/Ventas o los demás consumidores la hayan aceptado.

## Ejemplos de aceptación

Todos usan políticas compatibles, importes antes del redondeo y ausencia de oferta
de Pricing salvo que se indique. La prioridad fija el orden mostrado.

| Caso                                                          | Cálculo                                     | Resultado                                         |
| ------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| 10 % y después 20 % sobre 100                                 | 100 × 0,9 × 0,8                             | 72; no sumar porcentajes.                         |
| A=60, B=40; fijo 30 en ambos; después 50 % solo en A          | Reparto 18/12; saldos 42/28; A queda 21     | 49.                                               |
| A=1, B=2; fijo 1 en ambos; después 50 % en A                  | Reparto 1/3 y 2/3; saldos finales 1/3 y 4/3 | 5/3 exacto; propuesta PEN 1,67.                   |
| Regular 100, oferta 80 y automática 15 % exclusiva            | Comparar 80 con 85                          | 80, campaña principal null.                       |
| Caso anterior con permiso para Pricing                        | 80 × 0,85                                   | 68.                                               |
| Exclusiva 50 % frente a combinación autorizada de 30 % y 40 % | Comparar 50 con 100 × 0,7 × 0,6             | 42.                                               |
| Fijo 50 sobre subtotal 30                                     | min(50,30)                                  | 0; no consume un cupón adicional sin ahorro.      |
| Automática 10 % prioridad 1 y cupón 10 % prioridad 2          | 100 → 90 → 81                               | Principal: automática; cupón identificado aparte. |

## Implementación, pruebas y activación

El motor está en `src/domain/benefit-composition.ts` y la proyección monetaria en
`src/domain/benefit-money.ts`. El archivo original de `test/proposals` reexporta
el motor para conservar las 26 pruebas de regresión, incluido el oráculo exhaustivo.
No existen importaciones desde los handlers HTTP ni desde `evaluateBasket`.
Está compilado, pero su ejecución pública sigue aislada. Usa entradas sintéticas explícitas y
ya elegibles; no sustituye Catálogo, Pricing, JWT, base de datos o broker.

La enumeración exacta sigue siendo exponencial y se acota técnicamente a 12
campañas y 100 líneas, con máximo 250 000 unidades de trabajo y 100 ms por defecto.
El presupuesto puede reducirse; el tiempo puede ampliarse explícitamente hasta
1 000 ms. Hay controles de reloj monotónico durante validación, búsqueda y reparto,
y antes de devolver. Los importes de entrada tienen límite de 128 caracteres.
Si se supera un límite se lanza `CompositionBudgetExceeded`: no se devuelve el
mejor candidato parcial, no se truncan campañas ni se usa una aproximación voraz.
Estos límites internos aún requieren revisión operativa antes de activar HTTP;
el futuro adaptador deberá traducir el agotamiento al error técnico contractual.
No se publican parámetros ni códigos nuevos. Las 26 regresiones originales y las
pruebas monetarias/budgets ejercitan el mismo motor compilado.

```powershell
npm test -- apps/promotions-svc/test/proposals/combination-policy.spec.ts --maxWorkers=1
```

| Dimensión                         | Estado                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Regla interna                     | Versión 1 adoptada por Marco el 26/10; no cambia DEC-F adoptadas.                                                                          |
| Motor interno                     | Implementado en src: fórmula, compatibilidad, identidades, conservación exacta y búsqueda acotada.                                         |
| Pruebas                           | Ejecución y resultado por separado en el reporte de la entrega.                                                                            |
| Redondeo/límites                  | Redondeo v1 adoptado internamente. Límites operativos requieren revisión antes de activar HTTP; snapshot/desglose depende de consumidores. |
| HTTP en producción                | Sin cambios; mantiene el gate de combinación múltiple y el provider comercial bloqueado.                                                   |
| Homologación externa / despliegue | No realizados.                                                                                                                             |

## Responsables y desbloqueo verificable

| Owner                                                          | Operación                                  | Evidencia necesaria                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Axel/Promotions + Marco/arquitectura G6                        | Composición interna y límites              | Regla v1 adoptada y verificada; revisión operativa de límites antes de activar HTTP.                                                                            |
| G6 + owners de Marketplace, Chatbot, Retail y Ventas/Postventa | Respuesta/snapshot de múltiples beneficios | Aceptación verificable de `promotion_id` principal; si hace falta desglose, contrato versionado y pruebas de consumidor. No se presume aceptación por silencio. |
| Pricing + Ventas/Postventa + G6                                | Salida monetaria y conciliación            | Confirmar escala/redondeo/reparto y ejemplos monetarios; verificar la implementación candidata contra la regla homologada.                                      |
| Catálogo/Pricing + integración G6/G7                           | Evaluación comercial real                  | Adaptadores con identidad autorizada y precios/elegibilidad coherentes para canal/instante.                                                                     |

La decisión interna queda registrada y verificada; no se atribuye aprobación a
otros owners. #72 permanece parcial por compatibilidad de consumidores y las
fronteras comerciales de #73 no se desbloquean por adoptar la fórmula.
