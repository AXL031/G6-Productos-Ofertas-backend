#!/usr/bin/env bash
set -Eeuo pipefail

# Prepara una VM Ubuntu 24.04 LTS en Azure con la misma topología de referencia de Oracle:
# - 2 GiB de swap (protección de memoria para tamaños B1s/B2s de Azure for Students)
# - Docker Engine + Compose v2
# - Redes privadas g6-edge y g6-http
# - Certificado CA de Supabase en /etc/g6-postgres/supabase-server-root.crt (0444)
# - Registro y ejecutor en /usr/local/lib/g6-productos-ofertas/
# - Plantillas Compose en /opt/g6-productos-ofertas/
# - Caddy con HTTPS; no instala ni publica un emisor simulado

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOMAIN=""
CA_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --ca-file)
      CA_FILE="${2:-}"
      shift 2
      ;;
    *)
      printf 'Uso: %s --domain <fqdn> --ca-file <ruta-ca.crt>\n' "$0" >&2
      exit 1
      ;;
  esac
done

[[ $EUID -eq 0 ]] || { printf 'Ejecutar con sudo/root.\n' >&2; exit 1; }
[[ -n "$DOMAIN" ]] || { printf 'Falta --domain <fqdn>.\n' >&2; exit 1; }
[[ -n "$CA_FILE" && -f "$CA_FILE" ]] || { printf 'Falta --ca-file válido (%s).\n' "$CA_FILE" >&2; exit 1; }

grep -q 'BEGIN CERTIFICATE' "$CA_FILE" || { printf 'El archivo CA no contiene un certificado PEM válido.\n' >&2; exit 1; }
[[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]] || { printf 'Dominio inválido.\n' >&2; exit 1; }

echo "[1/7] Verificando archivo swap de 2 GiB para Azure for Students..."
if ! swapon --show | grep -q '/swapfile'; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "[2/7] Verificando Docker Engine y Compose..."
if ! command -v jq >/dev/null || ! command -v curl >/dev/null; then
  apt-get update -y
  apt-get install -y jq curl
fi
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release jq
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "[3/7] Creando redes Docker privadas g6-edge y g6-http..."
if ! docker network inspect g6-edge >/dev/null 2>&1; then
  docker network create --driver bridge g6-edge
fi
if ! docker network inspect g6-http >/dev/null 2>&1; then
  docker network create --driver bridge g6-http
fi

echo "[4/7] Instalando CA de Supabase PostgreSQL en /etc/g6-postgres/supabase-server-root.crt..."
install --directory --owner root --group root --mode 0755 /etc/g6-postgres
install --owner root --group root --mode 0444 "$CA_FILE" /etc/g6-postgres/supabase-server-root.crt

echo "[5/7] Instalando registro v2, ejecutor v4 y plantillas Compose..."
install --directory --owner root --group root --mode 0755 /etc/g6-productos-ofertas
cat > /etc/g6-productos-ofertas/azure.conf <<EOF
G6_PUBLIC_DOMAIN=${DOMAIN}
EOF
chmod 0644 /etc/g6-productos-ofertas/azure.conf

install --directory --owner root --group root --mode 0755 /usr/local/lib/g6-productos-ofertas
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/oracle/service-registry.sh" /usr/local/lib/g6-productos-ofertas/service-registry.sh
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/oracle/services.psv" /usr/local/lib/g6-productos-ofertas/services.psv
install --owner root --group root --mode 0755 "${REPO_ROOT}/ops/azure/deploy-g6-service.sh" /usr/local/lib/g6-productos-ofertas/deploy-g6-service

install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/shared
install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/api-gateway
install --directory --owner root --group root --mode 0755 /opt/g6-productos-ofertas/caddy
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/oracle/docker-compose.service.yml" /opt/g6-productos-ofertas/shared/docker-compose.service.yml
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/oracle/docker-compose.service.http.yml" /opt/g6-productos-ofertas/shared/docker-compose.service.http.yml
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/oracle/docker-compose.gateway.yml" /opt/g6-productos-ofertas/api-gateway/docker-compose.gateway.yml
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/azure/docker-compose.caddy.yml" /opt/g6-productos-ofertas/caddy/docker-compose.caddy.yml

/usr/local/lib/g6-productos-ofertas/deploy-g6-service --version

