import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { amendRationaleDeps, projectsFromBody } from '@attalabs/aeg-forge-state'
import { describe, expect, it } from 'vitest'
import { fenceShapes } from '../tests/fixtures/fence-shapes'
import {
  BRIEF_SECTIONS_SINCE_ISSUE,
  checkBlastRadiusScope,
  checkConflictCompleteness,
  checkIssueBriefSections,
  checkIssueObjectives,
  checkIssueRationale,
  checkDocsWithinSurface,
  checkIssueType,
  checkMilestoneAttach,
  checkNoBriefContent,
  checkPartsCiteDefinedObjectives,
  checkProjectsRegistered,
  checkRationaleNamesDocs,
  checkRationaleSurfaceCoverage,
  checkSurfaceExcludesBoundDoc,
  checkSurfaceGlobsResolve,
  checkSurfaceOverlap,
  checkSurfaceScope,
  checkTrancheLabelPresence,
  declaredProjects,
  frozenSectionsChanged,
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  OBJECTIVES_SINCE_ISSUE,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  type TaskIssueFacts,
  type TaskSurfaceFacts
} from './issue-validation'

// Issue #404's real live body, verbatim (`gh issue view 404 --json body`, dev-review-loop-v1
// task 1 authoring time) — the cutover's own first Issue, already carrying the section by hand.
const ISSUE_404_BODY = `vinaya-log-v1 1 — log() with the typed header, two families, and the outbox sink

**Tier:** 1
**Project:** aeg-core, cli, sources
**Type:** feat

## Objectives

O1. A call to \`log()\` with a valid \`dispatch\` or \`dev_review_loop\` line appends one ndjson line to \`~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson\` whose \`meta\` and \`subject\` fields are filled from the environment, the remote, the package and the tree, and an invalid payload is refused by the schema without writing.
O2. No file other than \`apps/cli/src/lib/log-sink.ts\` performs the append, and no file other than the two named chokepoints calls \`log()\`; a test proves both.
O3. \`apps/cli/specs/log.md\` exists, describes the header, the two families and the outbox, and is bound in \`.vinaya/doc-owners\` to the sink.

## Planner's rationale

**Boundary** — One function \`log(e: LogEvent)\` and the one place its lines land.
`

// Bold-inline style, as on Issue #309.
const BOLD_STYLE = `
**Tranche:** aeg-governance-hardening · **Task:** 5d · **Project(s):** aeg

## Planner's rationale

**Boundary** — What this task is and is not.

**Sizing** — Passes all four tests.

**Project(s) + blast radius** — aeg, aeg-core.

**Dependency rationale** — No depends-on.

**Traps to avoid** — Do not do X.

**Suggested agent-class** — high.

**Stop-and-escalate** — If Y happens, stop.

**Docs to keep coherent** — state-machine.md §12.
`

// Heading style, as on Issue #219.
const HEADING_STYLE = `
### Boundary

The flow derives the list.

### Sizing

Small-medium.

### Project(s) + blast radius

aeg only.

**Dependency rationale** — Depends on task 3.

### Traps

- The helper is an aid, not an enforcer.

### Stop-and-escalate

- Derivation needs undeclared intent.

### Suggested agent-class

Medium.

### Docs to keep coherent

planner.md.
`

describe('checkIssueRationale', () => {
  it('passes the bold-inline rationale style (#309 shape)', () => {
    expect(checkIssueRationale(BOLD_STYLE).status).toBe('pass')
  })

  it('passes the heading rationale style (#219 shape)', () => {
    expect(checkIssueRationale(HEADING_STYLE).status).toBe('pass')
  })

  it('fails an empty body with one error per missing field', () => {
    const r = checkIssueRationale('Just a title-ish body with no rationale.')
    expect(r.status).toBe('fail')
    expect(r.errors).toHaveLength(8)
  })

  it('fails only the missing field when one is dropped', () => {
    const body = BOLD_STYLE.replace('**Traps to avoid** — Do not do X.\n', '')
    const r = checkIssueRationale(body)
    expect(r.status).toBe('fail')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/Traps/)
  })

  it('does not accept a field name mentioned in plain prose (needs bold or heading form)', () => {
    const body = 'The boundary of this task is unclear and the sizing was never done.'
    expect(checkIssueRationale(body).status).toBe('fail')
  })
})

