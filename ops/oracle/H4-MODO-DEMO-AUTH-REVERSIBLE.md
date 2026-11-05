# H4 — Política operativa de seguridad progresiva y reversible

**Estado normativo:** la decisión de tres fases fue adoptada en Docs PR #114, fusionado el 05/11/2026. El HEAD autorizado fue `4837441d6b412e2b5ddce87f8f5b5f1904940075`; el merge publicado es `a7778ec1a22811c1213a94ef096ab905911342cc`. El texto de la política publicada conserva una frase de estado anterior que dice que el PR sigue pendiente; los metadatos de GitHub confirman el merge. Se registra aquí la discrepancia sin alterar la decisión ni fingir que esa frase es un estado actual.

**Implementación:** `G6_SECURITY_MODE` y el control transversal de las tres fases no están implementados en Backend `master` `921fcfa443499f0af9dc63360f664da7f4001d5d`. Este documento traduce la decisión para Oracle; no acredita runtime, homologación, grants, pruebas externas, despliegue ni autorización de release.

**Fuentes:** [Docs PR #114](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/pull/114), [política publicada](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/POLITICA-SEGURIDAD-PROGRESIVA-G6.md), [matriz de operaciones](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/MATRIZ-OPERACIONES-SEGURIDAD-G6.md), [Backend #144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144), OpenAPI y AsyncAPI oficiales. El PR #114 conserva el HEAD autorizado exacto; si cambia el HEAD, no se incorporan decisiones posteriores por inferencia.

## 1. Alcance y objetivo H4

La política cubre `api-gateway` y los ocho microservicios `catalog-svc`, `taxonomy-svc`, `pricing-svc`, `price-audit-svc`, `promotions-svc`, `combos-svc`, `inventory-svc` y `bulk-svc`, además de las fronteras HTTP y asíncronas correspondientes. La fase 3, `G7_AUTHENTICATED`, es el objetivo permanente. `PUBLIC_READ_ONLY` y `SIMULATED_AUTH` son fases temporales y reversibles.

El objetivo normativo de Fase 1 es ofrecer lectura funcional pública para todas las operaciones de lectura de los ocho microservicios. Puede incluir GET, HEAD, POST de consulta u otro método contractual demostrado como no mutante. Este objetivo de cobertura **no autoriza por sí mismo ninguna operación**. H4 mantiene su alcance oficial: la simulación no sustituye una evidencia G7 cuando la evaluación exija autenticación real.

## 2. Decisiones anteriores y reglas que siguen vigentes

Backend #144 estableció una demo sin JWT deshabilitada por defecto y condicionada a un entorno privado/restringido; prohibió exponer anónimamente escrituras administrativas y exigió mantener JWT, guards, contratos y reglas de negocio. Docs PR #114 sustituyó el requisito de perímetro privado **solo para cada lectura pública aprobada explícitamente por operación**. Las lecturas aprobadas no requieren VPN, Tailscale ni allowlist IP para sus visitantes.

Continúan vigentes para todo lo demás: default cerrado, activación explícita, ninguna identidad derivada de IP/URL/`Origin`/headers manipulables, puertos internos no públicos, mutaciones protegidas, autorización M2M, privacidad de datos, validación de negocio, límites, errores contractuales, integraciones reales, JWT preservado, sin fallback automático y sin cambios temporales a OpenAPI/AsyncAPI. El requisito histórico de perímetro privado continúa para cualquier ruta legacy que opere sin JWT y no tenga aprobación pública exacta. `SIMULATED_AUTH` usa JWT demo y debe aplicar sus controles de autenticación/autorización; no es una excepción de acceso anónimo.

La política de seguridad progresiva no crea DEC-F-016, no modifica DEC-F-001–015 ni cambia decisiones contractuales. El historial y las evidencias de octubre descritos en otras fichas son cortes históricos, no estado perpetuo.

## 3. Arquitectura de fases

| Fase | Identificador | Comportamiento operativo |
|---|---|---|
| 1 | `PUBLIC_READ_ONLY` | Sin JWT únicamente en lecturas con aprobación pública exacta y evidencia vigente. No es bypass global. |
| 2 | `SIMULATED_AUTH` | JWT firmado por emisor demo independiente de G7 y autorización declarativa por identidad/operación. |
| 3 | `G7_AUTHENTICATED` | JWT y grants reales de G7; fase objetivo. Rechaza tokens simulados. |

Las transiciones requieren configuración validada y reinicio/redeploy controlado. Deben conservar guards JWT, autorización contractual, validaciones y lógica de negocio. Gateway y microservicio verifican cada uno su frontera; la excepción del Gateway no elimina autorización del servicio.

## 4. Fase 1 — acceso público reversible

La autorización es por `operationId`, método y ruta exacta, nunca por método HTTP, prefijo o microservicio. Para cada operación candidata, registrar servicio, método, ruta, `operationId`, decisión/aprobador, evidencia de no mutación, sensibilidad, dependencias, pruebas y SHA. La falta de evidencia mantiene el estado pendiente. Cambios futuros a una autorización pública exigen actualizar la lista y repetir las pruebas por SHA.

En el corte documental autorizado, la matriz contiene **136 operaciones**: **59 GET** y **7 POST identificados como posibles consultas**; entre las 66 lecturas, **51 `PENDIENTE_VERIFICACION`**, **15 `EXCEPCION_JUSTIFICADA`** y **0 `PUBLICA_APROBADA`**. Son conteos de ese corte, no valores perpetuos. No se cambia ninguna clasificación de Docs desde Backend.

La revisión funcional debe demostrar que una consulta no crea/actualiza/elimina negocio, reserva o mueve stock/cupos, programa trabajos, publica comandos/eventos mutantes, induce mutaciones aguas abajo ni requiere identidad comercial para invariantes. La telemetría no mutante no la vuelve mutante; un POST no es lectura por su verbo.

Casos que necesitan revisión específica:

- Lecturas administrativas no son públicas automáticamente; revisar campos, sensibilidad, actor y efectos.
- Lecturas internas M2M conservan sus clientes/scopes y su frontera salvo homologación/cambio contractual autorizado.
- `x-internal: true` permanece privada.
- POST de consulta requiere evidencia de implementación y pruebas, además de aprobación exacta.
- Cualquier operación que genere eventos o efectos en otros servicios no es lectura pura.
- Lecturas ligadas a identidad comercial y datos potencialmente sensibles permanecen protegidas mientras esa dependencia exista.
- `obtenerContextoSku` y otras operaciones privadas no se publican automáticamente.

## 5. Fase 2 — `SIMULATED_AUTH`

Usa JWT firmados por un emisor de demostración independiente de G7, con claves privadas exclusivas y separadas. Debe contemplar identidades técnicas por módulo y humanas de prueba, roles, scopes, audiencias, permisos por operación, matriz declarativa y casos positivos/negativos con errores 401/403 del contrato. No se usará IP, URL, `Origin`, `Referer`, `X-Forwarded-For` ni headers manipulables como identidad principal.

El emisor y sus tokens no se presentan como G7, no comparten claves privadas de G7 y nunca se aceptan en Fase 3. Las credenciales privadas se suministran como secretos runtime, nunca en este repositorio ni en el PR documental.

## 6. Fase 3 — `G7_AUTHENTICATED`

Conserva issuer/discovery/JWKS oficiales, validación criptográfica, audience contractual, scopes/roles y permisos efectivos, identidades humanas y M2M, MFA cuando corresponda, introspección cuando la exija el contrato G7, homologación y pruebas con tokens reales. El token simulado se rechaza. La indisponibilidad de G7 falla cerrada y nunca activa automáticamente una fase anterior.

## 7. Selector propuesto y flags existentes

Selector común propuesto, aún no implementado:

```dotenv
G6_SECURITY_MODE=G7_AUTHENTICATED
```

Valores futuros: `PUBLIC_READ_ONLY`, `SIMULATED_AUTH`, `G7_AUTHENTICATED`. El diseño exige default autenticado, valor explícito, valores inválidos rechazados, validación al arranque, ausencia de fallback y compatibilidad entre Gateway y servicio. **No existe compatibilidad actual entre este selector y los flags de la tabla.** No renombrar ni reinterpretar esos flags hasta un cambio de código autorizado.

Inventario estático de Backend `master` `921fcfa443499f0af9dc63360f664da7f4001d5d` (valor predeterminado cuando no está definido; ubicaciones indicadas son parsers/consumidores de runtime):

| Componente | Flag / parser | Default y comportamiento comprobado | Restricciones actuales | Relación futura con `G6_SECURITY_MODE` / brecha |
|---|---|---|---|---|
| API Gateway | `GATEWAY_DEMO_NO_AUTH_ENABLED` — `apps/api-gateway/src/routing/gateway-settings.ts` | `false`; activa modo demo sin JWT restringido por rutas actuales. | Solo booleano literal; excluyente con el flag read-only. No otorga acceso general. | Mapear solo tras implementar y probar fase/operación compatible; sin mapeo hoy. |
| API Gateway | `G6_READ_ONLY_DEMO_ENABLED` — mismo parser | `false`; conserva excepción read-only heredada. | Booleano literal; no se combina con demo no-auth. | No equivale a aprobación de Fase 1. Integrar lista exacta aprobada y selector en cambio futuro. |
| API Gateway | `GATEWAY_PUBLIC_OPERATION_IDS` — mismo parser | Cadena vacía; valida IDs contra rutas contractuales marcadas sin `security`. | No acredita aprobación de Docs ni revisión de no mutación; una ruta sin security no es concesión de política pública. | Falta cotejo con matriz aprobada, método/ruta exactos y un selector común. |
| Catalog | `G6_READ_ONLY_DEMO_ENABLED`, `GATEWAY_DEMO_NO_AUTH_ENABLED` — `apps/catalog-svc/src/catalog-read-demo.ts` | Ambos `false`; read-only habilita la política heredada; el segundo selecciona demo restringida. | No pueden activarse juntos; el modo restringido valida `CATALOG_DEMO_GATEWAY_IPS` con IP privadas literales. `CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED` es preview funcional separado, default false, no flag de autorización. | No mapear uno-a-uno: la aprobación pública por operación aún no está conectada al selector. Mantener la demo restringida separada. |
| Taxonomy | `ALLOW_DEMO_UNAUTHENTICATED` — `apps/taxonomy-svc/src/taxonomy-auth.ts` | Ausente/`false`; demo local apagada. | `true` solo se admite con `NODE_ENV=test` o `development`; producción rechaza esa configuración. | No implementa `PUBLIC_READ_ONLY` en runtime Oracle. Se requiere mecanismo explícito por operación y selector. |
| Pricing | `GATEWAY_DEMO_NO_AUTH_ENABLED`, `PRICING_DEMO_PRODUCTION_CONFIRMED` — `apps/pricing-svc/src/config/environment.ts` | Ambos `false`; demo apagada. | En production el segundo debe ser `true` si se activa el primero. | La confirmación actual no representa aprobación de operaciones ni modo común. |
| Price Audit | No hay flag demo de bypass en `apps/price-audit-svc/src/config/environment.ts` ni guard HTTP. | Solo configuración JWT opcional por pareja `AUTH_ISSUER`/`AUTH_JWKS_URL`; si se configura una, se exige la otra. | Los guards verifican JWT; el flag de Gateway no cambia esta política en el servicio. | Implementación de las tres fases y selector pendiente. |
| Promotions | `GATEWAY_DEMO_NO_AUTH_ENABLED` — `apps/promotions-svc/src/infrastructure/config/promotions-config.ts` | `false`; demo apagada. | Activación explícita y validaciones adicionales de entorno/par TCP del Gateway en el modo restringido. | No autoriza lecturas públicas ni se sincroniza con selector común. |
| Combos | `COMBOS_RESTRICTED_DEMO_ENABLED`, `COMBOS_RESTRICTED_DEMO_GATEWAY_IPS`, `COMBOS_RESTRICTED_DEMO_NETWORK_CONFIRMED`, `COMBOS_RESTRICTED_DEMO_PRODUCTION_CONFIRMED` — `apps/combos-svc/src/config/combos-environment.ts` | Demo `false`; lista vacía; confirmaciones ausentes. | Activación restringida exige red confirmada, IP Gateway y confirmación de producción en `NODE_ENV=production`. | Demo de red es independiente de `PUBLIC_READ_ONLY`; selector común y modos multi-fase pendientes. |
| Inventory | `INVENTORY_DEMO_NO_AUTH_ENABLED`, `INVENTORY_DEMO_GATEWAY_IPS` — `apps/inventory-svc/src/config/inventory.config.ts` | `false`; lista vacía. | Flag `true` requiere IP literales; guards limitan el bypass a operaciones puntuales y comparan par de socket, no headers. | No ampliar su ámbito por la política; necesita aprobación explícita por operación y selector. |
| Bulk | `GATEWAY_DEMO_NO_AUTH_ENABLED`, `BULK_DEMO_GATEWAY_IPS` — `apps/bulk-svc/src/auth/bulk-user-bearer.guard.ts` | Flag no igual a `true` mantiene JWT; lista vacía. | Solo omite guard cuando el par de socket coincide con allowlist configurada. | Demo restringida existente no equivale a lectura pública; parser/selector y matriz pública pendientes. |

Flags de autenticación JWT (issuer/JWKS/keys/audience) siguen su configuración contractual propia; no son el selector de fases. No se incluyen flags que solo afectan tests, readiness, datos o CI. Los valores secretos de Oracle no se consultan ni documentan.

## 8. Caddy, Gateway y microservicios

**Caddy:** termina HTTPS público y enruta únicamente al API Gateway. Para operaciones aprobadas no requiere VPN, Tailscale ni allowlist IP del visitante. Mantiene puertos internos fuera de Internet, aplica timeouts y límites de tamaño adecuados, y no concede identidad/permisos. CORS es control del navegador, no autenticación.

**Gateway:** identifica método, ruta y `operationId` exactos usando un registro contractual; aplica la política activa, valida JWT en fases 2/3, rechaza rutas no registradas y escrituras anónimas, elimina spoofing de headers de identidad, propaga correlación contractual y no actúa como proxy abierto. Estas capacidades de política progresiva son requisitos previstos y no se afirman como implementadas en conjunto.

**Microservicio owner:** vuelve a autorizar independientemente; conserva guards originales, permisos, validaciones, lógica, persistencia e integraciones. No acepta bypass de identidad en operaciones no aprobadas. La decisión del Gateway no sustituye el control del servicio.

## 9. Reversibilidad

### 9.1 Reversión de fase

Cambiar fase mediante configuración validada y reinicio/redeploy autorizado, sin reescribir controladores o lógica de negocio. Al volver a `G7_AUTHENTICATED`, el Gateway y los servicios vuelven a exigir JWT y permisos aplicables; tokens demo se rechazan; no hay fallback anónimo; las excepciones no persisten fuera de las lecturas que sigan aprobadas y activas. Probar una lectura antes pública sin token, un token demo, token G7, scopes/roles insuficientes y rutas privadas.

La caída de G7 no autoriza degradar fase. Una recuperación hacia menor seguridad exige autorización explícita de Marco, motivo, alcance, duración, SHA/configuración y pruebas; nunca ocurre automáticamente.

### 9.2 Rollback de imágenes/configuración

Es independiente del cambio de fase. Antes de cada release, registrar imagen actual y anterior por digest/SHA, configuración efectiva no secreta, versión de Caddy/Gateway, configuración runtime referenciada sin valores secretos y datos de recuperación. El procedimiento conceptual selecciona la imagen/digest anterior y restaura configuración compatible, valida liveness/readiness, rutas, autenticación, puertos y pruebas HTTP aprobadas. Si no hay imagen previa, se sigue el procedimiento de primer despliegue del checklist en entorno aislado; no se afirma rollback remoto probado en Oracle.

La Fase A reportó como corte histórico imágenes de octubre y ausencia de `previous-image` para Taxonomy y Catalog. Ese dato no describe necesariamente el estado actual y debe verificarse antes de cualquier release. Registrar digest antes/después y resultados de recuperación.

## 10. Pruebas de aceptación por fase

| Caso | Fase 1 | Fase 2 | Fase 3 |
|---|---|---|---|
| Lectura aprobada exacta | Anónima permitida solo en la fila aprobada | JWT demo y permiso | JWT G7 y permiso |
| Lectura pendiente/privada/M2M | Denegada anónimamente | JWT/actor/scopes autorizados | JWT G7/grant autorizado |
| Escritura sin JWT | Denegada | Denegada | Denegada |
| Token ausente/inválido, firma/issuer/audience/exp incorrectos | No amplía excepción | 401 contractual | 401 contractual |
| Rol/scope insuficiente | Denegado | 403 contractual | 403 contractual |
| Operación desconocida o modo/config incompatible | Falla cerrada | Falla cerrada | Falla cerrada |
| Salida de Fase 1 | Anónimo previamente aprobado se deniega | No hay acceso anónimo | No hay acceso anónimo; token demo rechazado |
| Caída de G7 | No concede excepciones nuevas | No activa fase 1 | Falla cerrada |

Guardar fase, operación exacta, versión de contrato, SHA, entorno y evidencia. Separar pruebas locales, CI, autenticación real, homologación externa y despliegue. Una prueba documental no verifica seguridad runtime.

## 11. Condiciones previas para activar Fase 1 en Oracle

No activar hasta verificar todos los puntos aplicables y asociar evidencia al SHA:

1. Aprobación operación por operación y lista exacta versionada.
2. Implementación correspondiente en Gateway y microservicio.
3. Caddy enruta solo a Gateway con HTTPS y configuración autorizada.
4. Escrituras, administración, rutas desconocidas, M2M y operaciones privadas deniegan acceso anónimo.
5. Revisión de datos y ausencia de filtración sensible.
6. Dependencias reales y efectos HTTP/eventos revisados.
7. Readiness, límites, timeouts y pruebas HTTP positivas/negativas.
8. Reversión de fase probada, incluidas denegaciones al salir de Fase 1.
9. Imagen anterior/digest y recuperación de configuración disponibles o contingencia de primer despliegue probada aisladamente.
10. Aprobación explícita de Marco para el alcance y release.

Taxonomy y Catalog se prepararán primero para evaluación de operaciones y evidencia. Esta prioridad no aprueba endpoints ni autoriza despliegues.

## 12. Pendientes de implementación y dependencias

- Implementar selector `G6_SECURITY_MODE`, parser con default `G7_AUTHENTICATED`, rechazo de valores inválidos y validación de compatibilidad Gateway/servicios.
- Definir/configurar una lista por SHA de operaciones exactas aprobadas; el corte Docs consultado tiene cero aprobadas.
- Implementar controles coordinados en Gateway y owners sin eliminar autorización local.
- Implementar y probar emisor/matriz JWT simulados independientes de G7.
- Mantener integración real G7, provisionamiento de grants y pruebas bilaterales como trabajo separado.
- Owner responsable de G7: Seguridad G7/Marco | operación afectada: autenticación de Fase 3 | desbloqueo: issuer/JWKS, audiencia, clients/grants, scopes/roles y tokens reales disponibles y homologados.
- Owner responsable de cada operación externa M2M: owner consumidor y owner de servicio | operación afectada: frontera identificada en la matriz | desbloqueo: contrato/acuerdo, autorización y prueba bilateral verificables.
- No declarar `READY_FOR_DEPLOY` por esta documentación ni mientras falte cualquier gate aplicable.

## 13. Referencias

- [Política de seguridad progresiva de Docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/POLITICA-SEGURIDAD-PROGRESIVA-G6.md)
- [Matriz de operaciones de seguridad G6](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs/blob/master/arquitectura/decisiones/MATRIZ-OPERACIONES-SEGURIDAD-G6.md)
- [Backend #144](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/144)
- [Contrato de despliegue](CONTRATO_DESPLIEGUE.md), [checklist predeploy](CHECKLIST_PREDEPLOY.md), [matriz de dependencias](MATRIZ_DEPENDENCIAS.md) y fichas de [`servicios/`](servicios/).
- OpenAPI/AsyncAPI y decisiones adoptadas del repositorio Docs; esta traducción operativa no los sustituye.
