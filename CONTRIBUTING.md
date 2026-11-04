# Guía de Contribución al Backend (G6 — Productos y Ofertas)

Esta guía establece el flujo de trabajo para desarrolladores y agentes de IA en el backend monorepo NestJS.

---

## 1. Lectura Obligatoria

Antes de comenzar cualquier desarrollo, es imperativo leer:
- [AGENTS.md](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/blob/master/AGENTS.md): Normas operativas, matriz de ownership, prohibiciones y protocolo para agentes.

---

## 2. Flujo de Trabajo

El flujo estándar de entrega es:

```text
Issue asignado → Rama personal permanente → Implementación localizada → Pruebas locales → PR hacia master → Aprobación
```

1. **Revisar el Issue:** Verificar criterios de aceptación y microservicio asignado.
2. **Posicionarse en la rama personal:** Trabajar exclusivamente en la rama correspondiente (`castilla`, `poma`, `cueva`, `lopez`, `vera` o `taco`). No crear ramas por feature (`feat/...`, `fix/...`).
3. **Consultar contratos normativos:** Verificar las especificaciones y contratos oficiales en el repositorio [G6-Productos-Ofertas-docs](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-docs).
4. **Clasificar y delimitar el trabajo:** Aplicar las DEC-F-001 a DEC-F-015 adoptadas por G6 al bounded context correspondiente. Usar `IMPLEMENTAR_AHORA` para lógica propia definida, `IMPLEMENTAR_PARCIAL` para avanzar manteniendo aislada la frontera pendiente y `BLOQUEADO_ESPECÍFICO` solo para la operación que dependa de una respuesta externa. Una discrepancia intermodular localizada no paraliza todo el microservicio. Registrar cada dependencia con owner, operación afectada y condición exacta para desbloquearla.
5. **Implementación y pruebas:** Realizar únicamente cambios dentro del microservicio asignado. Prohibido modificar aplicaciones ajenas. Comunicar a los consumidores afectados el cambio previsto, regla DEC-F, impacto contractual, versión y adaptación requerida; no se necesita autorización externa para desarrollar lógica interna propia de G6.
6. **Ejecutar validaciones:**
   ```bash
   npm test          # Pruebas unitarias
   npm run test:e2e  # Pruebas e2e
   npm run typecheck # Verificación TypeScript
   npm run lint      # Análisis estático
   ```
7. **Distinguir evidencia:** Reportar por separado implementación interna, pruebas locales, integración autenticada, homologación externa y despliegue. Cada estado requiere evidencia propia; no inferir uno a partir de otro. Antes de publicar como definitivo un cambio incompatible de contrato compartido, obtener homologación verificable de los módulos concernidos.
8. **Abrir Pull Request:** Abrir PR hacia `master` desde tu rama personal con alcance pequeño y atómico. La rama `master` exige PR y revisión obligatoria para merge.

---

## 3. Responsabilidad

- Cada desarrollador es plenamente responsable del código, commits y Pull Requests generados en su rama, incluidos los producidos por asistentes o agentes de IA.
- Todas las pruebas deben ser ejecutadas efectivamente antes de reportar o abrir un PR. Si algún comando no fue ejecutado, debe informarse explícitamente como `NO EJECUTADO`.

## H4 G1 Marketplace

Para cualquier cambio en servicios consumidos por Marketplace, revisa primero [`integraciones/g1-marketplace/README.md`](integraciones/g1-marketplace/README.md), matriz y pruebas; verifica el OpenAPI y las reglas del servicio. No inventes interfaz por mocks. El cliente técnico vive en BFF G1 servidor-servidor; nunca envíes secretos al navegador. Los flags `GATEWAY_DEMO_NO_AUTH_ENABLED` / `DEMO_NO_AUTH` solo corresponden al modo demo temporal y no satisfacen H4. Registra explícitamente qué pruebas son mocks, provider, autorización real o E2E.