echo "[6/7] Preparando directorios de runtime privado (/etc/g6-*) y estado (/var/lib/g6-productos-ofertas/*)..."
for svc in api-gateway catalog-svc taxonomy-svc; do
  install --directory --owner root --group root --mode 0750 "/etc/g6-${svc}"
  install --directory --owner root --group root --mode 0700 "/var/lib/g6-productos-ofertas/${svc}"
done

if [[ ! -f /etc/g6-api-gateway/runtime.env ]]; then
  cat > /etc/g6-api-gateway/runtime.env <<'EOF'
API_GATEWAY_PORT=3000
GATEWAY_TIMEOUT_MS=5000
GATEWAY_CATALOG_SVC_URL=http://catalog-svc:3001
GATEWAY_CATALOG_SVC_READINESS_PATH=/health/ready
GATEWAY_TAXONOMY_SVC_URL=http://taxonomy-svc:3006
GATEWAY_TAXONOMY_SVC_READINESS_PATH=/health/ready
G6_SECURITY_MODE=G7_AUTHENTICATED
GATEWAY_DEMO_NO_AUTH_ENABLED=false
G6_READ_ONLY_DEMO_ENABLED=false
GATEWAY_PUBLIC_OPERATION_IDS=
AUTH_ISSUER=
AUTH_JWKS_URL=
EOF
  chmod 0640 /etc/g6-api-gateway/runtime.env
fi

if [[ ! -f /etc/g6-taxonomy-svc/runtime.env ]]; then
  cat > /etc/g6-taxonomy-svc/runtime.env <<'EOF'
# Completar con el host/password reales de Supabase para taxonomy_dev_login
DATABASE_URL=postgresql://taxonomy_dev_login:REEMPLAZAR_PASSWORD@db.slzglmtiyrzygpkiuthf.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/run/g6-certs/supabase-server-root.crt&currentSchema=taxonomy
G6_EXPECTED_ROLE=taxonomy_dev_login
G6_CONNECTION_MODE=direct
G6_SECURITY_MODE=G7_AUTHENTICATED
TAXONOMY_PUBLIC_OPERATION_IDS=
SECURITY_ISSUER=
SECURITY_DISCOVERY_URL=
SECURITY_JWKS_URL=
EOF
  chmod 0640 /etc/g6-taxonomy-svc/runtime.env
fi

if [[ ! -f /etc/g6-catalog-svc/runtime.env ]]; then
  cat > /etc/g6-catalog-svc/runtime.env <<'EOF'
# Completar con el host/password reales de Supabase para catalog_dev_login
PGHOST=db.slzglmtiyrzygpkiuthf.supabase.co
PGPORT=5432
PGDATABASE=postgres
PGUSER=catalog_dev_login
PGPASSWORD=REEMPLAZAR_PASSWORD
PGSSLMODE=verify-full
PGSSLROOTCERT=/run/g6-certs/supabase-server-root.crt
G6_DATABASE_SCHEMA=catalog
G6_EXPECTED_ROLE=catalog_dev_login
G6_CONNECTION_MODE=direct
CATALOG_TAXONOMY_URL=http://taxonomy-svc:3006
CATALOG_AMQP_ENABLED=false
G6_SECURITY_MODE=G7_AUTHENTICATED
CATALOG_PUBLIC_OPERATION_IDS=
G6_READ_ONLY_DEMO_ENABLED=false
GATEWAY_DEMO_NO_AUTH_ENABLED=false
CATALOG_MARKETPLACE_DEMO_PREVIEW_ENABLED=false
SECURITY_ISSUER=
SECURITY_DISCOVERY_URL=
SECURITY_JWKS_URL=
EOF
  chmod 0640 /etc/g6-catalog-svc/runtime.env
fi

echo "[7/7] Configurando Caddy HTTPS..."
install --directory --owner root --group root --mode 0755 /etc/g6-caddy
install --owner root --group root --mode 0644 "${REPO_ROOT}/ops/azure/Caddyfile" /etc/g6-caddy/Caddyfile

env G6_PUBLIC_DOMAIN="$DOMAIN" \
  docker compose --file /opt/g6-productos-ofertas/caddy/docker-compose.caddy.yml --project-name g6-caddy up -d

echo "Bootstrap completado. Dominio HTTPS configurado en Caddy: https://${DOMAIN}"
