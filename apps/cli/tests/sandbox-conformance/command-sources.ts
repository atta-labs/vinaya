/**
 * Where the sandbox conformance suite's command list comes from: every
 * command the Developer doctrine and the brief tell a Developer to run, read
 * off the texts themselves rather than retyped by hand, so a command added
 * to either text without an entry in `commands.json` fails the suite.
 *
 * Four texts are read — the developer role file (what `vinaya doctrine
 * --role developer --print` prints), its reference document, the brief
 * template, and one brief rendered from that template by the real
 * `renderBrief` over fixed fixture facts (the renderer adds commands of its
 * own — the Step 0 install, the pre-push hook line — that the template alone
 * never names).
 *
 * A "command" is a fenced-block line, or an inline code span, whose first
 * word is `git`, `gh`, `bun`, `bunx` or `vinaya`. Five normalizations keep
 * one command one form across the texts: a fenced line ending in `\` is
 * joined with the next, leading `NAME=value` environment assignments are
 * dropped, a Test Plan's ` → <expected result>` suffix is dropped, a `&&`
 * chain is split into its own commands (a
 * leading `cd <dir>` is dropped — the suite already runs every command with
 * the task worktree as its working directory, which is all that `cd` does),
 * and `bun apps/cli/src/index.ts` is written `vinaya`, the one name the
 * doctrine uses for the CLI however a repository invokes it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BriefFacts, NO_GATE_CUTOVERS, parseRationaleFields, renderBrief } from '@attalabs/aeg-core'

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

/** Repo-relative paths of the hand-written texts the command list is read from. */
export const DOCTRINE_SOURCES = [
  'aeg-root/roles/developer.md',
  'aeg-root/roles/developer/reference.md',
  'aeg-root/templates/brief-template.md'
] as const

/**
 * Every repo-relative file (or, when it ends in `/`, directory) the suite's
 * result depends on. On a pull request whose diff touches none of them the
 * live runs are skipped (`conformanceSkipReason`, `sandbox-launch.ts`). A test
 * keeps it complete: every text the command list is read from and every
 * module the suite imports must be covered.
 */
export const SUITE_INPUTS: readonly string[] = [
  ...DOCTRINE_SOURCES,
  // The command data file, the known-failures list and the suite's own code.
  'apps/cli/tests/sandbox-conformance/',
  'apps/cli/tests/lib/process-fixture.ts',
  'apps/cli/tests/lib/dispatch/driver-socket-reach.ts',
  // The driver code that builds each agent's sandbox settings.
  'apps/cli/src/lib/dispatch.ts',
  'apps/cli/src/lib/worker-boundary.ts',
  'apps/cli/src/lib/task-tools/dev-tools-registration.ts',
  // The brief renderer and the types it is built from.
  'packages/aeg-core/src/',
  'packages/aeg-types/src/',
  'bun.lock',
  'vinaya.config.json',
  '.github/workflows/ci.yml'
]

/** Whether `path` is one of `SUITE_INPUTS`, or inside one of its directories. */
export function isSuiteInput(path: string): boolean {
  return SUITE_INPUTS.some((input) => (input.endsWith('/') ? path.startsWith(input) : path === input))
}

/** The label the rendered brief's commands are reported under. */
export const RENDERED_BRIEF_SOURCE = 'rendered brief (renderBrief over aeg-root/templates/brief-template.md)'

const COMMAND_HEAD = /^(git|gh|bun|bunx|vinaya)\s/
const VENDORED_CLI = /^bun apps\/cli\/src\/index\.ts(?=\s|$)/

const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/
const RESULT_ARROW = / → .*$/

function normalizeSegment(segment: string): string | null {
  const trimmed = segment.trim().replace(ENV_PREFIX, '').replace(RESULT_ARROW, '').replace(VENDORED_CLI, 'vinaya')
  if (trimmed.startsWith('cd ')) return null
  return COMMAND_HEAD.test(trimmed) ? trimmed : null
}

