/**
 * The adopter test-runner contract the generated pre-push hook follows in its ready mode (the push after both
 * reviewers approved). A repository declares its local test runner as an executable at `ADOPTER_TEST_RUNNER`,
 * committed with the repository: the hook runs it from the repository root with no arguments, and its exit status
 * is the verdict (zero passes, anything else refuses the push). It may use any toolchain; Vinaya never installs or
 * assumes one, Bun included. A repository that declares none runs no local tests: the hook prints
 * `NO_LOCAL_TESTS_MARKER` and the push passes, and the loop records and logs that state rather than reading it as
 * a tested pass. A repository with no pre-push hook at all is the same state.
 */

/** Where an adopter declares its local test runner, relative to the repository root. */
export const ADOPTER_TEST_RUNNER = '.vinaya/test-runner'

/** The line the hook prints when the repository runs no local tests. */
export const NO_LOCAL_TESTS_MARKER = 'vinaya pre-push: no local tests'

/**
 * The exact test command the generated hook (in a repository that vendors the CLI) runs and caches for `files`:
 * the same text its `VINAYA_TEST_CMD` line builds, so a Test Plan line written from it reuses that cached run.
 */
export function readyTestCommand(files: readonly string[]): string {
  return `bun test --timeout=30000 -- ${files.join(' ')}`
}
