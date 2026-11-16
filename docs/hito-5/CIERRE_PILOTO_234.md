# Cierre del piloto — Backend #234

Seguimiento: [Issue #234](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/234). Fecha: 2026-11-16. Axel resolvió expresamente el alcance final: **«Mantener piloto aislado; no omitir consumidores»**. El cierre corresponde al piloto aislado; activar el transporte en las aplicaciones compartidas es un trabajo posterior separado.

## Autorizaciones registradas

Axel autorizó implementar Pricing/Audit y archivos comunes, continuar Azure real y cerrar el piloto. Posteriormente autorizó expresamente una excepción para aprobar nosotros mismos la migración y release; [registro](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/issues/234#issuecomment-6923579888). No se atribuye aprobación independiente a Marco. También autorizó preparar la rama temporal `sb-piloto-234`, sin prefijo `codex/`, conservando `cueva` intacta.

La excepción de autoaprobación usa exclusivamente `azure-h5-pilot-234`, revisor único AXL031 y ramas restringidas a `master`. El workflow la rechaza para todos los selectores salvo `pricing-svc` o `price-audit-svc`; default conserva `azure-h5` con prevención de autoaprobación. El environment general no fue debilitado. El entorno específico ya está creado; su OIDC selecciona el subject exacto del environment, sin secreto de service principal.

## Completado

- Configuración de producción con activación explícita `G6_SERVICE_BUS_PRODUCTION_ENABLED=true`, `G7_AUTHENTICATED`, `AZURE_CLIENT_ID` válido y sin AMQP simultáneo. Cuando hay client ID se usa `ManagedIdentityCredential`, sin fallback al usuario CLI.
- Preparación ACA pura: identidad distinta por workload y mínimo una réplica para Pricing/Audit; se rechazan planes incompletos o compartidos. El render no es un deploy ni sustituye los guards de release.
- Azure real: arranque completo de ambas apps Nest con `NODE_ENV=production`, PostgreSQL 16 y TLS/CA validado, SDK con identidades administradas, Outbox SQL anterior al arranque procesado sin tráfico HTTP, cierre y nuevo arranque recuperan otro pendiente. Health/readiness 200 en estado operativo; al cerrar el worker, health conserva 200 y readiness pasa a 503.
- Contrato, efecto único tras reentrega, permisos cruzados rechazados y DLQ real comprobados. El smoke HTTP verifica rechazo anónimo; el issuer `.invalid` del laboratorio no acredita autenticación positiva con G7.
- Supabase: migración `20261116171655_h5_pricing_outbox_delivery_pilot` aplicada con `po_pricing_owner`, sin históricos ni backfill; tabla inicialmente vacía. `pricing_app`: SELECT/INSERT/UPDATE; sin DELETE. `anon` y `authenticated`: sin acceso. Verificación posterior ejecutada.
- Alertas Azure Monitor `g6-sb-pilot-dlq` y `g6-sb-pilot-backlog` desplegadas, métricas verificadas. Se crean alertas de portal, sin destinatarios externos inferidos. La edad del Outbox SQL se observa con `outbox-observation.sql`; no se afirma que ya exista un scheduler SQL productivo.
- Cuatro mensajes propios del laboratorio archivados por ID/hash/razón y completados individualmente; cero activos y cero DLQ en la consulta posterior. Sin replay ni purga de mensajes ajenos.
- Imágenes Docker reales construidas para ambos servicios; fallo de red inicial de npm corregido con un reintento, sin cambiar Dockerfile/dependencias.

## Validación

| Comprobación | Resultado |
|---|---|
| Unitarias monorepo | 2.627 PASS, 73 omitidas |
| E2E monorepo final | 1.053 PASS, 259 omitidas; piloto PostgreSQL habilitado |
| Configuración/mensajería específica | 27 PASS |
| Pruebas Node de render/identidades/deploy | 54 PASS |
| Guards Bash de release | PASS: default estricto y excepción solo Pricing/Audit |
| typecheck/builds Pricing/Audit | PASS |
| lint/formato | PASS, 4 advertencias previas |
| npm audit producción | 0 vulnerabilidades |
| Actionlint 1.7.12 del workflow | PASS |
| Azure full Nest/TLS/reinicio | PASS, bundle `04edefaa99b16615ac750368d22c10728909abaa17ea0ee07e67afe26423dc26` |

El primer E2E general encontró copias de suites dentro del contexto temporal Docker. Se detuvo, se retiró únicamente ese contexto y se repitió la suite original con el resultado anterior. Los logs fallidos se conservaron, sin editar tests originales.

## Gates que aún no se declaran cerrados

- Commit/PR oficial y CI exacta del SHA: la rama `cueva` contiene historia ajena. Se prepara `sb-piloto-234` desde master con el diff acotado; conserva el lockfile oficial, que ya tiene los SDK exactos.
- El evento contractual también tiene consumidores Promotions/BFF. Por decisión expresa del usuario el piloto queda aislado y no se activa en Pricing compartido. No se omiten sus entregas ni se marca migración global.
- Despliegue de imagen oficial, configuración de identidad/escala en apps existentes, smoke remoto y rollback de revisión requieren evidencia propia. Las pruebas de laboratorio no se presentan como despliegue de las apps actuales.
- No hay runner `azure-h5-smoke` registrado. El smoke debe ejecutarse desde la red autorizada; no se expondrán endpoints internos para sustituirlo.
- La decisión arquitectónica global y las migraciones de otros servicios quedan fuera del piloto; no se cierra RabbitMQ ni se declara homologación G5/G7.

Estado de este corte: código, SQL, identidad, laboratorio y operación verificados; pendiente registrar publicación y CI del SHA exacto para cerrar #234. La activación compartida queda fuera del alcance final por decisión del usuario.
