#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility entry point for existing Oracle publishing workflows/tests.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
exec "${SCRIPT_DIR}/../shared/ensure-ghcr-sha-image.sh" "$@"
