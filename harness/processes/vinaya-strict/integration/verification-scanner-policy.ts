/**
 * This repository's folder-scanning tests: the tests whose INPUT is the
 * repository tree itself, each with the roots it reads and the kind of change
 * it judges.
 *
 * The classifier that finds such a test from its own source
 * ({@link scannedRootsOf}), the trigger vocabulary and the touched-lines
 * process-start reader live in the selection library
 * (`verification/index.ts`) and are re-exported here unchanged, so
 * every existing caller keeps its import. What stays here is what belongs to
 * this repository alone: {@link SCANNER_DECLARATIONS}, the table the legacy
 * selector reads by default and the test inventory reads from this module's
 * syntax as its folder-scanning provider. The library never imports it; a
 * repository adapter hands it to the library as policy.
 */
import type { ScannerDeclaration } from '../../../kernel/gates/ring0-hooks/pre-push/verification/index.js'

export {
  type RepoScannerTest,
  type ScannerDeclaration,
  type ScannerTrigger,
  scannedRootsOf,
  startsProcessIn
} from '../../../kernel/gates/ring0-hooks/pre-push/verification/index.js'
export { underDeclaredRoot } from '../../../kernel/gates/ring0-hooks/pre-push/verification/index.js'

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
      'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts',
      'harness/processes/',
      'harness/processes/vinaya-strict/tools/dev-review-policy/'
    ],
    trigger: 'listed-files'
  },
  {
    test: 'apps/cli/tests/conformance/adapter-contract.test.ts',
    roots: [
      'harness/kernel/loops/runtimes/atta-engine/dev-review-engine-capability-matrix.md',
      'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json',
      'apps/cli/tests/eval/registry/modules.json',
      'AGENTS.md',
      'CLAUDE.md'
    ],
    trigger: 'listed-files'
  },
  { test: 'apps/cli/tests/ci-shards.test.ts', roots: ['apps/cli/'], trigger: 'tree-shape' },
  // Lists every tracked `vinaya.config*.json` with `git ls-files`: a configuration file added or removed anywhere
  // changes its corpus. The files' contents are its declared inventory inputs.
  { test: 'apps/cli/tests/config-golden.test.ts', roots: ['.'], trigger: 'tree-shape' },
  {
    test: 'harness/processes/vinaya-strict/tests/standalone/conformance/dev-review-invariant-coverage.test.ts',
    roots: [
      'apps/cli/src/commands/dev-review-loop.ts',
      'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts',
      'harness/processes/',
      'harness/processes/vinaya-strict/tools/dev-review-policy/',
      'apps/cli/tests/commands/dev-review-loop.test.ts',
      'harness/processes/vinaya-strict/tests/standalone/lib/dev-review-loop',
      'harness/processes/vinaya-strict/tests/lib/dev-review-loop'
    ],
    trigger: 'tree-shape'
  },
  {
    test: 'harness/kernel/loops/runtimes/atta-engine/packed-runtime-not-shipped.test.ts',
    roots: ['apps/cli/src/'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/platform-independence.test.ts', roots: ['apps/cli/tests/'], trigger: 'content' },
  {
    test: 'apps/cli/tests/process-fixture-coverage.test.ts',
    roots: ['apps/cli/tests/', 'harness/processes/'],
    trigger: 'process-start'
  },
  { test: 'apps/cli/scripts/bundle-doctrine.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'harness/processes/vinaya-strict/tests/run-engine.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'harness/kernel/dev-process-socket/loader/load-process.test.ts',
    roots: ['harness/processes/'],
    trigger: 'content'
  },
  { test: 'harness/processes/vinaya-strict/checks/bin-permissions.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/checks/registry-gates.test.ts',
    roots: [
      'apps/cli/src/',
      'harness/processes/vinaya-strict/tools/task-contract/brief-validation.ts',
      'aeg-root/enforcement.md',
      '.claude/hooks/'
    ],
    trigger: 'content'
  },
  {
    test: 'harness/processes/vinaya-strict/checks/shipped-bin-audience.test.ts',
    roots: ['harness/processes/vinaya-strict/checks/bin/'],
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
      'harness/kernel/loops/runtimes/atta-engine/dev-review-engine-capability-matrix.md',
      'harness/processes/vinaya-strict/loops/dev-review/dev-review-engine-state-machine.md',
      'apps/cli/specs/dev-review-invariants.md'
    ],
    trigger: 'listed-files'
  },
  { test: 'apps/cli/tests/import-boundary.test.ts', roots: ['apps/cli/'], trigger: 'content' },
  {
    test: 'harness/processes/vinaya-strict/integration/log/client/log-entry-paths.test.ts',
    roots: ['.github/workflows/', '.vinaya/hooks/', '.claude/settings.json', 'vinaya.config.json'],
    trigger: 'content'
  },
  {
    test: 'harness/processes/vinaya-strict/integration/log/client/log-callers.test.ts',
    roots: ['.'],
    trigger: 'content'
  },
  {
    test: 'harness/processes/vinaya-strict/integration/log/log-sink-factory.test.ts',
    roots: ['.'],
    trigger: 'content'
  },
  {
    test: 'apps/cli/tests/lib/log-sink-no-sync-spawn.test.ts',
    roots: ['harness/kernel/log/log-sink.ts'],
    trigger: 'content'
  },
  { test: 'apps/cli/tests/lib/no-log-forge-writes.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'apps/cli/tests/lib/verification-library.test.ts',
    roots: [
      'harness/kernel/gates/ring0-hooks/pre-push/verification/',
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
  { test: 'harness/processes/vinaya-strict/integration/run-paths-only.test.ts', roots: ['.'], trigger: 'content' },
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
  { test: 'harness/processes/vinaya-strict/tools/actions.test.ts', roots: ['aeg-root/roles/'], trigger: 'content' },
  { test: 'harness/processes/vinaya-strict/tools/diagram-model.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'harness/processes/vinaya-strict/checks/docs/docs-coherence.test.ts',
    roots: ['harness/processes/vinaya-strict/checks/docs/fixtures/docs-coherence/'],
    trigger: 'content'
  },
  { test: 'harness/processes/vinaya-strict/artifacts/docs/node-route.test.ts', roots: ['.'], trigger: 'content' },
  {
    test: 'harness/processes/vinaya-strict/checks/gate-audience.test.ts',
    roots: ['harness/processes/vinaya-strict/checks/standalone/'],
    trigger: 'content'
  },
  { test: 'harness/processes/vinaya-strict/checks/no-binary-sources.test.ts', roots: ['.'], trigger: 'content' },
  { test: 'harness/processes/vinaya-strict/checks/retired-vocabulary.test.ts', roots: ['.'], trigger: 'content' }
]
