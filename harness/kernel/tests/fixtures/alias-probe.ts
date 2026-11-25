// Imports one real module through the kernel alias; the alias-resolution test type-checks, runs and bundles this file.
// Kernel code never imports a process, so the workflow alias is proved from the workflow and CLI folders' own probes.
import { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshot'

process.stdout.write(`${JSON.stringify({ kernel: PULL_FILE })}\n`)
