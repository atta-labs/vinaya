import { DEFAULT_COLLISION_THRESHOLD, type TaskFileFacts } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import { resolveCollisionThreshold, type VinayaConfig } from '../../src/lib/config'
import { buildCollisionPeers, pinnedFilesOf, validateIssueContent } from '../../src/lib/forge-write'

// The forced-companion gates are dormant here — this file exercises only the
// pinned-file collision findings, so the command/config references carry no
// rows and no file, and nothing in the tree is claimed.
const DORMANT_COMMAND_REFERENCE = { file: null, binary: 'vinaya', commands: [], text: '' }
const DORMANT_CONFIG_REFERENCE = { files: [], keys: [], text: '' }

// The CLI half of the pinned-file collision gate: the threshold an adopter
// config resolves to, the pinned-file extraction the gate compares with, and
// the severity split `validateIssueContent` turns one comparison into — a
// refusal blocks the write, an under-threshold overlap is a warning and the
// Issue is accepted. The comparison itself is pure and tested in
// `packages/aeg-core/src/issue-validation.test.ts`; what is proved here is the
// wiring around it.

describe('resolveCollisionThreshold', () => {
  it('a null config resolves to the built-in default — an adopter who never heard of the key still gets the rule', () => {
    expect(resolveCollisionThreshold(null)).toBe(DEFAULT_COLLISION_THRESHOLD)
  })

  it('a config with no `planning` key resolves to the built-in default', () => {
    const config = { rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true } } as VinayaConfig
    expect(resolveCollisionThreshold(config)).toBe(DEFAULT_COLLISION_THRESHOLD)
  })

  it('a declared threshold is returned verbatim', () => {
    expect(resolveCollisionThreshold({ planning: { collisionThreshold: 5 } } as VinayaConfig)).toBe(5)
  })

  it('a declared `0` is honoured as a real value, never conflated with an absent key', () => {
    expect(resolveCollisionThreshold({ planning: { collisionThreshold: 0 } } as VinayaConfig)).toBe(0)
  })
})

describe('pinnedFilesOf', () => {
  const tracked = [
    'packages/aeg-core/src/issue-validation.ts',
    'apps/cli/src/lib/forge-write.ts',
    'apps/cli/src/lib/config.ts',
    'packages/sources/src/config-reference.ts'
  ]

  const bodyWith = (boundary: string) => `**Boundary** — ${boundary}\n\n**Sizing** — one agent.\n`

  it('reads the files a Boundary pins, through the renderer’s own extraction', () => {
    const body = bodyWith(
      'In: the check itself. Pinned files: `packages/aeg-core/src/issue-validation.ts`, `apps/cli/src/lib/forge-write.ts`. Out: merging anything.'
    )
    expect(pinnedFilesOf(body, tracked).sort()).toEqual([
      'apps/cli/src/lib/forge-write.ts',
      'packages/aeg-core/src/issue-validation.ts'
    ])
  })

  it('resolves a bare filename elided from a shared prefix, the same way the brief renderer does', () => {
    expect(pinnedFilesOf(bodyWith('Pinned files: `config-reference.ts`.'), tracked)).toEqual([
      'packages/sources/src/config-reference.ts'
    ])
  })

  it('never invents a file — a token matching no tracked path is dropped', () => {
    expect(pinnedFilesOf(bodyWith('Pinned files: `packages/nowhere/src/ghost.ts`.'), tracked)).toEqual([])
  })

  it('a body with no Boundary field at all pins nothing', () => {
    expect(pinnedFilesOf('**Sizing** — one agent.\n', tracked)).toEqual([])
  })
})

