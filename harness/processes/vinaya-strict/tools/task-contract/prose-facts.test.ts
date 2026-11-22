import { describe, expect, it } from 'bun:test'
import { NO_GATE_CUTOVERS } from './gate-cutovers'
import { DEFAULT_COLLISION_THRESHOLD } from './issue-validation'
import { validateIssueContent } from './forge/forge-write'
import { checkConditionWordsNeedPremise, checkProsePathsExist } from './prose-facts'

const PINNED = 'apps/demo/src/greeting.ts'
const TRACKED = [PINNED, 'apps/demo/README.md', 'apps/demo/src/a/util.ts', 'apps/demo/src/b/util.ts', 'package.json']

type Fill = {
  boundary?: string
  pinned?: string
  out?: string
  dependency?: string
  traps?: string
  agent?: string
  escalate?: string
  part?: string
  stop?: string
  premises?: string
}

/** One minimal Issue body; each field a test varies is a parameter. */
function body(fill: Fill = {}): string {
  return `**Tier:** 1
**Project:** demo
**Type:** feat

## Objectives

O1. The greeting names the caller it was asked to greet.

## Documentation

- apps/demo/README.md — the greeting wording (O1)
${fill.premises ? `\n## Premises\n\n${fill.premises}\n` : ''}
## Planner's rationale

**Boundary** — ${fill.boundary ?? 'The greeting learns the caller name.'} Pinned files: ${fill.pinned ?? `\`${PINNED}\``} Out: ${fill.out ?? 'the command-line wrapper.'}

**Sizing** — One verification story, one function, one file, one failure mode.

**Project(s) + blast radius** — demo only; no shared package changes.

**Dependency rationale** — ${fill.dependency ?? 'No Depends-on; no Conflicts-with.'}

**Traps to avoid** — ${fill.traps ?? 'do NOT trim the caller name inside the greeting.'}

**Suggested agent-class** — ${fill.agent ?? 'fast — one pure function and its test.'}

**Stop-and-escalate** — ${fill.escalate ?? 'if the greeting needs a locale, escalate.'}

**Docs to keep coherent** — no-doc-surface — the greeting carries no documentation.

## Surface

in: apps/demo/src
out: apps/demo/cli

## Parts

Part 1 (O1) — ${fill.part ?? 'The greeting returns a sentence naming the caller.'}

## Test plan

\`\`\`
bun test apps/demo/tests/greeting.test.ts → 0 fail (O1)
\`\`\`

## Stop conditions

- ${fill.stop ?? 'The greeting cannot name the caller without changing its signature.'}

## Origin

Principal-directed.
`
}

const paths = (b: string, tracked: string[] = TRACKED): string[] => checkProsePathsExist(b, tracked).errors
const words = (b: string): string[] => checkConditionWordsNeedPremise(b).errors

/** Every finding the gate returns for a body, with the two new rules registered. */
function gate(b: string): string[] {
  return validateIssueContent({
    body: b,
    labels: ['vinaya/tranche:demo-v1'],
    sharedPackages: [],
    projectPaths: [{ name: 'demo', path: 'apps/demo' }],
    retryCommand: 'retry',
    issueNumber: null,
    briefSectionsSinceIssue: null,
    resolvesToFile: () => true,
    readFile: (path) => (path === PINNED ? 'export const greeting = 1\n' : TRACKED.includes(path) ? '# Demo\n' : null),
    docOwnersContent: null,
    milestoneSiblings: null,
    subjectRef: '',
    collisionPeers: null,
    subjectFiles: [PINNED],
    collisionThreshold: DEFAULT_COLLISION_THRESHOLD,
    commandReference: { file: null, binary: 'vinaya', commands: [], text: '' },
    configReference: { files: [], keys: [], text: '' },
    pinnedFileImporters: [],
    existsInTree: () => false,
    trackedFiles: TRACKED
  })
    .filter((e) => e.severity !== 'warning')
    .map((e) => e.message)
}

