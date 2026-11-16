#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf 'Protección azure-h5 no verificada: %s\n' "$1" >&2; exit 1; }
[[ $# == 1 || $# == 3 ]] || fail 'uso: verify-environment-protection.sh <owner/repo> [environment service]'
repository="$1"
[[ "$repository" == Taller-SW-Web/G6-Productos-Ofertas-backend ]] || fail 'repositorio no autorizado'
[[ -n "${GH_TOKEN:-}" ]] || fail 'se requiere GH_TOKEN de solo lectura'

environment_name="${2:-azure-h5}"
pilot_service="${3:-}"
case "$environment_name" in
  azure-h5) ;;
  azure-h5-pilot-234) [[ "$pilot_service" == pricing-svc || "$pilot_service" == price-audit-svc ]] || fail 'excepcion #234 fuera de alcance' ;;
  *) fail 'environment no autorizado' ;;
esac
environment_path="repos/${repository}/environments/${environment_name}"
branch_policies_path="${environment_path}/deployment-branch-policies"
gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$environment_path" >/dev/null || fail 'el environment no existe o no se pudo leer'
reviewer_filter='[.protection_rules[]? | select(.type == "required_reviewers")] | if length == 1 and .[0].prevent_self_review == true and (.[0].reviewers | length > 0) then 1 else 0 end'
if [[ "$environment_name" == azure-h5-pilot-234 ]]; then
  reviewer_filter='[.protection_rules[]? | select(.type == "required_reviewers")] | if length == 1 and .[0].prevent_self_review == false and (.[0].reviewers | length == 1) and .[0].reviewers[0].type == "User" and .[0].reviewers[0].reviewer.id == 129343979 then 1 else 0 end'
fi
required_reviewers="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$environment_path" --jq "$reviewer_filter")" \
  || fail 'no se pudieron verificar required reviewers y prevención de autoaprobación'
[[ "$required_reviewers" =~ ^[1-9][0-9]*$ ]] || fail 'faltan required reviewers o está desactivada la prevención de autoaprobaciones'

branch_mode="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$environment_path" --jq \
  'if .deployment_branch_policy.custom_branch_policies == true and .deployment_branch_policy.protected_branches == false then "custom" else "invalid" end')" \
  || fail 'no se pudo verificar la política de ramas'
[[ "$branch_mode" == custom ]] || fail 'la política no restringe el environment a ramas personalizadas'
branch_patterns="$(gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$branch_policies_path" --jq '[.branch_policies[].name] | sort | join(",")')" \
  || fail 'no se pudieron consultar las ramas autorizadas'
[[ "$branch_patterns" == master ]] || fail "la única rama autorizada debe ser master (actual: ${branch_patterns:-ninguna})"

printf 'PASS: %s tiene la revision exigida por su politica y unicamente master; excepcion #234 solo para Pricing/Audit.\n' "$environment_name"