function commandsOfLine(line: string): string[] {
  const trimmed = line.trim().replace(ENV_PREFIX, '')
  if (!COMMAND_HEAD.test(trimmed) && !trimmed.startsWith('cd ')) return []
  return trimmed
    .split(' && ')
    .map(normalizeSegment)
    .filter((c): c is string => c !== null)
}

/** Every command form `text` names, in first-seen order, each once. */
export function extractCommands(text: string): string[] {
  const found: string[] = []
  const fences = /```[^\n]*\n([\s\S]*?)```/g
  for (const fence of text.matchAll(fences)) {
    const joined = (fence[1] ?? '').replace(/\\\n\s*/g, '')
    for (const line of joined.split('\n')) found.push(...commandsOfLine(line))
  }
  const prose = text.replace(fences, '')
  for (const span of prose.matchAll(/`([^`\n]+)`/g)) found.push(...commandsOfLine(span[1] ?? ''))
  return [...new Set(found)]
}

const FIXTURE_ISSUE_BODY = `
**Boundary** — Change \`apps/cli/src/fixture.ts\`. Pinned files: \`apps/cli/src/fixture.ts\`. Out: everything else.

**Dependency rationale** — \`Depends-on: —\`.

**Traps to avoid** — None beyond the brief.

**Suggested agent-class** — mid — one file.

**Stop-and-escalate** — If a second file is needed, stop and escalate.
`

/**
 * Fixed facts for one ordinary task, so the rendered brief carries every
 * command the renderer itself adds and nothing task-specific: the Test Plan
 * line is the one this repository's briefs always carry.
 */
function fixtureFacts(): BriefFacts {
  return {
    trancheSlug: 'conformance-fixture-v1',
    taskId: '1',
    title: 'a fixture task for the sandbox conformance suite',
    issue: 1,
    projects: ['cli'],
    dependsOn: [],
    conflictsWith: [],
    rationale: parseRationaleFields(FIXTURE_ISSUE_BODY),
    objectives: [{ id: 'O1', text: 'A fixture objective.' }],
    surface: { in: ['apps/cli/src'], out: [] },
    parts: [{ n: 1, objectiveIds: [1], text: 'Change the fixture file.' }],
    testPlan: { kind: 'commands', lines: ['bun apps/cli/src/index.ts check --all → exits 0'], principal: [] },
    stopConditions: ['If a second file is needed, stop and escalate.'],
    documentation: { kind: 'none' },
    premises: [],
    cutovers: NO_GATE_CUTOVERS,
    dispatchReady: true,
    dispatchBlockers: [],
    surfaceFiles: [{ path: 'apps/cli/src/fixture.ts', sha256: 'a'.repeat(64), packageName: '@attalabs/vinaya' }],
    consumersOf: () => [],
    docOwnersContent: null,
    sourceRevision: 'a'.repeat(40),
    cliInvocation: 'bun apps/cli/src/index.ts',
    localGateCommands: {
      dispatchReadiness: 'bun packages/aeg-core/bin/verify-dispatch.ts',
      docCoverage: 'bun packages/aeg-core/bin/verify-docs.ts'
    }
  }
}

/** One brief rendered by the real renderer from the real template. Throws when the fixture no longer renders — the suite must never silently read an empty brief. */
export function renderFixtureBrief(): string {
  const template = readFileSync(join(REPO_ROOT, 'aeg-root/templates/brief-template.md'), 'utf8')
  const result = renderBrief(fixtureFacts(), template)
  if (!result.ok) throw new Error(`fixture brief no longer renders — missing: ${result.missing.join(', ')}`)
  return result.brief
}

/** Every command form, keyed to the first source that names it. */
export function commandsTheTextsName(): Map<string, string> {
  const bySource: [string, string][] = DOCTRINE_SOURCES.map((path) => [
    path,
    readFileSync(join(REPO_ROOT, path), 'utf8')
  ])
  bySource.push([RENDERED_BRIEF_SOURCE, renderFixtureBrief()])
  const out = new Map<string, string>()
  for (const [source, text] of bySource) {
    for (const command of extractCommands(text)) if (!out.has(command)) out.set(command, source)
  }
  return out
}
