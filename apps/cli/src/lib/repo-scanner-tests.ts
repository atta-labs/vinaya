/**
 * This repository's folder-scanning tests: the tests whose INPUT is the
 * repository tree itself, each with the roots it reads and the kind of change
 * it judges.
 *
 * The classifier that finds such a test from its own source
 * ({@link scannedRootsOf}), the trigger vocabulary and the touched-lines
 * process-start reader live in the selection library
 * (`verification/scanner-inputs.ts`) and are re-exported here unchanged, so
 * every existing caller keeps its import. What stays here is what belongs to
 * this repository alone: {@link SCANNER_DECLARATIONS}, the table the legacy
 * selector reads by default and the test inventory reads from this module's
 * syntax as its folder-scanning provider. The library never imports it; a
 * repository adapter hands it to the library as policy.
 */
import type { ScannerDeclaration } from './verification/scanner-inputs.js'

export {
  type RepoScannerTest,
  type ScannerDeclaration,
  type ScannerTrigger,
  scannedRootsOf,
  startsProcessIn
} from './verification/scanner-inputs.js'
export { underDeclaredRoot } from './verification/path-pattern.js'

/**
 * Every folder-scanning test in this repository, with what it reads and what
 * it judges. The selector reads this; a test checks that every file
 * {@link scannedRootsOf} classifies has an entry here and that no entry names
 * a file that no longer scans. `listed-files` declarations intentionally do
 * not walk a tree and are exempt from that classifier check. Paths that do not
 * exist in another repository select nothing there.
 */
