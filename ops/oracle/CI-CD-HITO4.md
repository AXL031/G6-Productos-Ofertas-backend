# Verificaciones de CI/CD para Hito 4

## Integración continua

Cada job de `.github/workflows/ci.yml` informa su resultado por separado: automatización/actionlint, TypeScript, calidad, formato, pruebas unitarias, pruebas E2E, contratos y datos iniciales, compilación, imágenes de contenedor, persistencia/mensajería e infraestructura Oracle. Taxonomy, Inventory, Pricing, Price Audit, Promotions y Marketplace conservan sus pruebas especializadas con dependencias desechables. El job `Validación integral de integración continua` comprueba que cada trabajo obligatorio finalice `success`; fallo, cancelación, omisión o resultado ausente fallan el agregador.

El contexto `Lint, Typecheck, Test, Build & Smoke Test` se mantiene como compatibilidad temporal. El ruleset activo todavía lo exige. Ambos agregadores dependen de la misma lista de jobs y usan el mismo verificador de resultados.

## Despliegue Oracle

El CD mantiene GitHub Actions → GHCR → Tailscale OIDC → SSH restringido → Docker Compose en Oracle. La CI solo construye imágenes locales desechables y configura Compose para verificaciones; no publica en GHCR ni conecta con Oracle. El SHA de 40 caracteres identifica el código y tag inmutable de la imagen; el script de reserva valida repositorio, servicio y revisión antes de reutilizarla. El digest identifica los bytes publicados cuando GHCR aporta esa evidencia.

Estados independientes: compilación satisfactoria; imagen publicada; despliegue solicitado/registrado; despliegue ejecutado; Docker health y `/health` saludable; readiness; prueba funcional; recuperación ejecutada y comprobada. `/health` confirma liveness y nunca prueba comportamiento funcional. Las pruebas funcionales requieren contrato aprobado y fixture no destructiva. La comprobación real en Oracle (incluidos SHA/digest remotos, health/readiness/operaciones y recuperación del servicio desplegado) requiere autorización y credenciales operativas y queda pendiente para una fase posterior.

Los resultados del selector vacío de CD automático son una omisión intencional con evidencia: `auto-release-authorization.psv` conserva nueve filas `false`; no autoriza publicar, desplegar ni omitir gates de CI. Una ejecución descartada por SHA obsoleto se informa como omitida/bloqueada, no como despliegue satisfactorio.

## Migración del check requerido de `master`

1. Mantener el job de compatibilidad `Lint, Typecheck, Test, Build & Smoke Test` hasta cambiar el ruleset. No alterar el ruleset durante esta rama.
2. Después de integrar esta transición, editar `Proteccion de master` para exigir también `Validación integral de integración continua`. Guardar el ruleset con ambos contextos requeridos.
3. Abrir un PR de prueba y confirmar en sus checks que ambos contextos aparecen y que una validación fallida deja ambos en fallo. Comprobar por API/UI que el ruleset activo sigue exigiendo los dos nombres.
4. Solo después de confirmar el nuevo contexto obligatorio en el ruleset, retirar el job de compatibilidad en otro cambio revisado. Verificar otra vez un PR y confirmar que master continúa protegido por el nuevo contexto.

No cambiar el nombre requerido remoto antes de que el check nuevo exista en una ejecución de PR. No usar aprobación por silencio.

## Evidencias presentables y pendientes

Se pueden mostrar en el PR: jobs de CI separados, salida de actionlint, pruebas del agregador para éxito/fallo/cancelación/omisión, pruebas de selector/procedencia, ciclo simulado de GitHub Deployments, aislamiento de publicación/recuperación, validaciones del registro cerrado y builds/smokes locales con contenedores desechables. Estas evidencias corresponden al SHA de la rama y no demuestran actividad en Oracle.

## Ejecución verificada en GitHub

El run [41382158746](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/actions/runs/41382158746) terminó correctamente para el SHA `cf0e34fa00bcce4eadb64ef57a63665adf8e8f55`: GitHub Actions reportó satisfactorios los 14 trabajos obligatorios de CI y ambos agregadores (16 trabajos en total). Esto acredita únicamente las comprobaciones ejecutadas por ese run en GitHub, incluidas las pruebas con dependencias desechables. No acredita publicación productiva en GHCR, conexión ni despliegue en Oracle, salud/readiness remota, operaciones funcionales remotas ni recuperación real.

Pendiente: ejecutar y revisar un run para el SHA final de esta corrección; confirmar la aparición simultánea de ambos checks en el ruleset. Las comprobaciones remotas de Oracle —publicación con digest, ejecución, salud/readiness/operación funcional y recuperación— requieren autorización independiente e infraestructura operativa. Las nueve autorizaciones automáticas permanecen deshabilitadas.
