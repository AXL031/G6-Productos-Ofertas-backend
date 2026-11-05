#!/usr/bin/env bash
set -Eeuo pipefail
# Input is a release manifest reviewed by architecture, not a release approval.
# service|source-SHA|sha256:digest. No tags, URLs, shell syntax or fork images.
[[ $EUID -eq 0 ]] || { printf 'Ejecutar con sudo/root.\n' >&2; exit 1; }
[[ $# == 1 && -f "$1" ]] || { printf 'Uso: %s <release.psv revisado>\n' "$0" >&2; exit 1; }
declare -A shas=() digests=()
while IFS='|' read -r service sha digest extra || [[ -n "${service:-}" ]]; do
  [[ -n "$service" && "$service" != \#* ]] || continue
  [[ "$service" =~ ^(taxonomy-svc|catalog-svc|api-gateway)$ &&
     "$sha" =~ ^[0-9a-f]{40}$ && "$digest" =~ ^sha256:[0-9a-f]{64}$ &&
     -z "$extra" && -z "${shas[$service]:-}" ]] || { printf 'Manifiesto inválido.\n' >&2; exit 1; }
  shas[$service]="$sha"
  digests[$service]="$digest"
done < "$1"
[[ ${#shas[@]} == 3 ]] || { printf 'El manifiesto debe contener exactamente los tres servicios.\n' >&2; exit 1; }
username='' token=''
if [[ ! -t 0 ]]; then
  IFS= read -r username || true
  IFS= read -r token || true
fi
for service in taxonomy-svc catalog-svc api-gateway; do
  printf '%s\n%s\n' "$username" "$token" |
    env SSH_ORIGINAL_COMMAND="service-deploy ${service} ${shas[$service]} ${digests[$service]}" \
      /usr/local/lib/g6-productos-ofertas/deploy-g6-service
done
unset token