describe('validateIssueContent — the pinned-file collision findings', () => {
  const A = 'packages/aeg-core/src/issue-validation.ts'
  const B = 'apps/cli/src/lib/forge-write.ts'
  const C = 'apps/cli/src/lib/config.ts'

  const peer = (ref: string, files: string[]): TaskFileFacts => ({
    ref,
    label: `task Issue #${ref}`,
    files,
    conflictsWith: []
  })

  const run = (subjectFiles: string[], peers: TaskFileFacts[], threshold: number, capHit = false) =>
    validateIssueContent({
      body: '**Dependency rationale** — no edges.\n',
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: 'vinaya issue create --validate-only …',
      issueNumber: 851,
      briefSectionsSinceIssue: null,
      resolvesToFile: () => true,
      readFile: () => null,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: '851',
      collisionPeers: { peers, capHit },
      subjectFiles,
      collisionThreshold: threshold,
      commandReference: DORMANT_COMMAND_REFERENCE,
      configReference: DORMANT_CONFIG_REFERENCE,
      pinnedFileImporters: [],
      existsInTree: () => false
    }).filter((e) => e.message.includes('file collision'))

  it('an at-threshold overlap is a blocking error naming the other task and the shared files', () => {
    const errors = run([A, B, C], [peer('860', [A, B, C])], 3)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.severity).toBe('error')
    expect(errors[0]?.message).toMatch(/task Issue #860/)
    expect(errors[0]?.agent_recovery_prompt).toMatch(/Conflicts-with/)
  })

  it('an under-threshold overlap is a warning, so the Issue is accepted', () => {
    const errors = run([A, B, C], [peer('860', [A, B])], 3)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.severity).toBe('warning')
    expect(errors[0]?.message).toContain(A)
    expect(errors[0]?.message).toContain(B)
  })

  it('a threshold of 0 leaves even a full overlap as a warning', () => {
    const errors = run([A, B, C], [peer('860', [A, B, C])], 0)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.severity).toBe('warning')
  })

  it('says in its own output when the open-pull-request read hit its cap', () => {
    const errors = run([A], [], 3, true)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.severity).toBe('warning')
    expect(errors[0]?.message).toMatch(/open pull requests were read/)
  })

  it('stays dormant — no collision finding at all — when peers could not be resolved', () => {
    const errors = validateIssueContent({
      body: '**Dependency rationale** — no edges.\n',
      labels: ['vinaya/tranche:demo'],
      sharedPackages: [],
      projectPaths: [],
      retryCommand: 'vinaya issue create --validate-only …',
      issueNumber: 851,
      briefSectionsSinceIssue: null,
      resolvesToFile: () => true,
      readFile: () => null,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: '851',
      collisionPeers: null,
      subjectFiles: [A, B, C],
      collisionThreshold: DEFAULT_COLLISION_THRESHOLD,
      commandReference: DORMANT_COMMAND_REFERENCE,
      configReference: DORMANT_CONFIG_REFERENCE,
      pinnedFileImporters: [],
      existsInTree: () => false
    }).filter((e) => e.message.includes('file collision'))
    expect(errors).toEqual([])
  })
})

