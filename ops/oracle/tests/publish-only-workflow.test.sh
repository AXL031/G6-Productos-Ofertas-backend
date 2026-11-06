#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORKFLOW="$ROOT/.github/workflows/publish-only-images.yml"
readonly VALIDATOR="$ROOT/ops/oracle/validate-publish-only-source.sh"
readonly SHA='58b94a694fc22ad4401450feaffe8b708330518d'
readonly REPOSITORY='Taller-SW-Web/G6-Productos-Ofertas-backend'
readonly TEMP="$(mktemp -d)"
readonly MOCK_BIN="$TEMP/bin"
readonly OUTPUT="$TEMP/output"
mkdir "$MOCK_BIN"
trap 'rm -f "$MOCK_BIN/gh" "$OUTPUT"; rmdir "$MOCK_BIN" "$TEMP"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

cat > "$MOCK_BIN/gh" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == api ]]; then
  [[ "${2:-}" == */commits/master ]] || exit 31
  [[ "${MOCK_API_FAIL:-false}" == false ]] || exit 32
  printf '%s\n' "$MOCK_MASTER_SHA"
elif [[ "${1:-}" == run && "${2:-}" == list ]]; then
  [[ "$*" == *'--workflow ci.yml'* && "$*" == *'--branch master'* && "$*" == *"--commit $MOCK_EXPECT_SHA"* ]] || exit 35
  [[ "${MOCK_CI_FAIL:-false}" == false ]] || exit 33
  printf '%s\n' "$MOCK_CI_SUCCESS"
else
  exit 34
fi
MOCK
chmod +x "$MOCK_BIN/gh"
export PATH="$MOCK_BIN:$PATH"
export GITHUB_REPOSITORY="$REPOSITORY"
export GITHUB_SHA="$SHA"
export GH_TOKEN='fixture-read-token'
export MOCK_MASTER_SHA="$SHA"
export MOCK_EXPECT_SHA="$SHA"
export MOCK_CI_SUCCESS=true

for service in api-gateway catalog-svc taxonomy-svc; do
  : > "$OUTPUT"
  bash "$VALIDATOR" "$service" "$SHA" "$OUTPUT"
  grep -Fqx "sha=$SHA" "$OUTPUT" || fail "$service valid SHA output"
  grep -Fqx "service=$service" "$OUTPUT" || fail "$service output"
done
pass 'allowlisted services, current SHA and exact successful CI'
: > "$OUTPUT"
export GITHUB_REPOSITORY="${REPOSITORY,,}"
bash "$VALIDATOR" api-gateway "$SHA" "$OUTPUT"
grep -Fqx "repository=$REPOSITORY" "$OUTPUT" || fail 'repository case-insensitive match was not canonicalized'
export GITHUB_REPOSITORY="$REPOSITORY"
pass 'authorized repository comparison is case-insensitive and canonical'

expect_reject() {
  local name="$1" service="$2" sha="$3"
  : > "$OUTPUT"
  if bash "$VALIDATOR" "$service" "$sha" "$OUTPUT" >/dev/null 2>&1; then
    fail "$name was accepted"
  fi
  [[ ! -s "$OUTPUT" ]] || fail "$name wrote outputs before validation"
  pass "$name rejected before outputs"
}

expect_reject 'unsupported service' pricing-svc "$SHA"
expect_reject 'malformed SHA' api-gateway abc
export GITHUB_REPOSITORY='Taller-SW-Web/otro-repositorio'
expect_reject 'unauthorized repository' api-gateway "$SHA"
export GITHUB_REPOSITORY="$REPOSITORY"
export GITHUB_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
expect_reject 'event SHA mismatch' api-gateway "$SHA"
export GITHUB_SHA="$SHA"
export MOCK_MASTER_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
expect_reject 'stale master SHA' api-gateway "$SHA"
export MOCK_MASTER_SHA="$SHA"
export MOCK_CI_SUCCESS=false
expect_reject 'missing successful CI' api-gateway "$SHA"
export MOCK_CI_SUCCESS=true
export MOCK_API_FAIL=true
expect_reject 'GitHub API failure' api-gateway "$SHA"
export MOCK_API_FAIL=false
unset GH_TOKEN
expect_reject 'missing read token' api-gateway "$SHA"
export GH_TOKEN='fixture-read-token'
pass 'all source-validation negative cases'

