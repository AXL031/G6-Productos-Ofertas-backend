#!/usr/bin/env bash
set -Eeuo pipefail

readonly repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
readonly event="${TRIGGER_EVENT:?TRIGGER_EVENT is required}"
readonly output_file="${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

case "$event" in
  workflow_run)
    [[ "${CI_NAME:-}" == "Integración continua (CI)" && "${CI_PATH:-}" == .github/workflows/ci.yml ]] || {
      echo 'El flujo de origen no es Integración continua (CI).' >&2
      exit 1
    }
    [[ "${CI_EVENT:-}" == push && "${CI_BRANCH:-}" == master && "${CI_CONCLUSION:-}" == success ]] || {
      echo 'Solo se acepta una CI exitosa de push a master.' >&2
      exit 1
    }
    [[ "${CI_HEAD_REPOSITORY,,}" == "${repository,,}" ]] || {
      echo 'Se rechazan las solicitudes de cambios y los forks.' >&2
      exit 1
    }
    [[ "${CI_SHA:-}" =~ ^[0-9a-f]{40}$ && "${CI_RUN_ID:-}" =~ ^[0-9]+$ ]] || {
      echo 'El SHA o el ID de ejecución de CI no es válido.' >&2
      exit 1
    }
    run_data="$(gh api "repos/${repository}/actions/runs/${CI_RUN_ID}" --jq '[.name,.path,.event,.head_branch,.head_sha,.conclusion,.head_repository.full_name] | @tsv')"
    expected_data="$(printf 'Integración continua (CI)\t.github/workflows/ci.yml\tpush\tmaster\t%s\tsuccess\t%s' "$CI_SHA" "$repository")"
    [[ "${run_data,,}" == "${expected_data,,}" ]] || {
      echo 'La ejecución de CI consultada no coincide con el evento recibido.' >&2
      exit 1
    }
    sha="$CI_SHA"
    ;;
  workflow_dispatch)
    [[ "${GITHUB_REF:-}" == refs/heads/master ]] || { echo 'El dispatch manual solo se acepta desde master.' >&2; exit 1; }
    sha="${GITHUB_SHA:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'El SHA no es válido.' >&2; exit 1; }
    ci_success="$(gh run list --repo "$repository" --workflow ci.yml --branch master --commit "$sha" --json conclusion,event,headBranch --jq 'any(.[]; .conclusion == "success" and .event == "push" and .headBranch == "master")')"
    [[ "$ci_success" == true ]] || { echo "No se encontró una ejecución CI de push exitosa para el commit de master $sha." >&2; exit 1; }
    ;;
  *)
    echo 'El evento no está permitido.' >&2
    exit 1
    ;;
esac

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'El SHA no es válido.' >&2; exit 1; }
current="$(gh api "repos/${repository}/commits/master" --jq .sha)"
if [[ "$sha" != "$current" ]]; then
  echo "OMITIDO: revisión obsoleta $sha; master apunta ahora a $current."
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf 'Procedencia: OMITIDA por SHA obsoleto (`%s`); master apunta a `%s`.\n' "$sha" "$current" >> "$GITHUB_STEP_SUMMARY"
  fi
  echo 'sha=' >> "$output_file"
  exit 0
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Procedencia CI validada para SHA `%s`; publicación aún no solicitada.\n' "$sha" >> "$GITHUB_STEP_SUMMARY"
fi
echo "sha=$sha" >> "$output_file"
echo "repository=${repository,,}" >> "$output_file"
