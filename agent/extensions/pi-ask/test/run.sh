#!/usr/bin/env bash
# pi-ask smoke test.
#
# The extension imports pi's packages through the aliases pi's loader provides
# at runtime. Node has no such aliases, so link pi's packages next to the
# extension for the duration of the test and remove them afterwards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi_bin="$(command -v pi || true)"
if [[ -z "$pi_bin" ]]; then
	echo "pi not found on PATH" >&2
	exit 1
fi
pi_pkg="$(cd "$(dirname "$(readlink -f "$pi_bin")")/../.." && pwd)"

cleanup() { rm -rf "$here/node_modules"; }
trap cleanup EXIT

mkdir -p "$here/node_modules/@earendil-works"
ln -sfn "$pi_pkg" "$here/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$pi_pkg/node_modules/@earendil-works/pi-tui" "$here/node_modules/@earendil-works/pi-tui"

cd "$here"
node test/smoke-test.ts
