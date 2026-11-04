# Inventario de VM y recursos

**Fuente:** inspección SSH 2026-10-19 22:32–22:36 UTC; consola OCI no consultada.

| Propiedad | Observación | Estado |
|---|---|---|
| Hostname | `g6-po-vcn` | CONFIRMADO |
| SO / kernel | Ubuntu 24.04.5 LTS; `7.0.0-1013-oracle` | CONFIRMADO |
| CPU | 4 vCPU | CONFIRMADO |
| Memoria | 11 GiB total; aprox. 1.1 GiB usada, 7.7 GiB libre, 10 GiB disponible | CONFIRMADO |
| Swap | 0 | CONFIRMADO |
| `/` | 45 GiB; 4.1 GiB usados; 40 GiB disponibles (10%) | CONFIRMADO |
| `/boot` | 881 MiB; 167 MiB usados; 653 MiB disponibles (21%) | CONFIRMADO |
| Carga / uptime | 0.12, 0.15, 0.15; 6 días 14:40 | CONFIRMADO |
| Reloj | UTC sincronizado por `timedatectl` | CONFIRMADO |
| Docker / Compose | Engine 29.9.0; Compose v5.6.0 | CONFIRMADO |
| systemd | Docker, Tailscale y SSH activos | CONFIRMADO |
| Tailscale | servicio activo; IP local `100.87.22.28`; peer visible | CONFIRMADO al corte; ACL no verificada |

No se observó presión de CPU, RAM o disco. Eso no demuestra capacidad estable para nueve servicios: no se midió carga sostenida, memoria por contenedor ni límites. No hay swap. NSG/Security Lists OCI no fueron consultadas; reglas locales no representan toda la política perimetral.