export const SCANNER_DECLARATIONS: readonly ScannerDeclaration[] = [
  {
    test: 'apps/cli/tests/conformance/dev-review-engine-architecture-exit.test.ts',
    roots: [
      'apps/cli/tests/fixtures/dev-review-engine-scenarios.json',
      'apps/cli/tests/fixtures/dev-review-architecture-invariants.json',
      'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json',
      'apps/cli/src/commands/dev-review-loop.ts',
      'apps/cli/src/lib/dev-review-loop.ts',
      'apps/cli/src/lib/dev-review-loop/',
      'packages/aeg-core/src/dev-review-loop/'
    ],
    trigger: 'listed-files'
  },
  {
    test: 'apps/cli/tests/conformance/adapter-contract.test.ts',
    roots: [
      'apps/cli/specs/dev-review-engine-capability-matrix.md',
      'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json',
      'apps/cli/tests/eval/registry/modules.json',
      'AGENTS.md',
      'CLAUDE.md'
    ],
    trigger: 'listed-files'
  },
  { test: 'apps/cli/tests/ci-shards.test.ts', roots: ['apps/cli/'], trigger: 'tree-shape' },
  {
    test: 'apps/cli/tests/conformance/dev-review-invariant-coverage.test.ts',
    roots: [
      'apps/cli/src/commands/dev-review-loop.ts',
      'apps/cli/src/lib/dev-review-loop.ts',
      'apps/cli/src/lib/dev-review-loop/',
      'packages/aeg-core/src/dev-review-loop/',
      'apps/cli/tests/commands/dev-review-loop.test.ts',
      'apps/cli/tests/lib/dev-review-loop'
    ],
    trigger: 'tree-shape'
  },
  {
    test: 'apps/cli/tests/conformance/packed-runtime-not-shipped.test.ts',
    roots: ['apps/cli/src/'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/platform-independence.test.ts', roots: ['apps/cli/tests/'], trigger: 'content' },
  { test: 'apps/cli/tests/process-fixture-coverage.test.ts', roots: ['apps/cli/tests/'], trigger: 'process-start' },
  { test: 'apps/cli/scripts/bundle-doctrine.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'processes/vinaya/tests/run-engine.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'harness/dev-process/loader/load-process.test.ts', roots: ['processes/'], trigger: 'content' },
  { test: 'apps/cli/tests/checks/bin-permissions.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/checks/registry-gates.test.ts',
    roots: [
      'apps/cli/src/',
      'packages/aeg-core/bin/',
      'packages/aeg-core/src/brief-validation.ts',
      'aeg-root/enforcement.md',
      '.claude/hooks/'
    ],
    trigger: 'content'
  },
  {
    test: 'apps/cli/tests/checks/shipped-bin-audience.test.ts',
    roots: ['apps/cli/src/checks/bin/'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/commands/sync.test.ts', roots: ['apps/cli/src/commands/sync.ts'], trigger: 'content' },
  { test: 'apps/cli/tests/doctrine.test.ts', roots: ['apps/cli/src/index.ts'], trigger: 'content' },
  { test: 'apps/cli/tests/eval/not-shipped.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/eval/registry.test.ts',
    roots: [
      'apps/cli/tests/eval/registry/',
      'apps/cli/specs/dev-review-evaluation-program.md',
      'apps/cli/specs/dev-review-evaluation-program.provenance.json'
    ],
    trigger: 'listed-files'
  },
  {
    test: 'apps/cli/tests/eval/registry-typed-sources.test.ts',
    roots: [
      'apps/cli/tests/eval/registry/',
      'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json',
      'apps/cli/tests/fixtures/dev-review-architecture-invariants.json',
      'apps/cli/specs/dev-review-engine-capability-matrix.md',
      'apps/cli/specs/dev-review-engine-state-machine.md',
      'apps/cli/specs/dev-review-invariants.md'
    ],
    trigger: 'listed-files'
  },
  { test: 'apps/cli/tests/import-boundary.test.ts', roots: ['apps/cli/'], trigger: 'content' },
  {
    test: 'apps/cli/tests/lib/log-entry-paths.test.ts',
    roots: ['.github/workflows/', '.vinaya/hooks/', '.claude/settings.json', 'vinaya.config.json'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/lib/log-callers.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/lib/log-sink-no-sync-spawn.test.ts',
    roots: ['apps/cli/src/lib/log-sink.ts'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/lib/no-log-forge-writes.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/lib/verification-library.test.ts',
    roots: [
      'apps/cli/src/lib/verification/',
      'apps/cli/LICENSE',
      'scripts/test-suites/inventory.json',
      'scripts/test-suites/inventory-check.ts',
      'scripts/test-suites/repository-selection.ts'
    ],
    trigger: 'listed-files'
  },
  {
    test: 'apps/cli/tests/log-destination-isolation.test.ts',
    roots: ['apps/cli/src/', 'apps/cli/tests/'],
    trigger: 'content'
  },
  // Spelled in two halves: the retired role id this test hunts is refused
  // anywhere under a source directory, this table included.
  { test: `apps/cli/tests/no-brief-${'author'}.test.ts`, roots: ['.'], trigger: 'content' },
  { test: 'apps/cli/tests/run-paths-only.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'apps/cli/tests/surface-index.test.ts', roots: ['apps/cli/src/commands/'], trigger: 'content' },
  { test: 'apps/cli/tests/surface-spec-exports.test.ts', roots: ['apps/cli/src/commands/'], trigger: 'content' },
  {
    test: 'apps/vinaya-portal/src/lib/docs/private-source-links.test.ts',
    roots: ['apps/vinaya-portal/src/app/(site)/docs/'],
    trigger: 'content'
  },
  {
    test: 'apps/vinaya-portal/src/lib/import-boundary.test.ts',
    roots: ['apps/vinaya-portal/src/'],
    trigger: 'content'
  },
  { test: 'packages/aeg-core/src/actions.test.ts', roots: ['aeg-root/roles/'], trigger: 'content' },
  { test: 'packages/aeg-core/src/diagram-model.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'packages/aeg-core/src/docs/docs-coherence.test.ts',
    roots: ['packages/aeg-core/tests/fixtures/docs-coherence/'],
    trigger: 'content'
  },
  { test: 'packages/aeg-core/src/docs/node-route.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'packages/aeg-core/src/gate-audience.test.ts', roots: ['packages/aeg-core/bin/'], trigger: 'content' },
  { test: 'packages/aeg-core/src/no-binary-sources.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'packages/aeg-core/src/retired-vocabulary.test.ts', roots: ['.'], trigger: 'content' }
]
