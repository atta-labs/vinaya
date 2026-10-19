/** The 37 core checks, from the Vinaya process definition §17. */
export type CheckRow = {
  name: string
  stage: 'Commit' | 'Push' | 'Pull request' | 'Issue write'
  refuses: string
  implements: string
  href: string
}

export const CHECKS: CheckRow[] = [
  {
    name: 'brief-shape',
    stage: 'Commit',
    refuses: 'A PR/brief report missing Vinaya’s required sections',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-commit-checks#brief-shape'
  },
  {
    name: 'pr-report-density',
    stage: 'Commit',
    refuses: 'Report content that breaks Vinaya’s density and shape rules',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-commit-checks#pr-report-density'
  },
  {
    name: 'doc-coverage',
    stage: 'Commit',
    refuses: 'A code change without the documentation its doc-owner policy requires',
    implements: 'Evidence completeness',
    href: '/docs/process/gates/ring0-commit-checks#doc-coverage'
  },
  {
    name: 'doc-coverage-push',
    stage: 'Commit',
    refuses: 'The same obligation, with push semantics',
    implements: 'Evidence completeness',
    href: '/docs/process/gates/ring0-commit-checks#doc-coverage-push'
  },
  {
    name: 'pr-premise-reassert',
    stage: 'Commit',
    refuses: 'A `Premise:` pin the current repository no longer satisfies',
    implements: 'Intent freshness',
    href: '/docs/process/gates/ring0-commit-checks#pr-premise-reassert'
  },
  {
    name: 'single-plan-pr',
    stage: 'Commit',
    refuses: 'Concurrent PRs on the same legacy tranche plan',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-commit-checks#single-plan-pr'
  },
  {
    name: 'no-disk-state',
    stage: 'Commit',
    refuses: 'A file that stores live execution status on disk',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-commit-checks#no-disk-state'
  },
  {
    name: 'exec-bits',
    stage: 'Commit',
    refuses: 'A staged executable without mode `100755`',
    implements: 'Contract validity',
    href: '/docs/process/gates/ring0-commit-checks#exec-bits'
  },
  {
    name: 'ci-shard-coverage',
    stage: 'Commit',
    refuses: 'A CLI test missing from the CI shard lists',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-commit-checks#ci-shard-coverage'
  },
  {
    name: 'changeset-coverage',
    stage: 'Commit',
    refuses: 'A change to shipped packages without a Changesets entry',
    implements: 'Evidence completeness',
    href: '/docs/process/gates/ring0-commit-checks#changeset-coverage'
  },
  {
    name: 'quoted-command',
    stage: 'Push',
    refuses: 'A quoted command or config line its cited file no longer contains',
    implements: 'Evidence freshness',
    href: '/docs/process/gates/ring0-push-checks#quoted-command'
  },
  {
    name: 'coherence',
    stage: 'Push',
    refuses: 'A task branch, tranche, Issue and forge state that disagree',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#coherence'
  },
  {
    name: 'dispatch-readiness',
    stage: 'Push',
    refuses: 'Dispatch of a task whose Issue, dependencies, conflicts or facts are not ready',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#dispatch-readiness'
  },
  {
    name: 'registry-gates',
    stage: 'Push',
    refuses: 'A gate registry, hooks, workflows and doctrine that disagree',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#registry-gates'
  },
  {
    name: 'branch-topology',
    stage: 'Push',
    refuses: 'A task branch with no row in its tranche’s topology',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#branch-topology'
  },
  {
    name: 'dead-branch-push',
    stage: 'Push',
    refuses: 'A push to a branch whose pull request is already closed or merged',
    implements: 'Terminal completeness',
    href: '/docs/process/gates/ring0-push-checks#dead-branch-push'
  },
  {
    name: 'first-push-dispatch',
    stage: 'Push',
    refuses: 'A first push that does not come from a dispatched task',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#first-push-dispatch'
  },
  {
    name: 'reader-resolvable-prose',
    stage: 'Push',
    refuses: 'Unresolvable references or undefined coined terms in reader-facing prose',
    implements: 'Contract validity',
    href: '/docs/process/gates/ring0-push-checks#reader-resolvable-prose'
  },
  {
    name: 'retired-vocabulary',
    stage: 'Push',
    refuses: 'Terms Vinaya has retired',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#retired-vocabulary'
  },
  {
    name: 'doctrine-portability',
    stage: 'Push',
    refuses: 'Doctrine references that depend on machine-local or author-only paths',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#doctrine-portability'
  },
  {
    name: 'doctrine-no-procedures',
    stage: 'Push',
    refuses: 'Command sequences inside doctrine',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring0-push-checks#doctrine-no-procedures'
  },
  {
    name: 'doc-claims',
    stage: 'Push',
    refuses: 'An `AEG:CLAIM` marker its cited file no longer supports',
    implements: 'Evidence freshness',
    href: '/docs/process/gates/ring0-push-checks#doc-claims'
  },
  {
    name: 'workspace-escape',
    stage: 'Push',
    refuses: 'A file reference that escapes its workspace package or resolves nowhere',
    implements: 'Contract validity',
    href: '/docs/process/gates/ring0-push-checks#workspace-escape'
  },
  {
    name: 'main-branch-refusal',
    stage: 'Commit',
    refuses: 'A commit or a push on the default branch',
    implements: 'Effect safety',
    href: '/docs/process/gates/ring0-commit-checks#main-branch-refusal'
  },
  {
    name: 'token-collection-wired',
    stage: 'Push',
    refuses: 'Usage collection that is configured but not producing events',
    implements: 'Traceability',
    href: '/docs/process/gates/ring0-push-checks#token-collection-wired'
  },
  {
    name: 'closes-n',
    stage: 'Pull request',
    refuses: 'A task PR that does not close its own Issue with valid linkage',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-pull-request-checks#closes-n'
  },
  {
    name: 'surface-scope',
    stage: 'Pull request',
    refuses: 'A beyond-Surface path missing from the authoritative beyond-Surface record (no protected-path rule yet)',
    implements: 'Scope',
    href: '/docs/process/gates/ring1-pull-request-checks#surface-scope'
  },
  {
    name: 'test-plan',
    stage: 'Pull request',
    refuses: 'A test plan whose required results are missing or not bound to the head',
    implements: 'Evidence completeness',
    href: '/docs/process/gates/ring1-pull-request-checks#test-plan'
  },
  {
    name: 'evidence-fresh',
    stage: 'Pull request',
    refuses: 'Evidence whose head, tree or result no longer matches the candidate',
    implements: 'Evidence freshness',
    href: '/docs/process/gates/ring1-pull-request-checks#evidence-fresh'
  },
  {
    name: 'review-gate',
    stage: 'Pull request',
    refuses: 'Missing, stale, superseded or unauthorized Code and Security verdicts',
    implements: 'Review validity',
    href: '/docs/process/gates/ring1-pull-request-checks#review-gate'
  },
  {
    name: 'principal-test-plan-wait',
    stage: 'Pull request',
    refuses: 'Merge while a `[principal]` test-plan item is unticked for the current head',
    implements: 'Authorization and Decision validity',
    href: '/docs/process/gates/ring1-pull-request-checks#principal-test-plan-wait'
  },
  {
    name: 'body-bare-digits',
    stage: 'Pull request',
    refuses: 'Bare digits in narrative PR prose',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-pull-request-checks#body-bare-digits'
  },
  {
    name: 'issue-title-grammar',
    stage: 'Issue write',
    refuses: 'A task Issue title outside Vinaya’s grammar',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-issue-checks#issue-title-grammar'
  },
  {
    name: 'issue-objectives-numbering',
    stage: 'Issue write',
    refuses: 'Malformed objective numbering',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-issue-checks#issue-objectives-numbering'
  },
  {
    name: 'issue-parts-coverage',
    stage: 'Issue write',
    refuses: 'A Part that cites no valid objective',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-issue-checks#issue-parts-coverage'
  },
  {
    name: 'issue-surface-globs',
    stage: 'Issue write',
    refuses: 'Invalid or unresolvable Surface globs',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-issue-checks#issue-surface-globs'
  },
  {
    name: 'issue-milestone-attach',
    stage: 'Issue write',
    refuses:
      'On edit, a task Issue whose Milestone is not the one its tranche label resolves to (not checked on create)',
    implements: 'Vinaya',
    href: '/docs/process/gates/ring1-issue-checks#issue-milestone-attach'
  }
]
