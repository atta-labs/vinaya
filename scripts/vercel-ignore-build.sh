#!/usr/bin/env bash
# Vercel "Ignored Build Step" for a workspace deployed from this repository.
#
#   bash scripts/vercel-ignore-build.sh @vinaya/portal
#
# Exit 0 skips the deployment, exit 1 builds it. turbo-ignore returns 0 when neither the
# workspace nor anything it depends on changed since the last deployed commit, and 1 otherwise.
# It compares against VERCEL_GIT_PREVIOUS_SHA only when VERCEL is 1, so the script sets that for
# runs outside Vercel; with no previous deployment it falls back to the parent commit.
set -euo pipefail

workspace="${1:?usage: vercel-ignore-build.sh <workspace-package-name>}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

VERCEL=1 exec npx --yes turbo-ignore@2.11.9 "$workspace" --fallback=HEAD^
