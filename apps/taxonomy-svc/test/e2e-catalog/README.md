# Evidencia E2E cruzada Taxonomy–Catalog

`evidence.json` conserva el resultado histórico ejecutado sobre el backend `61cbd36e52fbfac5f7caf0d9ff47fcdcc7507e03`, antes del commit `e77c16306b3c1e055ece1953e348cf41158ff1d0` que incorporó el ejecutor y ese registro. Ambos commits tienen el mismo árbol de código productivo de Taxonomy (`7873b0cf494ade15f84414cb3f8fa8dfb1510452`) y no difieren en `apps/catalog-svc/src`. Esa evidencia histórica no acredita los escenarios agregados después.

Cada nueva ejecución guarda `evidence-latest.json` sin sobrescribir la evidencia histórica. Registra SHA de backend, último commit que modifica Catalog, árboles de código, SHA de documentación, SHA-256 del ejecutor y si este coincide con el commit. Rechaza modificaciones locales del código y configuración de compilación, compila ambos servicios antes de cargar sus módulos y verifica nuevamente el SHA y estado. Una ejecución con `runnerMatchesCommit: false` acredita los árboles de servicio identificados y la huella del ejecutor, pero no un ejecutor ya incluido en ese commit.

El job de CI publica el JSON y los logs como artefacto asociado al SHA probado. Los registros no acreditan despliegue ni homologación externa. El producto activo de la prueba y sus estados de preparación son datos sintéticos en PostgreSQL desechable; Pricing e Inventory no participan. El arranque de Catalog usa `isolatedTestRecovery: true` únicamente con `NODE_ENV=test`.

Para ejecutar localmente, instala dependencias y coloca el repositorio de documentación oficial como directorio hermano `G6-Productos-Ofertas-docs`. Se requieren Docker, OpenSSL y la historia Git del backend (en un clon superficial: `git fetch --unshallow`). Después ejecuta:

```sh
node apps/taxonomy-svc/test/e2e-catalog/run.mjs
```

La prueba crea sus propios contenedores, roles, esquemas y datos. No acepta URL de base o broker del entorno y elimina los contenedores al terminar. No usa Supabase ni modifica el broker compartido.
