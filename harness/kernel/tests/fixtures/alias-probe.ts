// Imports one real module through each alias; the alias-resolution test type-checks, runs and bundles this file.
import { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshot'
import { CI_SHARD_COUNT } from '@harness/workflow/checks/ci-shard-membership'

process.stdout.write(`${JSON.stringify({ kernel: PULL_FILE, workflow: CI_SHARD_COUNT })}\n`)