describe('checkIssueObjectives', () => {
  // #403-shaped: below OBJECTIVES_SINCE_ISSUE (404), no `## Objectives` section at all.
  const PRE_CUTOVER_BODY = BOLD_STYLE

  it('passes a body below the cutover with no `## Objectives` section (#403 shape)', () => {
    expect(OBJECTIVES_SINCE_ISSUE).toBe(404)
    expect(checkIssueObjectives(PRE_CUTOVER_BODY, 403).status).toBe('pass')
  })

  it('refuses a body AT the cutover with no `## Objectives` section, naming the section', () => {
    const r = checkIssueObjectives(PRE_CUTOVER_BODY, OBJECTIVES_SINCE_ISSUE)
    expect(r.status).toBe('fail')
    expect(r.errors.join(' ')).toMatch(/## Objectives/)
  })

  it('passes Issue #404’s real live body', () => {
    expect(checkIssueObjectives(ISSUE_404_BODY, 404).status).toBe('pass')
  })

  it('fail-closes on an unknown issue number (not exempted)', () => {
    const r = checkIssueObjectives(PRE_CUTOVER_BODY, null)
    expect(r.status).toBe('fail')
  })
})

describe('isTaskIssueLabelSet', () => {
  it('is true when a tranche label is present', () => {
    expect(isTaskIssueLabelSet(['vinaya/tranche:aeg-governance-hardening', 'vinaya/tier:3'])).toBe(true)
  })
  it('is false for non-tranche labels', () => {
    expect(isTaskIssueLabelSet(['bug', 'help wanted'])).toBe(false)
  })
  it('is false for no labels', () => {
    expect(isTaskIssueLabelSet([])).toBe(false)
  })
})

describe('isTaskIssueBodyShaped (O1)', () => {
  it('is true when the body carries a real `## Objectives` heading', () => {
    expect(isTaskIssueBodyShaped('## Objectives\n\nO1. Do the thing.\n')).toBe(true)
  })

  it('is true when the body carries any ONE of the eight Planner rationale fields, bold-inline', () => {
    expect(isTaskIssueBodyShaped('**Boundary** — the thing.\n')).toBe(true)
    expect(isTaskIssueBodyShaped('**Stop-and-escalate** — n/a.\n')).toBe(true)
  })

  it('is true on the heading-style rationale fields too (Issue #219 style)', () => {
    expect(isTaskIssueBodyShaped('### Boundary\n\nthe thing.\n')).toBe(true)
  })

  it('is true under a non-literal parent heading, as long as a real field is present — the live #issue-valid.md shape', () => {
    // `checkIssueRationale` never requires the literal heading "## Planner's
    // rationale" — only the eight fields underneath it — so a body titled
    // "## Task Issue — Planner rationale" (a real fixture shape) must still
    // read as task-shaped.
    const body = '## Task Issue — Planner rationale\n\n**Boundary** — Ship the thing.\n'
    expect(isTaskIssueBodyShaped(body)).toBe(true)
  })

  it('is false for an ordinary, non-task-shaped body', () => {
    expect(isTaskIssueBodyShaped('Fix a typo in the README.\n')).toBe(false)
  })

  it('is false when the only match appears inside a fenced code block', () => {
    const body = '```\n## Objectives\n\nO1. example inside a fence.\n\n**Boundary** — n/a.\n```\n'
    expect(isTaskIssueBodyShaped(body)).toBe(false)
  })
})

describe('checkIssueType', () => {
  const TASK_LABELS_NO_TYPE = ['vinaya/tranche:vinaya-verification-v1', 'vinaya/tier:1']
  const TASK_LABELS_ONE_TYPE = [...TASK_LABELS_NO_TYPE, 'vinaya/type:feat']
  const TASK_LABELS_TWO_TYPES = [...TASK_LABELS_ONE_TYPE, 'vinaya/type:fix']

  it('fails a task Issue carrying zero vinaya/type:* labels, naming the ten valid ids', () => {
    const r = checkIssueType('body', TASK_LABELS_NO_TYPE)
    expect(r.status).toBe('fail')
    expect(r.errors).toHaveLength(1)
    for (const t of ['build', 'chore', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test']) {
      expect(r.errors[0]).toContain(`vinaya/type:${t}`)
    }
  })

  it('fails a task Issue carrying two vinaya/type:* labels', () => {
    const r = checkIssueType('body', TASK_LABELS_TWO_TYPES)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/vinaya\/type:feat/)
    expect(r.errors[0]).toMatch(/vinaya\/type:fix/)
  })

  it('passes a task Issue carrying exactly one vinaya/type:* label', () => {
    expect(checkIssueType('body', TASK_LABELS_ONE_TYPE)).toEqual({ status: 'pass', errors: [] })
  })

  it('passes a non-task Issue (no tranche label) regardless of type labels', () => {
    expect(checkIssueType('body', [])).toEqual({ status: 'pass', errors: [] })
    expect(checkIssueType('body', ['bug', 'help wanted'])).toEqual({ status: 'pass', errors: [] })
  })
})

// ---------------------------------------------------------------------------
// Content checks (A/B/D block, C warns)
// ---------------------------------------------------------------------------

/** The real collision-domain shape; the live list is resolved by `open-issue.ts`'s `readSharedPackages`. */
const SHARED = ['packages/ui', 'packages/aeg-core', '.vinaya']

/** Registry rows as `parseRegistry` returns them — `vinaya` is an app, `aeg-core` IS a shared package. */
const REGISTRY = [
  { name: 'vinaya', path: 'apps/vinaya' },
  { name: 'aeg-core', path: 'packages/aeg-core' },
  { name: 'vada', path: 'apps/vada-ai' }
]

/**
 * A minimally-valid rationale, parameterised on the fields the content checks
 * read. It carries BOTH shapes every live Issue does: the `Project(s) + blast
 * radius` prose field (narrative, and where paths get named), and the
 * line-anchored project field at the foot (the declaration — the only thing
 * `projectsFromBody` reads, and therefore the only thing the gates read). See
 * `issue-863-body.md` / `issue-870-body.md` for the live shape this mirrors.
 */
function rationale(opts: {
  boundary: string
  docs?: string
  traps?: string
  extra?: string
  projects?: string
}): string {
  return `
## Planner's rationale

**Boundary** — ${opts.boundary}

**Sizing** — Passes the four.

**Project(s) + blast radius** — \`Project: ${opts.projects ?? 'vinaya'}\`.

**Dependency rationale** — Depends-on: —.

**Traps to avoid** — ${opts.traps ?? 'Read `.claude/skills/ui-library-system/SKILL.md` first.'}

**Suggested agent-class** — mid.

**Stop-and-escalate** — If X, stop.

**Docs to keep coherent** — ${opts.docs ?? 'Keep `apps/vinaya/web/CLAUDE.md` coherent.'}
${opts.extra ?? ''}

**Project:** ${opts.projects ?? 'vinaya'}
`
}

describe('declaredProjects', () => {
  it('reads every project the body field declares', () => {
    const body = rationale({ boundary: 'x', projects: 'vada, vinaya' })
    expect(declaredProjects(body, [])).toEqual(expect.arrayContaining(['vada', 'vinaya']))
  })

  it('ignores a residual project:* label — project is a field, never a label (#614)', () => {
    expect(declaredProjects(rationale({ boundary: 'x' }), ['project:vada', 'vinaya/tranche:x'])).toEqual(['vinaya'])
  })
})

/** The registry reduced to the name column — what `checkProjectsRegistered` consumes. */
const REGISTERED = REGISTRY.map((p) => p.name)

/**
 * Real task-Issue bodies, saved from the forge. Fixtures for this check must
 * come from the live corpus: a synthetic body can carry a `Project:` shape no
 * real Issue has, and the suite then passes over a gate that never fires.
 *
 * Verbatim with ONE exception: a third-party adopter repo's identifier in
 * `issue-870-body.md` is redacted. `packages/aeg-core` ships inside the published
 * `@attalabs/vinaya` tarball, so a real Issue body pasted in here travels further
 * than the forge. Nothing these tests assert touches the redacted span — check an
 * identifier before copying the next body in.
 */
const realBody = (n: number): string =>
  readFileSync(join(__dirname, '..', 'tests', 'fixtures', `issue-${n}-body.md`), 'utf8')

/**
 * The two control characters these tests smuggle through the gate, named rather
 * than embedded: a literal `ESC` in a source file is invisible in review and in
 * a diff, which is the whole reason it is worth defending against.
 */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

describe('checkProjectsRegistered', () => {
  it('#863 (modern `**Project:**` footer) — EVALUATES its names, and passes on their merit', () => {
    const body = realBody(863)
    // The load-bearing assertion: it found names. A pass with zero names found is
    // the vacuous pass that made the first version look green while inert.
    expect(projectsFromBody(body)).toEqual(['aeg-core', 'vinaya'])
    expect(checkProjectsRegistered(body, [], REGISTERED).status).toBe('pass')
  })

  it('#863 fails once one of its real declared names is not a registry row', () => {
    // Same real body, registry missing `vinaya` — proves the pass above is earned.
    const r = checkProjectsRegistered(realBody(863), [], ['aeg-core', 'vada'])
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/vinaya/)
    expect(r.errors[0]).toMatch(/\.vinaya\/projects\.md/)
  })

  it('#188 (legacy `**Project(s):**` colon style) — still fires', () => {
    const body = realBody(188)
    expect(projectsFromBody(body)).toEqual(['vada', 'engine', 'adapter'])
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/engine/)
    expect(r.errors[0]).toMatch(/adapter/)
  })

  it('#870 (prose field full of file paths) — invents no project named `src`', () => {
    // Its `**Project(s) + blast radius**` line names `packages/aeg-core/src/…`.
    // The prose-field read turned that into `src, bin, verify-briefts, …` and
    // refused a correctly-declared Issue; the line-anchored field read cannot.
    const body = realBody(870)
    expect(body).toContain('packages/aeg-core/src/brief-validation.ts')
    expect(projectsFromBody(body)).toEqual(['vinaya'])
    expect(checkProjectsRegistered(body, [], REGISTERED).status).toBe('pass')
  })

  it('reads the same field the derivation does — gate and `projectsFromBody` cannot disagree', () => {
    // The reviewer's reproduction: an unregistered project declared on the footer
    // line, invisible to the prose-field read, and resolved by the derivation.
    const body = [
      '**Project(s) + blast radius** — `aeg-types` owns the edited path.',
      '',
      '**Tier:** 1',
      '**Project:** aeg-types'
    ].join('\n')
    expect(projectsFromBody(body)).toEqual(['aeg-types'])
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/aeg-types/)
  })

  it('names every unregistered project, not just the first', () => {
    const body = '**Project:** aeg-types, vda'
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/aeg-types/)
    expect(r.errors[0]).toMatch(/vda/)
  })

  it('matches exactly — a case variant is refused, because downstream comparison is literal', () => {
    const r = checkProjectsRegistered('**Project:** Vinaya', [], REGISTERED)
    expect(r.status).toBe('fail')
    // …and says why, naming the row it differs from only in case.
    expect(r.errors[0]).toMatch(/differs from the registered `vinaya` only in case/)
  })

  it('is dormant when the registry is absent — a gate with no source of truth invents none', () => {
    expect(checkProjectsRegistered('**Project:** aeg-types', [], []).status).toBe('pass')
  })

  it('passes a body with no `**Project:**` line — field presence is checkIssueRationale’s job', () => {
    const body = 'A body with no rationale and no Project field at all.'
    expect(projectsFromBody(body)).toEqual([])
    expect(checkProjectsRegistered(body, [], REGISTERED).status).toBe('pass')
  })

  // -------------------------------------------------------------------------
  // The silent-drop fail-open: a DECLARED value the parser could not turn into
  // a name used to be indistinguishable from no declaration at all, so the gate
  // passed vacuously on the one body it most needed to refuse.
  // -------------------------------------------------------------------------

  it('fails a declaration whose value yields no name — it can no longer pass vacuously', () => {
    // #554's exact shape: prose in the field. `projectsFromBody` still yields
    // nothing, which used to read to this gate as "no project declared".
    const body = '**Project:** (none — tools/admin is unregistered; see Project(s) + blast radius above)'
    expect(projectsFromBody(body)).toEqual([])
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/resolves to no project name/)
    // …and names the residue, so the author can see what was read.
    expect(r.errors[0]).toMatch(/tools\/admin is unregistered/)
  })

  it('fails closed when an unterminated fence swallowed the field, and says so', () => {
    // Regression pin for the fail-open the fence fix itself introduced: the
    // stray fence blanked the foot declaration, the parser reported "absent",
    // and this gate passed a body its pre-fix self refused.
    const body = ['```', 'a stray unclosed fence', '', '**Project:** notaproject'].join('\n')
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/unterminated code fence|fences do not balance/i)
  })

  it('fails closed on an unreadable body even when the swallowed name IS registered', () => {
    // The read cannot be trusted, so the answer cannot be "pass" — but the
    // message must point at the malformed fence, not accuse a valid name.
    const body = ['````', 'x', '```', '', '**Project:** vinaya'].join('\n')
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/unterminated code fence|fences do not balance/i)
    expect(r.errors[0]).not.toMatch(/is not a project name/)
  })

  it('fails a declaration with an empty value — the same vacuous pass, one shape further', () => {
    // `**Project:**` with nothing after it yields no name AND no residue to
    // report. Keying the failure on "declared but resolved to nothing" rather
    // than on the residue is what catches this shape too.
    const r = checkProjectsRegistered('**Project:**   \n', [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/resolves to no project name/)
  })

  it('fails on the unparseable half of a partly-parseable declaration', () => {
    const body = '**Project:** vinaya, a value with spaces'
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/a value with spaces/)
  })

  it('refuses an unregistered name that only trailing punctuation used to hide', () => {
    // `notaproject.` failed the slug shape and was dropped before the registry
    // could refuse it — the gate cannot fail on a name it never receives.
    const r = checkProjectsRegistered('**Project:** notaproject.', [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/notaproject/)
  })

  it('reads the foot declaration, not a fenced example, so the gate and the board agree', () => {
    const body = ['```markdown', '**Project:** not-a-real-project', '```', '', '**Project:** vinaya'].join('\n')
    expect(projectsFromBody(body)).toEqual(['vinaya'])
    expect(checkProjectsRegistered(body, [], REGISTERED).status).toBe('pass')
  })

  // -------------------------------------------------------------------------
  // Error-message sanitation. `parseRegistry` validates nothing, so a guest
  // repo's `.vinaya/projects.md` reaches this message as raw markdown-cell text.
  // -------------------------------------------------------------------------

  it('does not render a registry name’s terminal escapes into the error message', () => {
    const hostile = ['vinaya', `${ESC}[31mred${ESC}[0m`, `drop${BEL}bell`]
    const r = checkProjectsRegistered('**Project:** nosuchproject', [], hostile)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).not.toContain(ESC)
    expect(r.errors[0]).not.toContain(BEL)
  })

  it('does not render a declared value’s terminal escapes into the error message', () => {
    const r = checkProjectsRegistered(`**Project:** ${ESC}[31mnotaname${ESC}[0m here`, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).not.toContain(ESC)
  })

  it('still names a well-formed registry row verbatim — sanitation is not redaction', () => {
    const r = checkProjectsRegistered('**Project:** nosuchproject', [], REGISTERED)
    expect(r.errors[0]).toMatch(/aeg-core/)
    expect(r.errors[0]).toMatch(/nosuchproject/)
  })
})

