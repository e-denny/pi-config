#!/usr/bin/env bash
# Create (or refresh) the virtualenv used by the stylometry skill.
#
# pystylometry requires Python >=3.9,<3.13, so a distribution Python newer than
# 3.12 cannot be used directly. uv fetches a suitable interpreter on demand.
#
# Installed from the pinned upstream commit rather than PyPI: master's
# readability module reads cmudict directly, while the PyPI release still
# depends on the unmaintained `pronouncing` package (broken on modern
# setuptools).
#
# Override the target venv with PYSTYLOMETRY_VENV=/some/path.

set -euo pipefail

VENV="${PYSTYLOMETRY_VENV:-$HOME/.local/share/pystylometry/venv}"
PYSTYLOMETRY_PIN="${PYSTYLOMETRY_PIN:-ce3c62b5df25489f813333efda8643382e2f0f7d}"
SPACY_MODEL="${SPACY_MODEL:-en_core_web_sm}"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required to build the stylometry environment." >&2
  echo "install it with: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "or: pipx install uv" >&2
  exit 1
fi

echo "creating venv at $VENV" >&2
uv venv --python 3.12 "$VENV" >&2

echo "installing pystylometry[all] (pin $PYSTYLOMETRY_PIN)" >&2
VIRTUAL_ENV="$VENV" uv pip install \
  "pystylometry[all] @ git+https://github.com/craigtrim/pystylometry@$PYSTYLOMETRY_PIN" >&2

# The syntactic, cohesion, and genre metrics need a spaCy model at runtime.
# A missing model degrades those sections to "skipped" rather than failing.
echo "installing spaCy model $SPACY_MODEL" >&2
if ! "$VENV/bin/python" -m spacy download "$SPACY_MODEL" >&2; then
  echo "warning: could not install $SPACY_MODEL; syntactic sections will be skipped" >&2
fi

echo "stylometry environment ready: $VENV" >&2
