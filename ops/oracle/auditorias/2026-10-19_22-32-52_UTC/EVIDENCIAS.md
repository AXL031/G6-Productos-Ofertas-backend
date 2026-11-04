# Evidencias sanitizadas y límites

## Consultas

| Momento UTC | Fuente/consulta | Resultado sanitizado |
|---|---|---|
| 22:32:52 | SSH con clave indicada, `IdentitiesOnly`, `BatchMode`, timeout, `StrictHostKeyChecking=yes`; `hostname`, `date -u` | Autenticación; `g6-po-vcn`; host key ED25519 coincide con fingerprint conocido; hora UTC obtenida |
| 22:33 | SO, kernel, uptime, RAM/disco, reloj, Docker/systemd/Tailscale | Ubuntu 24.04.5, kernel 7.0.0-1013-oracle, 4 CPU, 11 GiB RAM, sin swap, 40 GiB libres, Docker 29.9, Compose 5.6, reloj sincronizado |
| 22:33–22:35 | `sudo -n docker ps -a`, inspect seguro, redes, listeners | 6 contenedores; Gateway unhealthy; cuatro servicios G6 presentes y cinco ausentes; `g6-http` con cuatro miembros |
| 22:33–22:36 | GET health/readiness/negocio, DNS/TLS, prueba desde Caddy | Taxonomy categorías 200; Catalog readiness 503; Gateway readiness falla; TLS válido; Caddy catch-all 503 |
| 22:34–22:35 | GitHub API commits/CI/Deployments; checksums local/remoto | master `9205eb…`; CI exitoso para SHA de imágenes; cuatro deployments consultados `success`; ejecutor remoto v4/registro v2 y hashes coincidentes |
| 22:34–22:35 | `rabbitmq-diagnostics` y `rabbitmqctl list_*` | RabbitMQ 4.2.9; dos vhosts; cuatro exchanges, once colas, 57 bindings; sin mensajes, consumidores o conexiones; retry/DLX ausente |
| 22:34 | Metadata runtime/CA y mounts | nueve runtime files `0640`, CA `0444`; no se leyeron contenidos |
| 22:34 | TCP desde Windows a IP pública | 22, 80, 443 alcanzables; 3000 y 5672 expiraron |

## Límites

- NSG/Security Lists OCI, ACL Tailscale y secretos GitHub no verificados.
- AsyncAPI/topología de docs se leyeron desde el working tree local, que ya tenía cambios antes de esta tarea; no se atribuye su contenido a un SHA remoto ni a homologación/publicación.
- GET sin tokens; no se eludieron respuestas 401 ni se hicieron POST/PATCH/PUT/DELETE.
- No se publicó/consumió mensaje ni se consultó el contenido de colas.
- No se leyeron `.env`, `runtime.env`, variables, contraseñas, tokens, cookies o claves privadas.
- No se probaron todas las conexiones HTTP entre contenedores, SQL manual, grants completos, carga de nueve servicios ni rollback.
- Desviación de procedimiento: una consulta HTTP guardó momentáneamente su cuerpo en `/tmp/g6body` en la VM y el comando lo eliminó al terminar. No se conservaron datos ni se alteró configuración/servicios, pero esa escritura temporal excedió el requisito literal de solo lectura; queda registrada para no afirmar cumplimiento perfecto.
- La VM está en uso; conteos y estados pueden variar tras el corte.
- No se ejecutaron tests de software; las validaciones documentales se indican al finalizar.