describe('checkBlastRadiusScope (A)', () => {
  it('fails a single-project task whose Boundary edits a shared package it does not own', () => {
    const body = rationale({ boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).' })
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/ui/)
  })

  it('passes once a second project is declared — the review fan-out actually widens', () => {
    const body = rationale({
      boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).',
      projects: 'vinaya, vada'
    })
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('passes on an explicit blast-radius-ack: line', () => {
    const body = rationale({
      boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).',
      extra: '\n**blast-radius-ack:** every consumer keeps the existing fallback path.\n'
    })
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('passes a single-project task editing the package that IS its own project (no under-declaration)', () => {
    const body = rationale({
      boundary: 'Add a check to `packages/aeg-core/src/issue-validation.ts`.',
      projects: 'aeg-core'
    })
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('does not count a cited document as a touched domain', () => {
    const body = rationale({ boundary: 'Resolve the registry row in `.vinaya/projects.md`.' })
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('does not count a shared path named outside Boundary / blast radius (an import, a trap)', () => {
    const body = rationale({
      boundary: 'Add a CLI flag in `apps/vinaya/cli`.',
      traps: 'The CLI imports `packages/aeg-core` unchanged — do not edit it.'
    })
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('is dormant when no collision-domain list is available', () => {
    const body = rationale({ boundary: 'Restyle `packages/ui/topbar/index.tsx`.' })
    expect(checkBlastRadiusScope(body, [], [], REGISTRY).status).toBe('pass')
  })

  // -------------------------------------------------------------------------
  // The parse and the count (#864), proven on live bodies. A synthetic body can
  // carry a project shape no real Issue has, and the suite then passes over a
  // gate that never fires — which is how both defects below survived a green
  // suite. Every fixture here is a body that shipped on the forge.
  // -------------------------------------------------------------------------

  it('#870 — the prose read invented five projects and bought the bypass; the field read does not', () => {
    const body = realBody(870)
    // What the body-wide read saw: path fragments off its own blast-radius line,
    // parsed as project names. Five of the six are fiction, and the count alone
    // cleared the `> 1` bypass, so this check never ran on the Issue at all.
    const invented = declaredProjects(body, [])
    expect(invented).toContain('src')
    expect(invented.length).toBeGreaterThan(1)
    // The line-anchored field, read through the one shared parser: one project.
    expect(projectsFromBody(body)).toEqual(['vinaya'])
    // And with the real declaration visible, the real reach is refused: a task
    // on `vinaya` (apps/vinaya) editing `packages/aeg-core`, no ack line.
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/aeg-core/)
    expect(r.errors[0]).toMatch(/\(vinaya\)/)
  })

  it('#863 — passes on ownership, not on the six names its prose used to yield', () => {
    const body = realBody(863)
    expect(declaredProjects(body, [])).toContain('src')
    expect(projectsFromBody(body)).toEqual(['aeg-core', 'vinaya'])
    // `aeg-core` owns `packages/aeg-core`, so the reach is declared exactly —
    // this pass never depended on the bypass, and still does not.
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('#863 with `aeg-core` unregistered — an unregistered name no longer buys the bypass', () => {
    // Same real body, registry as the only variable: two declared names, one of
    // which resolves to no row. Raw-token counting made that `> 1` and passed;
    // one registry-validated name is one review lens, so it must not.
    const r = checkBlastRadiusScope(realBody(863), [], SHARED, [{ name: 'vinaya', path: 'apps/vinaya' }])
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/aeg-core/)
    expect(r.errors[0]).toMatch(/Not counted: aeg-core/)
  })

  it('a genuine multi-project declaration still gets the bypass — both names are rows', () => {
    const body = rationale({
      boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).',
      projects: 'vinaya, vada'
    })
    expect(projectsFromBody(body)).toEqual(['vinaya', 'vada'])
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })

  it('the same body fails once the second name is fiction — one real lens is one lens', () => {
    const body = rationale({
      boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).',
      projects: 'vinaya, aeg-types'
    })
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/Not counted: aeg-types/)
  })
})

describe('checkNoBriefContent (B)', () => {
  it('fails a body carrying a brief-shaped References section', () => {
    const body = `${rationale({ boundary: 'x' })}\n## References\n\nSkills to read first: …\n`
    const r = checkNoBriefContent(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/References/)
  })

  it.each(['Technical surface map', 'Step 0'])('fails on a brief-shaped "%s" heading', (heading) => {
    expect(checkNoBriefContent(`${rationale({ boundary: 'x' })}\n## ${heading}\n\nstuff\n`).status).toBe('fail')
  })

  it('fails on a bold Premise field', () => {
    expect(checkNoBriefContent(`${rationale({ boundary: 'x' })}\n**Premise:** the file contains X\n`).status).toBe(
      'fail'
    )
  })

  it('passes a clean rationale-only body', () => {
    expect(checkNoBriefContent(rationale({ boundary: 'x' })).status).toBe('pass')
  })

  // plan-brief-v1 task 1, Issue #426: `## Surface`/`## Parts`/`## Test plan`/
  // `## Stop conditions` are Issue-native sections since `BRIEF_SECTIONS_SINCE_ISSUE`
  // — a heading is not a brief-content marker for these four any more.
  it.each(['Surface', 'Parts', 'Test plan', 'Stop conditions'])(
    'a "## %s" heading alone is NOT a brief-content marker (Issue-native since #426)',
    (heading) => {
      expect(checkNoBriefContent(`${rationale({ boundary: 'x' })}\n## ${heading}\n\nstuff\n`).status).toBe('pass')
    }
  )

  it('still fails on a bold **Test Plan:** brief-content marker', () => {
    expect(checkNoBriefContent(`${rationale({ boundary: 'x' })}\n**Test Plan:** unit-tests-only\n`).status).toBe('fail')
  })
})

describe('checkRationaleNamesDocs (D)', () => {
  it('fails when neither Docs nor Traps names a concrete doc path', () => {
    const body = rationale({
      boundary: 'Fix the tab layout in `apps/vinaya/web`.',
      docs: 'No docs touched.',
      traps: 'Do not weaken the assertions.'
    })
    const r = checkRationaleNamesDocs(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/no-doc-surface/)
  })

  it('passes when Docs names a concrete doc path', () => {
    const body = rationale({
      boundary: 'Fix the tab layout in `apps/vinaya/web`.',
      docs: 'Keep `apps/vinaya/web/CLAUDE.md` coherent.',
      traps: 'Do not weaken the assertions.'
    })
    expect(checkRationaleNamesDocs(body).status).toBe('pass')
  })

  it('passes when only Traps names one — the read artifact can live in either field', () => {
    const body = rationale({
      boundary: 'x',
      docs: 'None expected.',
      traps: 'Read `.claude/rules/ui-patterns.md` RULE 2 first.'
    })
    expect(checkRationaleNamesDocs(body).status).toBe('pass')
  })

  it('passes a genuinely doc-less surface via the explicit sentinel', () => {
    const body = rationale({
      boundary: 'x',
      docs: 'no-doc-surface — pure internal refactor, nothing documents it.',
      traps: 'Do not weaken the assertions.'
    })
    expect(checkRationaleNamesDocs(body).status).toBe('pass')
  })

  // Regression: under the `m` flag the field slicer's `$` terminator matched
  // end-of-LINE, so a heading-style field sliced to its own label with no
  // content and D failed Issues that name their docs on the next line.
  it('reads a heading-style rationale, not just the bold-inline one (#219 shape)', () => {
    const body = HEADING_STYLE.replace('planner.md.', '`aeg-root/roles/planner.md` — the §7 derivation rule.')
    expect(checkRationaleNamesDocs(body).status).toBe('pass')
  })

  it('still fails a heading-style rationale whose Docs field names no path', () => {
    expect(checkRationaleNamesDocs(HEADING_STYLE).status).toBe('fail')
  })

  it('fails when neither Docs nor Traps field exists in the body at all (not merely empty)', () => {
    const body = `
## Planner's rationale

**Boundary** — Fix the tab layout in \`apps/vinaya/web\`.

**Project(s) + blast radius** — \`Project: vinaya\`.

**Project:** vinaya
`
    const r = checkRationaleNamesDocs(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/no-doc-surface/)
  })
})

describe('checkConflictCompleteness (C, warn-only)', () => {
  const mk = (ref: string, path: string, conflictsWith: string[] = []): TaskIssueFacts => ({
    ref,
    body: rationale({ boundary: `Edit \`${path}\`.` }),
    conflictsWith
  })

  it('warns when two open task Issues name the same domain with no mutual edge', () => {
    const w = checkConflictCompleteness(
      mk('#621', 'packages/ui/topbar/index.tsx'),
      [mk('#626', 'packages/ui/lib/color-scheme-toggle.tsx')],
      SHARED
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/#626/)
    expect(w[0]).toMatch(/packages\/ui/)
  })

  it('is silent once either side declares the edge', () => {
    expect(
      checkConflictCompleteness(
        mk('#621', 'packages/ui/topbar/index.tsx', ['#626']),
        [mk('#626', 'packages/ui/lib/color-scheme-toggle.tsx')],
        SHARED
      )
    ).toEqual([])
  })

  it('is silent for disjoint domains', () => {
    expect(
      checkConflictCompleteness(
        mk('#621', 'packages/ui/topbar/index.tsx'),
        [mk('#630', 'packages/aeg-core/src/x.ts')],
        SHARED
      )
    ).toEqual([])
  })
})

describe('checkSurfaceOverlap (task-run-v1 11, O5)', () => {
  const mk = (ref: string, surfaceIn: string[], conflictsWith: string[] = []): TaskSurfaceFacts => ({
    ref,
    surfaceIn,
    conflictsWith
  })

  it('refuses, naming both overlapping globs and the other task, when two tasks overlap with no Conflicts-with edge', () => {
    const subject = mk('42', ['packages/aeg-core/src/**'])
    const r = checkSurfaceOverlap(subject, [mk('43', ['packages/aeg-core/src/issue-validation.ts'])])
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/aeg-core\/src\/\*\*/)
    expect(r.errors[0]).toMatch(/packages\/aeg-core\/src\/issue-validation\.ts/)
    expect(r.errors[0]).toMatch(/43/)
  })

  it('passes when both tasks name each other in Conflicts-with', () => {
    const subject = mk('42', ['packages/aeg-core/src/**'], ['43'])
    const sibling = mk('43', ['packages/aeg-core/src/issue-validation.ts'], ['42'])
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  it('passes when only ONE side declares the edge — same one-sided-is-enough rule `checkConflictCompleteness` already applies', () => {
    const subject = mk('42', ['packages/aeg-core/src/**'], ['43'])
    const sibling = mk('43', ['packages/aeg-core/src/issue-validation.ts']) // does not name 42 back
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  it('passes when the Surface globs simply do not overlap', () => {
    const subject = mk('42', ['apps/cli/src/lib/**'])
    const sibling = mk('43', ['packages/aeg-core/src/**'])
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  it('never compares a task against itself, even if `siblings` includes it', () => {
    const subject = mk('42', ['packages/aeg-core/src/**'])
    expect(checkSurfaceOverlap(subject, [subject]).status).toBe('pass')
  })

  it('reports one finding per overlapping glob pair, not only the first', () => {
    const subject = mk('42', ['packages/aeg-core/src/a/**', 'packages/aeg-core/src/b/**'])
    const sibling = mk('43', ['packages/aeg-core/src/a/x.ts', 'packages/aeg-core/src/b/y.ts'])
    const r = checkSurfaceOverlap(subject, [sibling])
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(2)
  })

  it('a `#`-prefixed ref in Conflicts-with still counts as the same task', () => {
    const subject = mk('42', ['packages/aeg-core/src/**'], ['#43'])
    const sibling = mk('43', ['packages/aeg-core/src/issue-validation.ts'], ['#42'])
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  // task 17, O4 — shared-by-construction exemptions.
  it('passes an overlap under a shared `tests` directory — no Conflicts-with edge needed', () => {
    const subject = mk('42', ['apps/cli/tests/**'])
    const sibling = mk('43', ['apps/cli/tests/checks/**'])
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  it('passes an overlap under a shared `specs` directory', () => {
    const subject = mk('42', ['packages/aeg-core/specs/**'])
    const sibling = mk('43', ['packages/aeg-core/specs/foo.md'])
    expect(checkSurfaceOverlap(subject, [sibling]).status).toBe('pass')
  })

  it('a directory merely named "testsuite" is NOT exempt — segment equality, never a substring test', () => {
    const subject = mk('42', ['apps/testsuite/**'])
    const sibling = mk('43', ['apps/testsuite/foo.ts'])
    const r = checkSurfaceOverlap(subject, [sibling])
    expect(r.status).toBe('fail')
  })

  it('a glob outside tests/specs on the SAME task still overlaps a real one — the exemption is per-glob, not per-task', () => {
    const subject = mk('42', ['apps/cli/tests/**', 'apps/cli/src/lib/**'])
    const sibling = mk('43', ['apps/cli/tests/**', 'apps/cli/src/lib/thing.ts'])
    const r = checkSurfaceOverlap(subject, [sibling])
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toMatch(/apps\/cli\/src\/lib/)
  })

  it('passes a glob every open task in the Milestone declares in common, outside tests/specs', () => {
    const subject = mk('42', ['aeg-root/roles/**'])
    const sibling1 = mk('43', ['aeg-root/roles/**'])
    const sibling2 = mk('44', ['aeg-root/roles/**'])
    expect(checkSurfaceOverlap(subject, [sibling1, sibling2]).status).toBe('pass')
  })

  it('does NOT exempt a glob the subject shares with only SOME siblings, not the whole cohort', () => {
    const subject = mk('42', ['aeg-root/roles/**'])
    const sibling1 = mk('43', ['aeg-root/roles/**'])
    const sibling2 = mk('44', ['unrelated/**']) // does not declare aeg-root/roles at all
    const r = checkSurfaceOverlap(subject, [sibling1, sibling2])
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toMatch(/43/)
  })
})

describe('frozenSectionsChanged (task-run-v1 11, review round 1, O3)', () => {
  const surface = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/src/commands\n'
  const parts = '## Parts\n\nPart 1 (O1) — the thing.\n'
  const objectives = '## Objectives\n\nO1. Do the thing.\n'
  const body = `${objectives}\n${surface}\n${parts}`

  it('reports nothing when nothing changed', () => {
    expect(frozenSectionsChanged(body, body)).toEqual([])
  })

  it('reports `Objectives` when the objectives text changes', () => {
    const changed = body.replace('O1. Do the thing.', 'O1. Do a different thing.')
    expect(frozenSectionsChanged(body, changed)).toEqual(['Objectives'])
  })

  it('does not report `Objectives` for a reflow that leaves the normalized text identical', () => {
    const reflowed = body.replace('O1. Do the thing.', 'O1.   Do   the   thing.')
    expect(frozenSectionsChanged(body, reflowed)).toEqual([])
  })

  it('reports `Surface` when an `in:`/`out:` glob changes', () => {
    const changed = body.replace('in: apps/cli/src/lib', 'in: apps/cli/src/lib, packages/aeg-core/src')
    expect(frozenSectionsChanged(body, changed)).toEqual(['Surface'])
  })

  it('does not report `Surface` for a reordering of the same glob set', () => {
    const multiGlob = body.replace(
      'in: apps/cli/src/lib\nout: apps/cli/src/commands',
      'in: apps/cli/src/lib, packages/aeg-core/src\nout: apps/cli/src/commands, apps/cli/src/checks'
    )
    const reordered = multiGlob.replace(
      'in: apps/cli/src/lib, packages/aeg-core/src\nout: apps/cli/src/commands, apps/cli/src/checks',
      'in: packages/aeg-core/src, apps/cli/src/lib\nout: apps/cli/src/checks, apps/cli/src/commands'
    )
    expect(frozenSectionsChanged(multiGlob, reordered)).toEqual([])
  })

  it('reports `Parts` when a Part outcome changes', () => {
    const changed = body.replace('Part 1 (O1) — the thing.', 'Part 1 (O1) — a different thing.')
    expect(frozenSectionsChanged(body, changed)).toEqual(['Parts'])
  })

  it('reports every changed section in one pass, not only the first', () => {
    const changed = body
      .replace('O1. Do the thing.', 'O1. Do a different thing.')
      .replace('Part 1 (O1) — the thing.', 'Part 1 (O1) — a different thing.')
    expect(frozenSectionsChanged(body, changed)).toEqual(['Objectives', 'Parts'])
  })

  it('reports a section as changed when it stops parsing on one side', () => {
    const brokenSurface = body.replace('## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/src/commands\n', '')
    expect(frozenSectionsChanged(body, brokenSurface)).toEqual(['Surface'])
  })

  it('reports nothing for a section malformed identically on both sides', () => {
    const noSurface = body.replace('## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/src/commands\n', '')
    expect(frozenSectionsChanged(noSurface, noSurface)).toEqual([])
  })
})

describe('code-blindness — every content check reuses the single stripCode (PR #617)', () => {
  it.each(fenceShapes())('does not trip A or B on quoted content inside a $name fence', (shape) => {
    const quoted = [
      shape.open,
      '## References',
      '**Premise:** packages/ui/topbar/index.tsx contains: TopBar',
      'Restyle packages/ui/topbar/index.tsx',
      shape.close
    ].join(shape.eol)
    const body = `${rationale({ boundary: 'Add a CLI flag in `apps/vinaya/cli`.' })}\n${quoted}\n`
    expect(checkNoBriefContent(body).status).toBe('pass')
    expect(checkBlastRadiusScope(body, [], SHARED, REGISTRY).status).toBe('pass')
  })
})

// ---------------------------------------------------------------------------
// One rationale grammar (task 738): an Issue body the creation gate accepts
// must always be rewritable by `amend-deps`. `checkIssueRationale` and
// `amendRationaleDeps` are two independent consumers of the same
// `Dependency rationale` field; this suite feeds a shared set of bodies
// through BOTH and asserts they agree, rather than trusting two
// independently-passing unit tests that never run against each other's
// fixtures (Issue #736, found live 2026-08-05).
// ---------------------------------------------------------------------------

/** A complete, otherwise-canonical rationale body with only the `Dependency
 * rationale` field's form varied — isolates disagreement to that one field. */
function rationaleWithDependencyForm(dependencyField: string): string {
  return `
**Boundary** — What this task is and is not.

**Sizing** — Passes all four tests.

**Project(s) + blast radius** — aeg, aeg-core.

${dependencyField}

**Traps to avoid** — Do not do X.

**Suggested agent-class** — high.

**Stop-and-escalate** — If Y happens, stop.

**Docs to keep coherent** — state-machine.md §12.
`
}

/** Whether `amendRationaleDeps` can locate the section at all — the same
 * question `checkIssueRationale`'s new check answers for the creation gate. */
function amendDepsAcceptsSectionLocation(body: string): boolean {
  try {
    amendRationaleDeps(body, { dependsOn: ['1'], note: 'round-trip probe', date: '2026-01-01' })
    return true
  } catch {
    return false
  }
}

/** Whether `checkIssueRationale` accepts this body on the `Dependency
 * rationale` field specifically (ignores errors on the other seven fields,
 * which `rationaleWithDependencyForm` always satisfies). */
function checkIssueRationaleAcceptsDependencyField(body: string): boolean {
  return !checkIssueRationale(body).errors.some((e) => e.startsWith('issue-validation Dependency rationale'))
}

const DEPENDENCY_FORM_FIXTURES: Array<{ name: string; field: string; accepted: boolean }> = [
  {
    name: 'canonical bold form (Issue #309 shape)',
    field: '**Dependency rationale** — No depends-on.',
    accepted: true
  },
  {
    name: 'colon-inside-bold form (Issue #736 shape, found live 2026-08-05)',
    field: '**Dependency rationale:** No depends-on.',
    accepted: false
  },
  {
    name: 'heading form (Issue #219 shape) — amend-deps has no heading grammar for this field',
    field: '### Dependency rationale\n\nNo depends-on.',
    accepted: false
  }
]

describe('checkIssueRationale / amendRationaleDeps — round-trip agreement (task 738)', () => {
  it.each(DEPENDENCY_FORM_FIXTURES)('$name: both consumers agree (accepted=$accepted)', ({ field, accepted }) => {
    const body = rationaleWithDependencyForm(field)
    expect(checkIssueRationaleAcceptsDependencyField(body)).toBe(accepted)
    expect(amendDepsAcceptsSectionLocation(body)).toBe(accepted)
  })

  it('rejects the exact colon-form body from Issue #736 (real, captured 2026-08-05) with an actionable error', () => {
    const body = readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'issue-736-body.md'), 'utf8')
    const result = checkIssueRationale(body)
    expect(result.status).toBe('fail')
    const depError = result.errors.find((e) => e.startsWith('issue-validation Dependency rationale'))
    expect(depError).toBeDefined()
    expect(depError).toMatch(/\*\*Dependency rationale\*\* — …/)
    expect(depError).toMatch(/\*\*Dependency rationale:\*\* …/)
    // And the same body is, independently, unamendable — the defect this task closes.
    expect(amendDepsAcceptsSectionLocation(body)).toBe(false)
  })

  it('still passes the canonical form on both consumers — no regression on the accepted shape', () => {
    const body = rationaleWithDependencyForm('**Dependency rationale** — Depends-on: 1.')
    expect(checkIssueRationale(body).status).toBe('pass')
    expect(amendDepsAcceptsSectionLocation(body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// `hasRationaleField` regex-grouping regression (found live 2026-08-07 while
// unblocking PR #754): `labelPattern`'s own top-level `|` (e.g. `Dependency
// rationale|Depends[- ]on`) must not split the surrounding
// `(?:\*\*|^#{1,4}\s+)\s*` alternation. Ungrouped, `Depends[- ]on` becomes a
// bare, unanchored alternative that matches ANY "Depends on"/"Depends-on"
// text anywhere in the body — including plain prose with no bold/heading
// marker nearby — and a body that never had this field at all gets
// misreported as "field found, but malformed" instead of "field missing".
// ---------------------------------------------------------------------------

describe('hasRationaleField — label-pattern grouping (regression, found live 2026-08-07)', () => {
  it('a body with a bare "Depends on" in ordinary prose, and no bold/heading Dependency-rationale field, reports the field MISSING', () => {
    const body = `
**Boundary** — Depends on the reader having already read the design doc.

**Sizing** — One PR.

**Project(s) + blast radius** — aeg, aeg-core.

**Traps to avoid** — Do not do X.

**Suggested agent-class** — high.

**Stop-and-escalate** — If Y happens, stop.

**Docs to keep coherent** — state-machine.md §12.
`
    const result = checkIssueRationale(body)
    expect(result.status).toBe('fail')
    const depError = result.errors.find((e) => e.startsWith('issue-validation Dependency rationale'))
    expect(depError).toBeDefined()
    // Missing (no prefix match) — not the "found but wrong form" message task 738 added.
    expect(depError).toMatch(/rationale field not found/)
    expect(depError).not.toMatch(/rationale field found, but not in the form/)
  })

  it('a real-shaped Issue with only inline "Depends-on: #N" prose in an unrelated section (Issue #240/#241 shape) reports the field MISSING, not malformed', () => {
    const body = `
**Boundary** — Depends on: **#186 (T11)** — the benchmark data answers the signal question.

**Sizing** — One PR.

**Project(s) + blast radius** — vada only.

**Traps to avoid** — Do not do X.

**Suggested agent-class** — high.

**Stop-and-escalate** — If Y happens, stop.

**Docs to keep coherent** — some-doc.md.
`
    const result = checkIssueRationale(body)
    const depError = result.errors.find((e) => e.startsWith('issue-validation Dependency rationale'))
    expect(depError).toBeDefined()
    expect(depError).toMatch(/rationale field not found/)
  })
})

/**
 * Trojan-Source class characters. Named, never embedded: a literal bidi
 * override in a source file is invisible in review, which is the entire reason
 * it is worth stripping out of an operator-facing message.
 */
const RLO = String.fromCharCode(0x202e) // right-to-left override
const ZWSP = String.fromCharCode(0x200b) // zero-width space
const BOM = String.fromCharCode(0xfeff)

describe('checkProjectsRegistered — what reaches the operator’s terminal', () => {
  it('drops bidi overrides from a registry name', () => {
    const hostile = ['vinaya', `aeg${RLO}erroc-gea`]
    const r = checkProjectsRegistered('**Project:** nosuchproject', [], hostile)
    expect(r.errors[0]).not.toContain(RLO)
  })

  it('drops zero-width characters that could split a name into a lookalike', () => {
    const r = checkProjectsRegistered('**Project:** nosuchproject', [], [`vin${ZWSP}aya`, 'aeg-core'])
    expect(r.errors[0]).not.toContain(ZWSP)
  })

  it('drops a byte-order mark from a declared value', () => {
    const r = checkProjectsRegistered(`**Project:** not a name${BOM} here`, [], REGISTERED)
    expect(r.errors[0]).not.toContain(BOM)
  })

  it('bounds the residue count, so one body cannot amplify into a huge error string', () => {
    // 500 unparseable values. Uncapped this renders every one of them into a
    // single error string that lands in `CheckFailure.reason` and in a blocking
    // gate's `--json` output.
    const body = `**Project:** ${Array.from({ length: 500 }, (_, i) => `not a name ${i}`).join(', ')}`
    const r = checkProjectsRegistered(body, [], REGISTERED)
    expect(r.status).toBe('fail')
    expect((r.errors[0] ?? '').length).toBeLessThan(2000)
    expect(r.errors[0]).toMatch(/more/)
  })

  it('never emits a lone surrogate when eliding a long value', () => {
    // An astral character straddling the elision boundary splits into a lone
    // surrogate under a UTF-16 slice.
    // 61 single-unit characters put the 64th code UNIT inside the first astral
    // character, so a `slice(0, 64)` cuts it in half.
    const astral = '\u{1F600}'
    const body = `**Project:** ${'a'.repeat(61)}${astral.repeat(10)}`
    const r = checkProjectsRegistered(body, [], REGISTERED)
    // Scan CODE UNITS: every high surrogate must be followed by a low one.
    // (Iterating the string with `for...of` walks code points and would never
    // see the split, which is exactly why a UTF-16 slice can hide this.)
    const msg = r.errors[0] ?? ''
    let lone = 0
    for (let i = 0; i < msg.length; i++) {
      const code = msg.charCodeAt(i)
      const isHigh = code >= 0xd800 && code <= 0xdbff
      const isLow = code >= 0xdc00 && code <= 0xdfff
      if (isHigh) {
        const next = msg.charCodeAt(i + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) lone++
        else i++
      } else if (isLow) {
        lone++
      }
    }
    expect(lone).toBe(0)
  })

  it('still renders a well-formed registry row verbatim — sanitation is not redaction', () => {
    const r = checkProjectsRegistered('**Project:** nosuchproject', [], REGISTERED)
    expect(r.errors[0]).toMatch(/aeg-core/)
    expect(r.errors[0]).toMatch(/nosuchproject/)
  })
})

// ---------------------------------------------------------------------------
// plan-brief-v1 task 1, Issue #426 — the four judgment-sections-as-data
// parsers, and the gate that composes them.
// ---------------------------------------------------------------------------

const ISSUE_426_BODY = readFileSync(join(import.meta.dirname, '../tests/fixtures/issue-426-body.md'), 'utf8')

describe('parseIssueSurface', () => {
  it('parses a well-formed in:/out: pair', () => {
    const body = '## Surface\n\nin: packages/aeg-core/src, apps/cli/src\nout: apps/cli/src/commands\n'
    const r = parseIssueSurface(body)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.in).toEqual(['packages/aeg-core/src', 'apps/cli/src'])
    expect(r.value.out).toEqual(['apps/cli/src/commands'])
  })

  it('refuses when the `## Surface` heading is absent', () => {
    const r = parseIssueSurface('nothing surface-shaped here')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/no `## Surface` heading/)
  })

  it('refuses when `in:` is missing', () => {
    const r = parseIssueSurface('## Surface\n\nout: packages/ui\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join(' ')).toMatch(/no `in:` line/)
  })

  it('refuses a file path in `in:` — Surface entries are directory-level globs', () => {
    const r = parseIssueSurface('## Surface\n\nin: packages/aeg-core/src/issue-validation.ts\nout: —\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/looks like a file path/)
  })

  it('refuses a file path in `out:` too', () => {
    const r = parseIssueSurface('## Surface\n\nin: packages/aeg-core/src\nout: apps/cli/README.md\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/looks like a file path/)
  })

  it('tolerates a trailing `/**` glob suffix as directory-level', () => {
    const r = parseIssueSurface('## Surface\n\nin: packages/aeg-core/**\nout: —\n')
    expect(r.ok).toBe(true)
  })

  // O15 — a dot-prefixed directory (`.claude`, `.github`) is a directory, not
  // a file: its last segment's only `.` sits at index 0, a name, not an
  // extension.
  it('O15: a bare dot-directory entry is not read as a file path', () => {
    const r = parseIssueSurface('## Surface\n\nin: .claude\nout: —\n')
    expect(r.ok).toBe(true)
  })

  it('O15: a dot-directory with a trailing `/**` is not read as a file path', () => {
    const r = parseIssueSurface('## Surface\n\nin: .github/**\nout: —\n')
    expect(r.ok).toBe(true)
  })

  it('O15: a real dotfile inside a dot-directory is still refused as a file path', () => {
    const r = parseIssueSurface('## Surface\n\nin: .claude/skills/foo.md\nout: —\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/looks like a file path/)
  })
})

describe('checkSurfaceGlobsResolve (O1)', () => {
  it('passes when every `in:` glob resolves', () => {
    const body = '## Surface\n\nin: packages/aeg-core/src\nout: —\n'
    const r = checkSurfaceGlobsResolve(body, () => true)
    expect(r.status).toBe('pass')
  })

  it('fails, naming the glob, when an `in:` glob resolves to nothing', () => {
    const body = '## Surface\n\nin: packages/does-not-exist\nout: —\n'
    const r = checkSurfaceGlobsResolve(body, () => false)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/does-not-exist/)
    expect(r.errors[0]).toMatch(/matches no tracked file/)
  })

  it('names only the glob that fails, not the whole list', () => {
    const body = '## Surface\n\nin: packages/aeg-core/src, packages/nope\nout: —\n'
    const r = checkSurfaceGlobsResolve(body, (glob) => glob !== 'packages/nope')
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toMatch(/packages\/nope/)
  })

  it('catches a backtick-wrapped glob naturally — it can never resolve to a real tracked path', () => {
    const body = '## Surface\n\nin: `packages/aeg-core/src`\nout: —\n'
    const r = checkSurfaceGlobsResolve(body, (glob) => !glob.includes('`'))
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toContain('`packages/aeg-core/src`')
  })

  it('does not check `out:` globs — a legitimate exclusion may not exist yet', () => {
    const body = '## Surface\n\nin: packages/aeg-core/src\nout: packages/not-created-yet\n'
    const r = checkSurfaceGlobsResolve(body, (glob) => glob === 'packages/aeg-core/src')
    expect(r.status).toBe('pass')
  })

  it('passes trivially when `## Surface` itself does not parse — reported elsewhere', () => {
    const r = checkSurfaceGlobsResolve('nothing surface-shaped here', () => false)
    expect(r.status).toBe('pass')
  })
})

describe('checkPartsCiteDefinedObjectives (O2)', () => {
  const objectives = '## Objectives\n\nO1. Do the first thing.\nO2. Do the second thing.\n'

  it('passes when every Part cites a defined objective', () => {
    const body = `${objectives}\n## Parts\n\nPart 1 (O1) — the parsers.\nPart 2 (O1, O2) — the render.\n`
    expect(checkPartsCiteDefinedObjectives(body).status).toBe('pass')
  })

  it('fails, naming the part and the undefined citation, when a Part cites O3 with no O3', () => {
    const body = `${objectives}\n## Parts\n\nPart 1 (O1) — the parsers.\nPart 2 (O3) — a phantom objective.\n`
    const r = checkPartsCiteDefinedObjectives(body)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/Part 2/)
    expect(r.errors[0]).toMatch(/O3/)
  })

  it('passes trivially when Objectives is malformed — reported by checkIssueObjectives instead', () => {
    const body = '## Parts\n\nPart 1 (O9) — cites an objective that does not exist anywhere.\n'
    expect(checkPartsCiteDefinedObjectives(body).status).toBe('pass')
  })

  it('passes trivially when Parts is malformed — reported by parseIssueParts instead', () => {
    const body = `${objectives}\n## Parts\n\nnothing part-shaped here\n`
    expect(checkPartsCiteDefinedObjectives(body).status).toBe('pass')
  })
})

describe('checkDocsWithinSurface (O6)', () => {
  const surface = '## Surface\n\nin: aeg-root/skills/**\nout: aeg-root/tranches/**\n'

  it('passes when the docs pointer falls inside an `in:` glob', () => {
    const body = `${surface}\n**Docs to keep coherent** — Update \`aeg-root/skills/foo/SKILL.md\`.\n`
    expect(checkDocsWithinSurface(body, 500).status).toBe('pass')
  })

  it('fails, naming the pointer and the glob, when the pointer falls inside an `out:` glob', () => {
    const body = `${surface}\n**Docs to keep coherent** — Update \`aeg-root/tranches/example-tranche.md\`.\n`
    const r = checkDocsWithinSurface(body, 500)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/aeg-root\/tranches\/example-tranche\.md/)
    expect(r.errors[0]).toMatch(/aeg-root\/tranches\/\*\*/)
  })

  it('passes when the pointer falls outside every `in:` glob but inside no `out:` glob either', () => {
    const body = `${surface}\n**Docs to keep coherent** — Update \`apps/cli/specs/surface.md\`.\n`
    expect(checkDocsWithinSurface(body, 500).status).toBe('pass')
  })

  it('passes on the explicit `no-doc-surface` sentinel — nothing to compare', () => {
    const body = `${surface}\n**Docs to keep coherent** — no-doc-surface.\n`
    expect(checkDocsWithinSurface(body, 500).status).toBe('pass')
  })

  it('passes below the brief-sections cutover — no `## Surface` to compare against', () => {
    const body = '**Docs to keep coherent** — Update `apps/cli/specs/surface.md`.\n'
    expect(checkDocsWithinSurface(body, 425).status).toBe('pass')
  })

  it('passes trivially when `## Surface` does not parse — reported elsewhere', () => {
    const body = '**Docs to keep coherent** — Update `apps/cli/specs/surface.md`.\n'
    expect(checkDocsWithinSurface(body, 500).status).toBe('pass')
  })
})

describe('checkRationaleSurfaceCoverage (task-run-v1 11, O4)', () => {
  const surface = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/src/commands\n'

  it('passes when the Boundary path falls inside an `in:` glob', () => {
    const body = `${surface}\n**Boundary** — Edits \`apps/cli/src/lib/forge-write.ts\`.\n`
    expect(checkRationaleSurfaceCoverage(body, 500).status).toBe('pass')
  })

  it('fails, naming the path and the nearest `in:` entry, when no `in:` glob covers it', () => {
    const body = `${surface}\n**Boundary** — Edits \`packages/aeg-core/src/issue-validation.ts\`.\n`
    const r = checkRationaleSurfaceCoverage(body, 500)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/aeg-core\/src\/issue-validation\.ts/)
    expect(r.errors[0]).toMatch(/apps\/cli\/src\/lib/)
  })

  it('picks the `in:` glob sharing the most leading path segments as "nearest"', () => {
    const body =
      '## Surface\n\nin: apps/cli/src/lib, apps/cli/src/commands\nout: —\n\n' +
      '**Boundary** — Edits `apps/cli/src/checks/edge-resolve.ts`.\n'
    const r = checkRationaleSurfaceCoverage(body, 500)
    expect(r.status).toBe('fail')
    // Both candidates share `apps/cli/src`; neither shares `checks` — first
    // occurrence wins the tie, matching `nearestInGlob`'s own tie-break rule.
    expect(r.errors[0]).toMatch(/nearest is `apps\/cli\/src\/lib`/)
  })

  it('passes when Boundary names a path to EXCLUDE it — covered by `out:`, not a gap', () => {
    const body = `${surface}\n**Boundary** — Does NOT touch \`apps/cli/src/commands/task.ts\`.\n`
    expect(checkRationaleSurfaceCoverage(body, 500).status).toBe('pass')
  })

  it('does not scan "Docs to keep coherent" — that field has its own, deliberately narrower check', () => {
    const body = `${surface}\n**Docs to keep coherent** — See \`packages/aeg-core/src/issue-validation.ts\`.\n`
    expect(checkRationaleSurfaceCoverage(body, 500).status).toBe('pass')
  })

  it('passes below the brief-sections cutover — no `## Surface` to compare against', () => {
    const body = '**Boundary** — Edits `packages/aeg-core/src/issue-validation.ts`.\n'
    expect(checkRationaleSurfaceCoverage(body, 425).status).toBe('pass')
  })

  it('passes trivially when `## Surface` does not parse — reported elsewhere', () => {
    const body = '**Boundary** — Edits `packages/aeg-core/src/issue-validation.ts`.\n'
    expect(checkRationaleSurfaceCoverage(body, 500).status).toBe('pass')
  })

  it('ignores a bare backticked identifier with no `/` — never a path', () => {
    const body = `${surface}\n**Boundary** — Calls \`renderBrief()\`.\n`
    expect(checkRationaleSurfaceCoverage(body, 500).status).toBe('pass')
  })
})

describe('checkSurfaceExcludesBoundDoc (task-run-v1 9, O1/O2/O3)', () => {
  // The Planner's own sizing example (Issue #493): `apps/cli/src/lib/**` binds
  // to `apps/cli/specs/surface.md`, and a Surface that pulls the code glob
  // into `in:` while excluding the doc via `out:` is the contradiction.
  const manifest = 'apps/cli/src/lib/**  apps/cli/specs/surface.md\n'

  it('refuses, naming the binding and the two contradicting Surface lines', () => {
    const body = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/specs\n'
    const r = checkSurfaceExcludesBoundDoc(body, manifest)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/apps\/cli\/src\/lib/)
    expect(r.errors[0]).toMatch(/\.vinaya\/doc-owners:1/)
    expect(r.errors[0]).toMatch(/apps\/cli\/src\/lib\/\*\*/)
    expect(r.errors[0]).toMatch(/apps\/cli\/specs\/surface\.md/)
    expect(r.errors[0]).toMatch(/apps\/cli\/specs/)
  })

  it('passes (O3) once the bound document is moved inside `in:`', () => {
    const body = '## Surface\n\nin: apps/cli/src/lib, apps/cli/specs\nout: —\n'
    expect(checkSurfaceExcludesBoundDoc(body, manifest).status).toBe('pass')
  })

  it('passes (O3) when no doc-owners binding matches the `in:` list at all', () => {
    const body = '## Surface\n\nin: packages/aeg-forge-state\nout: apps/cli/specs\n'
    expect(checkSurfaceExcludesBoundDoc(body, manifest).status).toBe('pass')
  })

  it('passes when the bound document is simply absent from both `in:` and `out:`', () => {
    const body = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/src/commands\n'
    expect(checkSurfaceExcludesBoundDoc(body, manifest).status).toBe('pass')
  })

  it('skips a URL-pointer binding — no repo path an `out:` glob could cover', () => {
    const urlManifest = 'apps/cli/src/lib/**  https://example.com/docs\n'
    const body = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/specs\n'
    expect(checkSurfaceExcludesBoundDoc(body, urlManifest).status).toBe('pass')
  })

  it('passes trivially when `.vinaya/doc-owners` is absent', () => {
    const body = '## Surface\n\nin: apps/cli/src/lib\nout: apps/cli/specs\n'
    expect(checkSurfaceExcludesBoundDoc(body, null).status).toBe('pass')
  })

  it('passes trivially when `## Surface` does not parse — reported elsewhere', () => {
    const body = '**Docs to keep coherent** — no `## Surface` heading here.\n'
    expect(checkSurfaceExcludesBoundDoc(body, manifest).status).toBe('pass')
  })
})

describe('checkSurfaceScope (O7)', () => {
  it('passes when no changed file falls inside an out: glob', () => {
    const result = checkSurfaceScope(['packages/aeg-core/src/issue-validation.ts'], ['packages/aeg-core/src/other/**'])
    expect(result.ok).toBe(true)
  })

  it('fails, naming the file and the glob, when a changed file falls inside an out: glob', () => {
    const result = checkSurfaceScope(['packages/aeg-core/src/other/thing.ts'], ['packages/aeg-core/src/other/**'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations).toEqual([
      { file: 'packages/aeg-core/src/other/thing.ts', glob: 'packages/aeg-core/src/other/**' }
    ])
  })

  it('reports every violation in one pass, not only the first (O12 discipline)', () => {
    const result = checkSurfaceScope(['a/one.ts', 'b/two.ts', 'c/three.ts'], ['a/**', 'b/**'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations).toEqual([
      { file: 'a/one.ts', glob: 'a/**' },
      { file: 'b/two.ts', glob: 'b/**' }
    ])
  })

  it('passes trivially when no out: globs are declared', () => {
    const result = checkSurfaceScope(['anything.ts'], [])
    expect(result.ok).toBe(true)
  })

  it('names the first matching glob when a file falls under more than one', () => {
    const result = checkSurfaceScope(['a/b/c.ts'], ['a/**', 'a/b/**'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations[0]?.glob).toBe('a/**')
  })
})

describe('checkBlastRadiusScope (O4) — structural mode at/above the brief-sections cutover', () => {
  it('fails from `## Surface` alone when an `in:` glob covers a shared domain, even with no Boundary prose', () => {
    const body = '## Surface\n\nin: packages/ui/**\nout: —\n\n**Project:** vinaya\n'
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY, 500)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/ui/)
  })

  it('passes from `## Surface` alone when no `in:` glob covers a shared domain, even if Boundary prose names it to EXCLUDE it', () => {
    // The exact O4 case: naming a package in order to exclude it must not trip
    // the gate once the decision is structural.
    const body = [
      '## Surface',
      '',
      'in: apps/vinaya/**',
      'out: packages/ui/**',
      '',
      '**Boundary** — Does NOT touch `packages/ui` (that package is out of scope).',
      '',
      '**Project:** vinaya'
    ].join('\n')
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY, 500)
    expect(r.status).toBe('pass')
  })

  it('falls back to the prose scan below the cutover, unchanged', () => {
    const body = rationale({ boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).' })
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY, 425)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/ui/)
  })

  it('falls back to the prose scan on a null issueNumber (not yet created), unchanged', () => {
    const body = rationale({ boundary: 'Restyle the shared TopBar (`packages/ui/topbar/index.tsx`).' })
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY, null)
    expect(r.status).toBe('fail')
    expect(r.errors[0]).toMatch(/packages\/ui/)
  })

  it('still honors the ack line and the ownership bypass in structural mode', () => {
    const body = [
      '## Surface',
      '',
      'in: packages/ui/**',
      'out: —',
      '',
      '**blast-radius-ack:** every consumer keeps the existing fallback path.',
      '',
      '**Project:** vinaya'
    ].join('\n')
    const r = checkBlastRadiusScope(body, [], SHARED, REGISTRY, 500)
    expect(r.status).toBe('pass')
  })
})

describe('parseIssueParts', () => {
  it('parses numbered Part lines with their objective refs', () => {
    const body = '## Parts\n\nPart 1 (O1) — the parsers.\nPart 2 (O1, O2) — the render.\n'
    const r = parseIssueParts(body)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual([
      { n: 1, objectiveIds: [1], text: 'the parsers.' },
      { n: 2, objectiveIds: [1, 2], text: 'the render.' }
    ])
  })

  it('refuses when the `## Parts` heading is absent', () => {
    const r = parseIssueParts('nothing parts-shaped here')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/no `## Parts` heading/)
  })

  it('refuses a line with no outcome text after the dash', () => {
    const r = parseIssueParts('## Parts\n\nPart 1 (O1) — \n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/no outcome text/)
  })

  it('refuses an outcome that is little more than a bare file path', () => {
    const r = parseIssueParts('## Parts\n\nPart 1 (O1) — `packages/aeg-core/src/issue-validation.ts`\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/little more than a file path/)
  })

  it('a Part naming no objective (an administrative Part) parses with an empty objectiveIds', () => {
    const r = parseIssueParts('## Parts\n\nPart 1 () — changesets, then the one push.\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value[0]?.objectiveIds).toEqual([])
  })
})

describe('parseIssueTestPlan', () => {
  it('parses the unit-tests-only sentinel', () => {
    const r = parseIssueTestPlan('## Test plan\n\nTest plan: unit-tests-only\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ kind: 'unit-tests-only' })
  })

  it('parses a fenced command list plus a `[principal]` item', () => {
    const body = [
      '## Test plan',
      '',
      '```',
      'bun test → 0 fail',
      '```',
      '',
      '- [ ] **[principal]** Verify in a real browser.',
      ''
    ].join('\n')
    const r = parseIssueTestPlan(body)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      kind: 'commands',
      lines: ['bun test → 0 fail'],
      principal: ['Verify in a real browser.']
    })
  })

  it('refuses both the sentinel and a fence together — same exclusivity rule as the PR body', () => {
    const body = ['## Test plan', '', 'Test plan: unit-tests-only', '', '```', 'bun test → 0 fail', '```', ''].join(
      '\n'
    )
    const r = parseIssueTestPlan(body)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/mutually exclusive/)
  })

  it('refuses when the `## Test plan` section is absent', () => {
    const r = parseIssueTestPlan('nothing test-plan-shaped here')
    expect(r.ok).toBe(false)
  })
})

describe('parseIssueStopConditions', () => {
  it('parses a bullet list', () => {
    const r = parseIssueStopConditions('## Stop conditions\n\n- Pre-flight fails.\n- A premise pin mismatches.\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual(['Pre-flight fails.', 'A premise pin mismatches.'])
  })

  it('refuses when the section has no bullet items', () => {
    const r = parseIssueStopConditions('## Stop conditions\n\nnothing bulleted here\n')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/no bullet-list items/)
  })

  it('refuses when the `## Stop conditions` heading is absent', () => {
    expect(parseIssueStopConditions('nothing here').ok).toBe(false)
  })
})

describe('checkIssueBriefSections', () => {
  it('passes a fully-formed Issue at the cutover (#426 itself)', () => {
    expect(BRIEF_SECTIONS_SINCE_ISSUE).toBe(426)
    const r = checkIssueBriefSections(ISSUE_426_BODY, 426)
    expect(r.status).toBe('pass')
  })

  it('fails, naming Parts, when `## Parts` is removed from an at-cutover Issue', () => {
    const withoutParts = ISSUE_426_BODY.replace(/## Parts[\s\S]*?(?=\n## Test plan)/, '')
    const r = checkIssueBriefSections(withoutParts, 426)
    expect(r.status).toBe('fail')
    expect(r.errors.join(' ')).toMatch(/Parts/)
  })

  it('passes an Issue below the cutover carrying none of the four sections', () => {
    const r = checkIssueBriefSections('a body with nothing but a title.', 425)
    expect(r.status).toBe('pass')
  })

  it('fails closed on a null Issue number, even with none of the four sections', () => {
    const r = checkIssueBriefSections('a body with nothing but a title.', null)
    expect(r.status).toBe('fail')
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

// task 17, O2 — the six write-only rules named apart.
describe('checkTrancheLabelPresence', () => {
  it('passes a task-shaped body carrying the tranche label', () => {
    const r = checkTrancheLabelPresence('## Objectives\n\nO1. Thing.\n', ['vinaya/tranche:demo-v1'])
    expect(r.status).toBe('pass')
  })

  it('fails a task-shaped body with no tranche label', () => {
    const r = checkTrancheLabelPresence('## Objectives\n\nO1. Thing.\n', [])
    expect(r.status).toBe('fail')
    expect(r.errors.join(' ')).toMatch(/tranche/)
  })

  it('passes a genuinely non-task body with no label — nothing to require', () => {
    const r = checkTrancheLabelPresence('just an ordinary Issue about a bug.', [])
    expect(r.status).toBe('pass')
  })
})

describe('checkMilestoneAttach', () => {
  it('passes a non-task Issue regardless of Milestone state', () => {
    const r = checkMilestoneAttach([], null, 'v1')
    expect(r.status).toBe('pass')
  })

  it('passes when no target Milestone could be resolved — dormant, nothing to compare', () => {
    const r = checkMilestoneAttach(['vinaya/tranche:demo-v1'], 'some-other-milestone', null)
    expect(r.status).toBe('pass')
  })

  it('passes when the live Milestone already matches the resolved target', () => {
    const r = checkMilestoneAttach(['vinaya/tranche:demo-v1'], 'v1', 'v1')
    expect(r.status).toBe('pass')
  })

  it('fails, naming both titles, when the live Milestone diverges from the resolved target', () => {
    const r = checkMilestoneAttach(['vinaya/tranche:demo-v1'], 'v0', 'v1')
    expect(r.status).toBe('fail')
    expect(r.errors.join(' ')).toMatch(/"v0"/)
    expect(r.errors.join(' ')).toMatch(/"v1"/)
  })

  it('fails, naming "unset", when the task Issue carries no live Milestone at all', () => {
    const r = checkMilestoneAttach(['vinaya/tranche:demo-v1'], null, 'v1')
    expect(r.status).toBe('fail')
    expect(r.errors.join(' ')).toMatch(/unset/)
  })
})
