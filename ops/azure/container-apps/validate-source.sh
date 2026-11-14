#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'CD Azure bloqueado: %s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail 'uso: validate-source.sh manual <servicio|all> <sha>'
mode="$1" requested_service="$2" sha="$3"
readonly repository='Taller-SW-Web/G6-Productos-Ofertas-backend'
[[ "$mode" == manual ]] || fail 'solo se permite el inicio manual explícito en esta etapa'
[[ "${GITHUB_REPOSITORY:-}" == "$repository" ]] || fail 'repositorio de origen no autorizado'
[[ "${GITHUB_REF:-}" == refs/heads/master ]] || fail 'workflow_dispatch solo se acepta desde master'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'
[[ -n "${GH_TOKEN:-}" ]] || fail 'se requiere GITHUB_TOKEN para verificar CI y master'

case "$requested_service" in
  all) services='["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]' ;;
  api-gateway|bulk-svc|catalog-svc|combos-svc|inventory-svc|price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) services="[\"$requested_service\"]" ;;
  *) fail 'servicio fuera de la allowlist' ;;
esac

current_master="$(gh api "repos/${repository}/commits/master" --jq .sha)" || fail 'no se pudo consultar master'
[[ "$sha" == "$current_master" ]] || fail "el despliegue ordinario exige el HEAD vigente de master (${current_master}); para recuperar una versión anterior se requiere el procedimiento separado aprobado"
ci_success="$(gh api --method GET "repos/${repository}/actions/runs" -f "head_sha=${sha}" -f per_page=100 --jq \
  "any(.workflow_runs[]; .path == \".github/workflows/ci.yml\" and .head_sha == \"${sha}\" and .head_branch == \"master\" and .event == \"push\" and .conclusion == \"success\" and (.repository.full_name | ascii_downcase) == \"${repository,,}\")")" || fail 'no se pudo consultar la CI del SHA'
[[ "$ci_success" == true ]] || fail 'no existe CI push/master exitosa para el SHA exacto'

printf 'sha=%s\nservices=%s\nrepository=%s\nmaster_sha=%s\n' "$sha" "$services" "$repository" "$current_master" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT no definido}"
printf 'Origen verificado: HEAD vigente de master %s con CI exitosa exacta. Selección: %s\n' "$sha" "$services"
