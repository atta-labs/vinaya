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

/**
 * A self-hosting repository's native local-run adapter, relative to its root: when it is committed, the generated
 * hook (in a repository that vendors the CLI) hands every test-running push to it — `select` freezes the push's plan
 * from the shared selector, `run` executes that plan once per native runner group and records the result — instead
 * of the single `bun test` invocation {@link readyTestCommand} names. A repository without it keeps that command.
 */
export const REPOSITORY_LOCAL_RUN = 'scripts/test-suites/local-run.ts'

/** The subcommand of {@link REPOSITORY_LOCAL_RUN} that runs exactly the named identities and nothing else. */
const NATIVE_EXACT = 'exact'

/**
 * The aggregate native command a local push executed: the frozen `<test>@<configuration>` identities, sorted, and
 * the verification context they ran under. It is a real command — run, it executes exactly those identities under
 * their own runners and refuses under any other context — and it is the text the push's receipt is filed under, so a
 * Test Plan line naming it reuses that receipt and never a run of another runner, configuration or environment.
 */
export function nativeRunCommand(context: string, identities: readonly string[]): string {
  return `bun ${REPOSITORY_LOCAL_RUN} ${NATIVE_EXACT} --context ${context} -- ${identities.join(' ')}`
}

/** The context and identities of a {@link nativeRunCommand} text, or null for any other command. */
export function parseNativeRunCommand(command: string): { context: string; identities: string[] } | null {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] !== 'bun' || tokens[1] !== REPOSITORY_LOCAL_RUN || tokens[2] !== NATIVE_EXACT) return null
  if (tokens[3] !== '--context' || !/^[0-9a-f]{64}$/.test(tokens[4] ?? '') || tokens[5] !== '--') return null
  const identities = tokens.slice(6)
  if (identities.length === 0 || identities.some((identity) => identity.lastIndexOf('@') <= 0)) return null
  return { context: tokens[4] as string, identities }
}

/** True for a command shaped like {@link nativeRunCommand}. */
export const isNativeRunCommand = (command: string): boolean => parseNativeRunCommand(command) !== null
