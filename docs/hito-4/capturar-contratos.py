"""Capture the contract surface from a read-only checkout of official Docs."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import yaml


def git(*args, cwd=None):
    return subprocess.check_output(["git", *args], cwd=cwd, encoding="utf-8").strip()


def structural(value):
    if isinstance(value, dict):
        return {
            key: structural(item)
            for key, item in value.items()
            if key not in {"description", "summary", "example", "examples"}
            or not isinstance(item, (str, list))
        }
    if isinstance(value, list):
        return [structural(item) for item in value]
    return value


def contract(source, path):
    data = (source / path).read_bytes()
    return {
        "path": path,
        "sha256": hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest(),
        "contract": structural(yaml.safe_load(data)),
    }


def main():
    source = Path(sys.argv[1]).resolve()
    gateway = json.loads(
        subprocess.check_output(
            [
                "node",
                "--input-type=module",
                "-e",
                "import { CONTRACT_ROUTES } from './apps/api-gateway/src/routing/contract-routes.ts';"
                "import { PHASE1_INTERNAL_READ_ROUTES } from './apps/api-gateway/src/routing/phase1-internal-read-routes.ts';"
                "console.log(JSON.stringify({ gateway: CONTRACT_ROUTES, phase1: PHASE1_INTERNAL_READ_ROUTES }));",
            ],
            encoding="utf-8",
        )
    )
    # Pin the actual handlers to their Git blobs for inspection alongside the
    # normative definitions and the runtime Gateway registry.
    handlers = [
        entry for entry in git("ls-tree", "-r", "HEAD", "apps").splitlines()
        if "/src/" in entry and (
            "controller.ts" in entry or entry.endswith("/catalog-auth.ts")
        )
    ]
    snapshot = {
        "backendCommit": git("rev-parse", "HEAD"),
        "docsCommit": git("rev-parse", "HEAD", cwd=source),
        "http": contract(source, "contratos/http/openapi.yaml"),
        "events": contract(source, "contratos/eventos/asyncapi.yaml"),
        "gateway": gateway["gateway"],
        "gatewayPhase1Internal": gateway["phase1"],
        "backendHandlerBlobs": handlers,
    }
    with Path(sys.argv[2]).open("w", encoding="utf-8", newline="\n") as output:
        output.write("{\n")
        for index, (key, value) in enumerate(snapshot.items()):
            if index:
                output.write(",\n")
            output.write(f"  {json.dumps(key)}: ")
            json.dump(value, output, ensure_ascii=False, sort_keys=True, indent=2, default=str)
        output.write("\n}\n")


if __name__ == "__main__":
    main()
