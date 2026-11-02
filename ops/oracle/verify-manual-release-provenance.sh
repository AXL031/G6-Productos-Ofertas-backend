#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo 'Uso: verify-manual-release-provenance.sh <owner/repo> <deployment-id> <servicio> <evidencia-https>' >&2
  exit 64
}

[[ $# == 4 ]] || usage
repository="$1" deployment_id="$2" service="$3" evidence="$4"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$deployment_id" =~ ^[0-9]+$ && "$evidence" =~ ^https://[^[:space:]]+$ ]] || usage
[[ "$service" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || usage

deployment="$(gh api "repos/${repository}/deployments/${deployment_id}" --jq '[.environment,.task,.sha,.payload.trigger,.payload.run_id] | @tsv')"
IFS=$'\t' read -r environment task sha trigger run_id <<< "$deployment"
[[ "$environment" == "g6-oracle-${service}" && "$task" == deploy && "$sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'El Deployment de referencia no corresponde al servicio o no tiene una revisión válida.' >&2
  exit 1
}
[[ "$trigger" == workflow_dispatch && "$run_id" =~ ^[0-9]+$ ]] || {
  echo 'El Deployment no acredita una liberación manual por workflow_dispatch.' >&2
  exit 1
}

statuses="$(gh api --paginate "repos/${repository}/deployments/${deployment_id}/statuses?per_page=100" --jq '.[] | [.created_at,.state] | @tsv')"
latest_status="$(printf '%s\n' "$statuses" | sort | tail -n 1 | cut -f 2)"
[[ "$latest_status" == success ]] || {
  echo 'La liberación manual de referencia no terminó en success.' >&2
  exit 1
}

run="$(gh api "repos/${repository}/actions/runs/${run_id}" --jq '[.name,.path,.event,.head_branch,.head_sha,.conclusion,.head_repository.full_name] | @tsv')"
expected="$(printf 'Despliegue continuo de servicios Oracle\t.github/workflows/cd-services-oracle.yml\tworkflow_dispatch\tmaster\t%s\tsuccess\t%s' "$sha" "$repository")"
[[ "${run,,}" == "${expected,,}" ]] || {
  echo 'La ejecución manual no coincide con el Deployment, servicio y SHA registrados.' >&2
  exit 1
}
printf 'CORRECTO: liberación manual de %s acreditada por workflow_dispatch y evidencia funcional registrada.\n' "$service"
