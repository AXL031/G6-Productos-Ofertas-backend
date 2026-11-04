#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly HELPER="$ROOT/ops/oracle/ensure-ghcr-sha-image.sh"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$TEMP_ROOT/bin"
cat > "$TEMP_ROOT/bin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1 $2" in
  'manifest inspect')
    [[ "$MOCK_IMAGE_STATE" == existing ]] && exit 0
    if [[ "$MOCK_IMAGE_STATE" == missing ]]; then echo 'manifest unknown' >&2; exit 1; fi
    echo 'network timeout' >&2; exit 1
    ;;
  'pull ghcr.io/'*'/inventory-svc:'*) printf 'pull %s\n' "$2" >> "$MOCK_DOCKER_LOG" ;;
  'image inspect')
    if [[ "${5:-}" == *RepoDigests* ]]; then printf 'ghcr.io/example/backend/inventory-svc:%s@sha256:%064d\n' "$MOCK_SHA" 1; exit 0; fi
    case "$MOCK_LABELS" in
      valid) printf '{"org.opencontainers.image.source":"%s","org.opencontainers.image.revision":"%s"}\n' "$MOCK_SOURCE_URL" "$MOCK_SHA" ;;
      wrong-source) printf '{"org.opencontainers.image.source":"https://github.com/other/repo","org.opencontainers.image.revision":"%s"}\n' "$MOCK_SHA" ;;
      wrong-revision) printf '{"org.opencontainers.image.source":"https://github.com/example/backend","org.opencontainers.image.revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n' ;;
    esac
    ;;
  *) echo 'unexpected docker command' >&2; exit 2 ;;
esac
MOCK_DOCKER
chmod +x "$TEMP_ROOT/bin/docker"
cat > "$TEMP_ROOT/bin/jq" <<'MOCK_JQ'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == -e && "$2" == --arg && "$3" == source && "$5" == --arg && "$6" == revision ]] || exit 2
payload="$(cat)"
actual_source="$(grep -o '"org.opencontainers.image.source":"[^"]*"' <<< "$payload" | cut -d'"' -f4)"
[[ "${actual_source,,}" == "$4" ]] &&
  grep -Fq "\"org.opencontainers.image.revision\":\"$7\"" <<< "$payload"
MOCK_JQ
chmod +x "$TEMP_ROOT/bin/jq"
readonly SHA=0123456789012345678901234567890123456789
run_helper() { local repo="${3:-example/backend}"; env PATH="$TEMP_ROOT/bin:$PATH" MOCK_IMAGE_STATE="$1" MOCK_LABELS="${2:-valid}" MOCK_SHA="$SHA" MOCK_SOURCE_URL="https://github.com/${repo}" MOCK_DOCKER_LOG="$TEMP_ROOT/docker.log" bash "$HELPER" "$repo" inventory-svc "$SHA" "$TEMP_ROOT/output"; }

: > "$TEMP_ROOT/output"
run_helper missing
grep -qx 'exists=false' "$TEMP_ROOT/output"
if grep -q '^pull ' "$TEMP_ROOT/docker.log" 2>/dev/null; then echo 'FALLO: una imagen ausente fue descargada.' >&2; exit 1; fi
echo 'CORRECTO: la etiqueta ausente permite una primera publicación.'

: > "$TEMP_ROOT/output"
run_helper existing valid
grep -qx 'exists=true' "$TEMP_ROOT/output"
grep -Eq '^digest=sha256:[0-9a-f]{64}$' "$TEMP_ROOT/output"
grep -q '^pull ghcr.io/example/backend/inventory-svc:' "$TEMP_ROOT/docker.log"
echo 'CORRECTO: se reutiliza la etiqueta existente con identidad, revisión y digest válidos.'

: > "$TEMP_ROOT/output"
real_repository='Taller-SW-Web/G6-Productos-Ofertas-backend'
run_helper existing valid "$real_repository"
grep -qx 'image=ghcr.io/taller-sw-web/g6-productos-ofertas-backend/inventory-svc:0123456789012345678901234567890123456789' "$TEMP_ROOT/output"
echo 'CORRECTO: se normaliza el repositorio GHCR y se valida su origen sin distinguir mayúsculas.'

for labels in wrong-source wrong-revision; do
  : > "$TEMP_ROOT/output"
  if run_helper existing "$labels" >/dev/null 2>&1; then echo "FALLO: etiqueta $labels se aceptó." >&2; exit 1; fi
done
echo 'CORRECTO: se rechaza el origen o revisión no verificable sin sobrescribir.'

if run_helper unknown >/dev/null 2>&1; then echo 'FALLO: error de registry ambiguo se trató como etiqueta libre.' >&2; exit 1; fi
echo 'CORRECTO: un error ambiguo del registro falla de forma segura.'