describe('a backticked file the tree does not hold', () => {
  it('passes a body that names only tracked files', () => {
    expect(paths(body({ traps: `do NOT edit \`${PINNED}\` by hand.` }))).toEqual([])
  })

  it('is refused with the path and the field it sits in', () => {
    const errors = paths(body({ traps: 'do NOT touch `apps/demo/src/missing.ts`.' }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Traps to avoid')
    expect(errors[0]).toContain('`apps/demo/src/missing.ts`')
  })

  it('names the Boundary, Dependency rationale, agent-class, Stop-and-escalate, a Part and the Stop conditions', () => {
    const errors = paths(
      body({
        boundary: 'It reads `apps/demo/src/b1.ts`.',
        dependency: 'See `apps/demo/src/b2.ts`.',
        agent: 'high — `apps/demo/src/b3.ts` is hard.',
        escalate: 'if `apps/demo/src/b4.ts` changes.',
        part: 'Outcome naming the caller beyond `apps/demo/src/b5.ts` today.',
        stop: 'stop when `apps/demo/src/b6.ts` is missing.'
      })
    )
    const fields = errors.map((e) => /the (.+?) names/.exec(e)?.[1])
    expect(fields).toEqual([
      'Boundary',
      'Dependency rationale',
      'Suggested agent-class',
      'Stop-and-escalate',
      'Stop conditions',
      'Part 1'
    ])
  })

  it('is not refused when the Issue pins it to create', () => {
    const created = 'apps/demo/src/new.ts'
    expect(paths(body({ pinned: `\`${PINNED}\`, \`${created}\``, traps: `do NOT forget \`${created}\`.` }))).toEqual([])
  })

  it('is not refused when the Out clause names it', () => {
    expect(paths(body({ out: '`apps/demo/src/other.ts`.', traps: 'leave `apps/demo/src/other.ts` alone.' }))).toEqual(
      []
    )
  })

  it('is not refused when a premise names it, a deferred premise included', () => {
    const premises = '- after #5: `apps/demo/src/later.ts` contains `export`'
    expect(paths(body({ premises, traps: 'the task reads `apps/demo/src/later.ts`.' }))).toEqual([])
  })

  it('is not refused when it is the tail of exactly one tracked path, and is when the tail is ambiguous', () => {
    expect(paths(body({ traps: 'do NOT edit `greeting.ts`.' }))).toEqual([])
    expect(paths(body({ traps: 'do NOT edit `util.ts`.' }))).toHaveLength(1)
  })

  it('does not judge a token with no file extension', () => {
    const traps = 'keep `@attalabs/vinaya`, `apps/demo/src`, `.changeset`, `task/demo-v1/1` and `process.env` apart.'
    expect(paths(body({ traps }))).toEqual([])
  })

  it('does not read fenced blocks', () => {
    const traps = 'do NOT copy this:\n\n```\n`apps/demo/src/missing.ts`\n```'
    expect(paths(body({ traps }))).toEqual([])
  })

  it('reports nothing with no tracked-file list', () => {
    expect(paths(body({ traps: 'do NOT touch `apps/demo/src/missing.ts`.' }), [])).toEqual([])
  })
})

describe('a statement about the code condition outside the Boundary', () => {
  it('is refused when the Issue declares no premise, naming the field and the word', () => {
    const errors = words(body({ dependency: 'The signal is already wired.' }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Dependency rationale')
    expect(errors[0]).toContain('"already"')
  })

  it('covers Traps, agent-class, Stop-and-escalate and a Part', () => {
    const fields = words(
      body({
        traps: 'it is currently slow.',
        agent: 'high — it is wired twice.',
        escalate: 'if it is already gone.',
        part: 'The greeting is currently replaced by a sentence naming the caller.'
      })
    ).map((e) => /the (.+?) says/.exec(e)?.[1])
    expect(fields).toEqual(['Traps to avoid', 'Suggested agent-class', 'Stop-and-escalate', 'Part 1'])
  })

  it('passes once the Issue declares a premise', () => {
    const premises = `- \`${PINNED}\` contains \`greeting\``
    expect(words(body({ dependency: 'The signal is already wired.', premises }))).toEqual([])
  })

  it('leaves the Boundary to its own rule', () => {
    expect(words(body({ boundary: 'The signal is already wired.' }))).toEqual([])
  })
})

describe('the printed fix', () => {
  it('passes the gate for a path the Issue pins to create', () => {
    const created = 'apps/demo/src/new.ts'
    const refused = body({ traps: `do NOT forget \`${created}\`.` })
    expect(gate(refused).some((m) => m.includes('Prose files'))).toBe(true)
    const fixed = body({ pinned: `\`${PINNED}\`, \`${created}\``, traps: `do NOT forget \`${created}\`.` })
    expect(gate(fixed)).toEqual([])
  })

  it('passes the gate for a full path written in place of an ambiguous tail', () => {
    expect(gate(body({ traps: 'do NOT edit `util.ts`.' })).some((m) => m.includes('Prose files'))).toBe(true)
    expect(gate(body({ traps: 'do NOT edit `apps/demo/src/a/util.ts`.' }))).toEqual([])
  })

  it('passes the gate for a premise added to a condition statement', () => {
    const refused = body({ dependency: 'No Depends-on; the signal is already wired.' })
    expect(gate(refused).some((m) => m.includes('already'))).toBe(true)
    const fixed = body({
      dependency: 'No Depends-on; the signal is already wired.',
      premises: `- \`${PINNED}\` contains \`greeting\``
    })
    expect(gate(fixed)).toEqual([])
  })
})
