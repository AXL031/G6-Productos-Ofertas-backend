# Redes, puertos, Caddy y HTTPS

**Fuentes:** Docker network inspect, `ss`, nftables/iptables, Tailscale, DNS y pruebas HTTP/TLS desde Oracle y Windows. No se alteraron reglas.

## Redes

| Red | Estado / miembros observados |
|---|---|
| `g6-edge` | bridge local, `internal=false`; Caddy y Gateway; Gateway alias `g6-api-gateway` |
| `g6-http` | bridge local, `internal=false`; Gateway, Catalog, Pricing y Taxonomy |
| `g6-po_g6_backend` | bridge local; solo RabbitMQ (`g6-rabbitmq`) |
| Redes Compose independientes | Gateway, Catalog, Pricing y Taxonomy mantienen cada una su red `default` |

Desde Caddy, `http://g6-api-gateway:3000/health` respondió 200. No se probaron todos los pares HTTP desde contenedores ni clientes AMQP.

## Puertos y firewall

- Host escucha en 80/443 globales, 22; RabbitMQ 5672/15672 solo en `127.0.0.1`; puertos 3000, 3001, 3002 y 3006 solo en loopback.
- Desde el equipo auditor: TCP 22, 80 y 443 alcanzables; TCP 3000 y 5672 expiraron. Esto no identifica por sí mismo qué capa filtró.
- UFW no instalado. Reglas nftables/iptables se consultaron sin modificar; las reglas locales no determinan el control OCI externo.
- `tailscaled` activo, IP `100.87.22.28`; estado no prueba ACL ni todos los permisos de forwarding.
- NSG/Security Lists OCI: `NO_VERIFICADO` (sin consulta a consola/API OCI).

## Caddy y TLS

- Caddy 2.11.6 activo; TCP 80/443 publicados en todas las interfaces y UDP 443; no tiene healthcheck Docker.
- DNS A `g6-productos-ofertas.duckdns.org` → `157.137.205.218`.
- HTTP `/`: 308. HTTPS `/`: 503; TLS verifica correctamente, Let's Encrypt YE1; válido desde 2026-10-16 14:50:42Z hasta 2027-01-14 14:50:41Z.
- Configuración efectiva filtrada: ruta de categorías y dos matchers de consultas Marketplace usan `reverse_proxy g6-api-gateway:3000`; handler general responde `503 Servicio pendiente: API Gateway G6 aún no está desplegado.`
- HTTPS `/api/v1/categorias`: 200 (1081 bytes); `/api/v1/productos` y `/api/v1/productos/test`: 503 en catch-all.
- Caddy → Gateway `/health`: 200. No se recargó Caddy ni se renovó certificado.

La afirmación histórica del 17 de octubre sobre 503 estático fue correcta entonces. Hoy existe proxy selectivo, aunque el handler general sigue estático y la ruta pública no acredita el API completo.