describe('buildCollisionPeers — which peers each scope compares against', () => {
  const A = 'packages/aeg-core/src/issue-validation.ts'
  const B = 'apps/cli/src/lib/forge-write.ts'
  const tracked = [A, B]

  const issueBody = (pinned: string[], conflictsWith = '—') =>
    [
      `**Boundary** — In: the check. Pinned files: ${pinned.map((p) => `\`${p}\``).join(', ')}. Out: nothing.`,
      '',
      `**Dependency rationale** — \`Depends-on: —\`; \`Conflicts-with: ${conflictsWith}\`.`
    ].join('\n')

  const issue = (number: number, pinned: string[], conflictsWith = '—') => ({
    number,
    body: issueBody(pinned, conflictsWith),
    labels: [{ name: 'vinaya/tranche:demo' }]
  })

  const pull = (
    number: number,
    files: string[],
    closes: number[] = [],
    extra: { headRefName?: string; body?: string } = {}
  ) => ({
    number,
    files: files.map((path) => ({ path })),
    closingIssuesReferences: closes.map((n) => ({ number: n })),
    headRefName: extra.headRefName ?? `feature/pr-${number}`,
    body: extra.body ?? ''
  })

  it('compares against both open task Issues and open pull requests at issue create/edit', () => {
    const peers = buildCollisionPeers(
      'issues-and-pull-requests',
      851,
      [issue(860, [A])],
      [pull(862, [B], [861])],
      tracked
    )
    expect(peers.map((p) => p.label)).toEqual(['task Issue #860', 'pull request #862 (task Issue #861)'])
  })

  it('compares against open pull requests ONLY at dispatch, even when Issue rows are supplied', () => {
    const peers = buildCollisionPeers('pull-requests', 851, [issue(860, [A])], [pull(862, [B], [861])], tracked)
    expect(peers.map((p) => p.label)).toEqual(['pull request #862 (task Issue #861)'])
  })

  it('drops the pull request that closes the subject Issue — that is the subject’s own branch', () => {
    expect(buildCollisionPeers('pull-requests', 851, [], [pull(862, [A, B], [851])], tracked)).toEqual([])
  })

  it('drops the subject’s own pull request by its task branch when the forge returns no closing reference', () => {
    const ownPull = pull(862, [A, B], [], { headRefName: 'task/issue-851' })
    expect(buildCollisionPeers('pull-requests', 851, [], [ownPull], tracked)).toEqual([])
    // and the tranche branch shape resolves to the same trailing Issue number
    const tranchePull = pull(863, [A, B], [], { headRefName: 'task/role-reach/851' })
    expect(buildCollisionPeers('pull-requests', 851, [], [tranchePull], tracked)).toEqual([])
  })

  it('drops the subject’s own pull request by a `Closes #<n>` body line, case-insensitively, when the closing list is empty', () => {
    for (const keyword of ['Closes', 'fixes', 'RESOLVES']) {
      const ownPull = pull(862, [A, B], [], { body: `Some summary.\n\n${keyword} #851\n` })
      expect(buildCollisionPeers('pull-requests', 851, [], [ownPull], tracked)).toEqual([])
    }
  })

  it('still compares a pull request that names no task Issue — branch and body match neither the subject nor a substring of it', () => {
    // #8510 must not match subject 851 through either the branch or the body.
    const other = pull(862, [A], [], { headRefName: 'task/issue-8510', body: 'Closes #8510\n' })
    const peers = buildCollisionPeers('pull-requests', 851, [], [other], tracked)
    expect(peers).toEqual([{ ref: 'pull/862', label: 'pull request #862', files: [A], conflictsWith: [] }])
  })

  it('drops the subject’s own Issue row', () => {
    expect(buildCollisionPeers('issues-and-pull-requests', 851, [issue(851, [A, B])], [], tracked)).toEqual([])
  })

  it('fills a pull request’s Conflicts-with from the task Issue it closes, in either scope', () => {
    const issues = [issue(860, [A], '#851')]
    for (const scope of ['issues-and-pull-requests', 'pull-requests'] as const) {
      const peers = buildCollisionPeers(scope, 851, issues, [pull(862, [B], [860])], tracked)
      const pr = peers.find((p) => p.label.startsWith('pull request'))
      expect(pr?.conflictsWith).toEqual(['#851'])
      expect(pr?.ref).toBe('860')
    }
  })

  it('a pull request closing no Issue still becomes a peer, named by its own number', () => {
    const peers = buildCollisionPeers('pull-requests', 851, [], [pull(862, [A])], tracked)
    expect(peers).toEqual([{ ref: 'pull/862', label: 'pull request #862', files: [A], conflictsWith: [] }])
  })

  it('skips an Issue that pins no file and one that is not task-shaped at all', () => {
    const notATask = { number: 870, body: 'Plain bug report, no rationale.', labels: [] }
    const pinsNothing = issue(871, [])
    expect(buildCollisionPeers('issues-and-pull-requests', 851, [notATask, pinsNothing], [], tracked)).toEqual([])
  })
})
