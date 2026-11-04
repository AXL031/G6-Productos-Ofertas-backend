# Seguridad y dependencias runtime

**Fuentes:** metadata `stat/find`, mounts Docker, listeners/firewall y probes HTTP. No se abrió ni imprimió ningún `.env`/`runtime.env` ni variable de proceso; no se incluyeron credenciales.

## Runtime y CA

- Existe `/etc/g6-<servicio>/runtime.env` para los nueve servicios; metadata: propietario `root`, grupo específico por servicio, modo `0640`. No se inspeccionó contenido ni nombres/valores de variables; presencia no acredita validez/configuración.
- `/etc/g6-postgres/supabase-server-root.crt`: `root:root`, `0444`; Gateway, Catalog, Pricing y Taxonomy montan el certificado como bind read-only en `/run/g6-certs/supabase-server-root.crt`.
- Gateway readiness falla por Catalog `not_ready`; Catalog `/health/ready` responde 503. Pricing `/health/ready` responde 200, sin verificación de una lectura de negocio/base. Taxonomy `/health/readiness` responde 200 y el código de `castilla` declara dos consultas PostgreSQL de lectura.
- Conexión real Supabase de Catalog/Pricing: `NO_VERIFICADO` o readiness insatisfactoria; no se intentó SQL ni conexión manual.

## Controles

- SSH usó host key conocida y verificación estricta. No se leyó ni copió clave privada.
- Docker requirió `sudo -n`; solo se usó para lectura. No se cambiaron usuarios/grupos/permisos.
- Caddy publica 80/443; RabbitMQ AMQP/Management y puertos de aplicaciones permanecen en loopback.
- UFW no instalado; nftables/iptables consultados sin modificación. Reglas OCI externas no se determinaron.
- ACL Tailscale, credenciales GitHub Actions, NSG y Security Lists: `NO_VERIFICADO`.

Sin leer valores runtime no se acredita validez, rol o expiración. No se afirma ausencia de exposición histórica a partir de esta revisión limitada. No se hicieron migraciones, SQL, cambios de permisos, deploys o publicaciones de broker.
