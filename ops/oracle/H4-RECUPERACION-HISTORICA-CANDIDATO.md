# Recuperación histórica: código candidato aislado

Estado de este SHA: lógica interna y pruebas unitarias incorporadas; ruta HTTP, migración compartida, consumidor/adaptador de Pricing y activación no incorporados.

## Catalog (#194)

- `HistoricalRecoveryService`, su esquema candidato y sus pruebas se conservan en `apps/catalog-svc/src/`.
- El servicio no está registrado en `AppModule`; no hay controller ni ruta en el build de este SHA.
- La configuración de capacidades devuelve una lista vacía por defecto. La existencia del parser no concede una identidad ni publica el flujo.
- La migración propuesta por el PR no se copia ni se aplica a Supabase compartido.

## Pricing (#205)

- `selectHistoricalValidity` valida una selección inequívoca sin mutar el registro y cuenta con pruebas de conflicto y límites.
- La función no está conectada al consumidor de inicialización. No se modifica el contrato de eventos ni se activa un adaptador Pricing histórico.

## Desbloqueo

- Owner de respuesta: Marco/arquitectura G6, con homologación de Pricing e Inventory.
- Operación afectada: recuperación de preparaciones históricas Catalog y su futura inicialización de Pricing/Inventory.
- Condición verificable: contrato compartido aprobado y versionado, permisos e identidad M2M homologados, migración revisada para un entorno aislado, y E2E autenticado con evidencia asociada al SHA antes de registrar la ruta o el consumidor.

Este estado no bloquea lecturas o escrituras ordinarias de Catalog y Pricing ni forma parte de la allowlist pública H4.