grep -Fq 'type: choice' "$WORKFLOW" || fail 'service is not a choice input'
grep -Fq 'type: string' "$WORKFLOW" || fail 'SHA input is not a string'
grep -Fq "github.actor == 'mrcastilla8'" "$WORKFLOW" || fail 'publication dispatch is not restricted to the original owner'
grep -Fq "github.triggering_actor == 'mrcastilla8'" "$WORKFLOW" || fail 'publication rerun is not restricted to the triggering owner'
grep -Fq "github.ref == 'refs/heads/master'" "$WORKFLOW" || fail 'dispatch is not restricted to master'
for service in api-gateway catalog-svc taxonomy-svc; do
  grep -Fq -- "- $service" "$WORKFLOW" || fail "missing service $service"
done
for forbidden in bulk-svc combos-svc pricing-svc promotions-svc inventory-svc price-audit-svc; do
  if grep -Fq -- "- $forbidden" "$WORKFLOW"; then fail "service outside scope: $forbidden"; fi
done
grep -Fq 'deploy-g6-services-oracle-${{ github.repository }}-${{ inputs.service }}' "$WORKFLOW" || fail 'publisher and CD do not share concurrency group'
grep -Fq 'packages: write' "$WORKFLOW" || fail 'GHCR package permission missing'
grep -Fq 'actions: read' "$WORKFLOW" || fail 'CI verification permission missing'
grep -Fq 'docker/login-action@v3' "$WORKFLOW" || fail 'GHCR login for private/existing tags is missing'
grep -Fq 'Dockerfile.service' "$WORKFLOW" || fail 'official Dockerfile missing'
grep -Fq 'build-args: SERVICE_NAME=' "$WORKFLOW" || fail 'official build arg missing'
grep -Fq 'ensure-ghcr-sha-image.sh' "$WORKFLOW" || fail 'immutable tag verification missing'
grep -Fq 'org.opencontainers.image.title' "$WORKFLOW" || fail 'service identity label check missing'
grep -Fq 'load: true' "$WORKFLOW" || fail 'image is not built locally before publication'
grep -Fq 'docker push "$IMAGE"' "$WORKFLOW" || fail 'GHCR publication step missing'
grep -Fq 'validate-publish-only-source.sh "$SERVICE" "$IMAGE_SHA" /dev/null' "$WORKFLOW" || fail 'SHA/master/CI is not revalidated immediately before publication'
grep -Fq 'steps.publication.outputs.digest' "$WORKFLOW" || fail 'registry push digest is not verified afterward'
[[ "$(grep -Fc 'validate-publish-only-source.sh' "$WORKFLOW")" -ge 2 ]] || fail 'SHA/master/CI is not validated both before build and before publication'
build_line="$(grep -nF 'name: Construir imagen OCI local por SHA' "$WORKFLOW" | cut -d: -f1)"
tag_line="$(grep -nF 'name: Revalidar que el tag SHA sigue ausente antes de publicar' "$WORKFLOW" | cut -d: -f1)"
push_line="$(grep -nF 'name: Publicar imagen OCI en GHCR' "$WORKFLOW" | cut -d: -f1)"
[[ -n "$build_line" && -n "$tag_line" && -n "$push_line" && "$build_line" -lt "$tag_line" && "$tag_line" -lt "$push_line" ]] || fail 'segunda comprobación del tag no ocurre entre build y push'
grep -Fq 'ensure-ghcr-sha-image.sh "$GITHUB_REPOSITORY" "$SERVICE" "$IMAGE_SHA" "$tag_check_output"' "$WORKFLOW" || fail 'segunda comprobación no reutiliza el helper de tag existente'
grep -Fq '[[ "$tag_exists" == false ]]' "$WORKFLOW" || fail 'tag presente/no verificable no falla cerrado antes del push'
for forbidden in ORACLE_ Tailscale tailscale 'service-deploy' deploy-g6-service.sh 'id-token:' 'docker compose' 'workflow_run'; do
  if grep -Fqi "$forbidden" "$WORKFLOW"; then fail "deployment capability present: $forbidden"; fi
done
if grep -Fq 'secrets.' "$WORKFLOW"; then fail 'runtime repository secrets are referenced'; fi
pass 'workflow service scope, GHCR permissions, concurrency and deployment isolation'
