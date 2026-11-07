#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'CD Azure bloqueado: %s\n' "$1" >&2; exit 1; }
[[ $# == 3 ]] || fail 'uso: validate-source.sh <auto|manual> <servicio|all> <sha>'
mode="$1" requested_service="$2" sha="$3"
readonly repository='Taller-SW-Web/G6-Productos-Ofertas-backend'
[[ "${GITHUB_REPOSITORY:-}" == "$repository" ]] || fail 'repositorio de origen no autorizado'
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'SHA inválido'
[[ -n "${GH_TOKEN:-}" ]] || fail 'se requiere GITHUB_TOKEN para verificar CI y master'

case "$mode" in
  auto)
    case "$requested_service" in
      automatic|api-gateway|catalog-svc|taxonomy-svc) ;;
      *) fail 'servicio fuera del alcance automático inicial' ;;
    esac
    [[ "${CI_REPOSITORY:-}" == "$repository" ]] || fail 'el workflow_run no se originó en el repositorio oficial'
    [[ "${CI_BRANCH:-}" == master && "${CI_EVENT:-}" == push && "${CI_CONCLUSION:-}" == success ]] || fail 'CI no corresponde a un push exitoso de master'
    [[ "${CI_SHA:-}" == "$sha" ]] || fail 'el SHA de CI y el SHA candidato difieren'
    services='["api-gateway","catalog-svc","taxonomy-svc"]'
    ;;
  manual)
    [[ "${GITHUB_REF:-}" == refs/heads/master ]] || fail 'workflow_dispatch solo se acepta desde master'
    [[ "${GITHUB_SHA:-}" == "$sha" ]] || fail 'el SHA ingresado no coincide con el commit que disparó workflow_dispatch'
    case "$requested_service" in
      all) services='["api-gateway","bulk-svc","catalog-svc","combos-svc","inventory-svc","price-audit-svc","pricing-svc","promotions-svc","taxonomy-svc"]' ;;
      api-gateway|bulk-svc|catalog-svc|combos-svc|inventory-svc|price-audit-svc|pricing-svc|promotions-svc|taxonomy-svc) services="[\"$requested_service\"]" ;;
      *) fail 'servicio fuera de la allowlist' ;;
    esac
    ;;
  *) fail 'modo de ejecución no autorizado' ;;
esac

current_master="$(gh api "repos/${repository}/commits/master" --jq .sha)" || fail 'no se pudo consultar master'
[[ "$current_master" == "$sha" ]] || fail "SHA obsoleto; master apunta a ${current_master}"
ci_success="$(gh api --method GET "repos/${repository}/actions/runs" -f "head_sha=${sha}" -f per_page=100 --jq \
  "any(.workflow_runs[]; .path == \".github/workflows/ci.yml\" and .head_sha == \"${sha}\" and .head_branch == \"master\" and .event == \"push\" and .conclusion == \"success\" and (.repository.full_name | ascii_downcase) == \"${repository,,}\")")" || fail 'no se pudo consultar la CI del SHA'
[[ "$ci_success" == true ]] || fail 'no existe CI push/master exitosa para el SHA exacto'

printf 'sha=%s\nservices=%s\nrepository=%s\n' "$sha" "$services" "$repository" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT no definido}"
printf 'Origen verificado: %s master, CI exitosa para %s. Selección: %s\n' "$repository" "$sha" "$services"
