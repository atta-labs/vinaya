// Imports through each alias and re-exports a value and a type from each, so the built declaration is not empty.
import { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshot'
import { CI_SHARD_COUNT } from '@harness/workflow/checks/ci-shard-membership'

export { PULL_FILE } from '@harness/kernel/adapters/code-host/github/forge-snapshot'
export type { GhAuthor } from '@harness/kernel/adapters/code-host/github/forge-snapshot'
export { CI_SHARD_COUNT } from '@harness/workflow/checks/ci-shard-membership'
export type { Task } from '@harness/workflow/tools/task-contract/types'

console.log(JSON.stringify({ kernel: PULL_FILE, workflow: CI_SHARD_COUNT }))
