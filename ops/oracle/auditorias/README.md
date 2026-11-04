# Índice de auditorías manuales Oracle

## Estado actual

- [ESTADO_ACTUAL.md](../ESTADO_ACTUAL.md): resumen operativo vigente basado en observación del 2026-10-19.
- [Auditoría 2026-10-19 22:32 UTC](2026-10-19_22-32-52_UTC/RESUMEN.md): SSH, Docker, HTTP/TLS, RabbitMQ, runtime y CI/CD.

La auditoría del 17 de octubre que sigue abajo conserva su valor histórico. No se modificaron sus diez documentos.

## Trazabilidad

- ID: G6-ORACLE-20261017T011831Z
- Inicio UTC: 2026-10-17T01:18:31Z / Lima 2026-10-16T20:18:31-05:00
- Fin de observación UTC: 2026-10-17T01:32:03Z / Lima 2026-10-16T20:32:03-05:00
- Hostname: g6-po-vcn · IP: 157.137.205.218
- VM OCI: ocid1.instance.oc1.sa-bogota-1.anrgcljrdootsrackizlzau3lpu7dgpcljyhkropav75k65zran5iqlghxba
- Usuario SSH: ubuntu
- Rama: castilla · SHA auditado: 741258510bf5350f172c165fb061643d49db439b
- SHA de master consultado: 9cd6edcef6039ebdf9f1f94c9e991b0358ffc9de
- Archivo: README.md
- Alcance: índice cronológico de auditorías manuales
- Estado: referencia al commit que introdujo el informe registrada después de su creación

## Historial

| ID | Fecha UTC / Lima | Carpeta | Dictamen | Hallazgos P0/P1/P2/P3 | Commit que contiene el informe | Resumen |
|---|---|---|---|---|---|---|
| G6-ORACLE-20261019T223252Z | 2026-10-19 22:32–22:36 / 17:32–17:36 | [2026-10-19_22-32-52_UTC](2026-10-19_22-32-52_UTC/) | PARCIAL; 4 aplicaciones presentes, 5 ausentes; readiness incompleta | 0 / 3 / 3 / 1 | Pendiente de commit | [RESUMEN.md](2026-10-19_22-32-52_UTC/RESUMEN.md) |
| G6-ORACLE-20261017T011831Z | 2026-10-17 01:18–01:32 / 2026-10-16 20:18–20:32 | [2026-10-17_01-18-31_UTC](2026-10-17_01-18-31_UTC/) | APROBADO CON OBSERVACIONES; release HTTP no aprobado | 0 / 5 / 2 / 1 | [b833e0fef3ccc06c651099994c4096ea2503849d](https://github.com/Taller-SW-Web/G6-Productos-Ofertas-backend/commit/b833e0fef3ccc06c651099994c4096ea2503849d) | [RESUMEN.md](2026-10-17_01-18-31_UTC/RESUMEN.md) |

Auditoría puntual de solo lectura. No se ejecutaron despliegues ni se modificó Oracle.
