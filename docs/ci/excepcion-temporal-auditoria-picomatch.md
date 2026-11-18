# Excepción temporal de auditoría para `picomatch`

La GitHub Advisory Database retiró el aviso High `GHSA-fc5q-39xc-vjpf` el 18/11/2026. El registro consultado por `npm audit` todavía puede devolver ese aviso y propagarlo como High a herramientas de desarrollo. Esta excepción temporal conserva el audit completo y acepta exclusivamente propagaciones demostrables de ese identificador.

La excepción caduca al terminar el 25/11/2026 UTC. Desde el 26/11/2026, cualquier resultado High/Critical de ese aviso hace fallar el job. También falla ante otro identificador, una procedencia incompleta, un JSON o código de salida inesperado, un error del registro, o cualquier vulnerabilidad detectada por la auditoría de producción. Ningún resultado productivo vulnerable se acepta.

El riesgo residual no es nulo: retirar el aviso no garantiza que todo uso de patrones arbitrarios sea seguro. La aceptación se limita temporalmente a las dependencias de desarrollo, mantiene los informes completos como artefactos y no modifica el registro npm ni oculta resultados.
