import { describe, expect, it, vi } from 'vitest'

vi.mock('./gh', () => ({
  ghIssueListByAnyLabel: vi.fn()
}))

const { ghIssueListByAnyLabel } = await import('./gh')
const { listTasksForSlug, projectFieldFromBody, projectsFromBody } = await import('./list-tasks')

describe('listTasksForSlug', () => {
  it('parses id/title from the `[<slug>] <id> — <title>` convention and projects from the body field', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 425,
        title: '[aeg-forge-state-v1] 1 — Generic forge-reading adapter (packages/forge-state)',
        body: '**Project:** aeg-core\n\n**Dependency rationale** — `Depends-on: —`. First task.\n\n**Traps to avoid** — none.',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tier:3' }, { name: 'vinaya/tranche:aeg-forge-state-v1' }]
      }
    ])

    const tasks = listTasksForSlug('daniboomerang', 'attalabs', 'aeg-forge-state-v1')

    expect(tasks).toEqual([
      {
        id: '1',
        title: 'Generic forge-reading adapter (packages/forge-state)',
        issue: 425,
        projects: ['aeg-core'],
        dependsOn: [],
        conflictsWith: [],
        rationaleMarkdown:
          '**Project:** aeg-core\n\n**Dependency rationale** — `Depends-on: —`. First task.\n\n**Traps to avoid** — none.'
      }
    ])
  })

  it('derives projects from the **Project:** field alone (post-#614 / state-machine-v1)', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 614,
        title: '[state-machine-v1] 2 — Migrate labels to the vinaya/ namespace',
        body: '**Boundary** — ...\n\n**Project(s) + blast radius** — `Project: aeg-core`.\n\n**Tier:** 3\n**Project:** aeg-core, vinaya',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tier:3' }, { name: 'vinaya/tranche:state-machine-v1' }]
      }
    ])

    const [task] = listTasksForSlug('daniboomerang', 'attalabs', 'state-machine-v1')

    expect(task?.projects).toEqual(['aeg-core', 'vinaya'])
  })

  it('ignores a residual project:* label — project is a field, never a label (#614)', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 700,
        title: '[iter] 1 — a stale project label lingers on the Issue',
        body: '**Project:** herald',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'project:vinaya' }, { name: 'vinaya/tranche:iter' }]
      }
    ])

    const [task] = listTasksForSlug('daniboomerang', 'attalabs', 'iter')

    expect(task?.projects).toEqual(['herald'])
  })

  it('reads the plain `Project: x` header form older Issues use (#614 addendum regression)', () => {
    // The whole `vada-production-v1` cohort and the `aeg-forge-state-v1`
    // fixture are authored this way. Accepting only the bold form dropped
    // their project the moment #614 deleted the `project:*` labels.
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 431,
        title: '[iter] 7 — plain-form header',
        body: 'Project: aeg, aeg-core\nTranche: iter · task 7\n\n**Boundary** — x',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      }
    ])

    const [task] = listTasksForSlug('daniboomerang', 'attalabs', 'iter')
    expect(task?.projects).toEqual(['aeg', 'aeg-core'])
  })

  it('still ignores the `**Project(s) + blast radius**` prose heading', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 800,
        title: '[iter] 1 — heading only, no field',
        body: '**Project(s) + blast radius** — reaches packages/ui.\n\n**Boundary** — x',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      }
    ])

    const [task] = listTasksForSlug('daniboomerang', 'attalabs', 'iter')
    expect(task?.projects).toEqual([])
  })

  it('ignores prose in the **Project:** field rather than deriving a garbage project (#554)', () => {
    // #554's EXACT body line. Unguarded, this split to a single "project"
    // named "(none — tools/admin is unregistered; …)", which rendered as a
    // project label and built a board link that 404s — strictly worse than
    // the board-less row it replaced. Regression pin: fails without the
    // slug-shape guard in `parseProjectField`.
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 554,
        title: '[admin-ui-library-picker-v1] 1 — Add per-app Library picker to tools/admin',
        body: '**Project:** (none — tools/admin is unregistered; see Project(s) + blast radius above)',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:admin-ui-library-picker-v1' }]
      }
    ])

    const [task] = listTasksForSlug('daniboomerang', 'attalabs', 'admin-ui-library-picker-v1')

    expect(task?.projects).toEqual([])
  })

  it('sorts numeric ids ahead of alpha suffix, e.g. 7 before 7a', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 2,
        title: '[iter] 7a — split B',
        body: '',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      },
      {
        number: 1,
        title: '[iter] 7 — split A',
        body: '',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      },
      {
        number: 3,
        title: '[iter] 2 — earlier task',
        body: '',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      }
    ])

    const tasks = listTasksForSlug('daniboomerang', 'attalabs', 'iter')
    expect(tasks.map((t) => t.id)).toEqual(['2', '7', '7a'])
  })

  it('drops Issues whose title does not match the `[slug] id — title` convention', () => {
    vi.mocked(ghIssueListByAnyLabel).mockReturnValue([
      {
        number: 1,
        title: 'A malformed title with no brackets',
        body: '',
        state: 'OPEN',
        milestone: null,
        labels: [{ name: 'vinaya/tranche:iter' }]
      }
    ])

    expect(listTasksForSlug('daniboomerang', 'attalabs', 'iter')).toEqual([])
  })
})

/**
 * A body whose real declaration sits at the foot, preceded by a fenced example
 * of the same field — the shape a brief or a rationale routinely carries when
 * it *documents* the grammar it is written in. The fenced line is an example;
 * only the foot line is a declaration.
 */
const FENCED_EXAMPLE_THEN_FOOT_DECLARATION = [
  '**Boundary** — teaches the field shape:',
  '',
  '```markdown',
  '**Project:** example-only',
  '```',
  '',
  '**Tier:** 1',
  '**Project:** aeg-forge-state'
].join('\n')

describe('projectsFromBody — fence-blindness', () => {
  it('reads the foot declaration, not an earlier fenced example of the same field', () => {
    expect(projectsFromBody(FENCED_EXAMPLE_THEN_FOOT_DECLARATION)).toEqual(['aeg-forge-state'])
  })

  it('reads the foot declaration past a tilde-fenced example', () => {
    const body = ['~~~', '**Project:** example-only', '~~~', '', '**Project:** aeg-core'].join('\n')
    expect(projectsFromBody(body)).toEqual(['aeg-core'])
  })

  it('reads the foot declaration past a 4-space-indented example', () => {
    const body = ['Prose paragraph.', '', '    Project: example-only', '', '**Project:** aeg-core'].join('\n')
    expect(projectsFromBody(body)).toEqual(['aeg-core'])
  })

  it('finds nothing when the only Project field is fenced — a fenced field is never a declaration', () => {
    const body = ['```', '**Project:** example-only', '```', '', '**Boundary** — x'].join('\n')
    expect(projectsFromBody(body)).toEqual([])
  })
})

describe('projectsFromBody — a declared value no longer vanishes silently', () => {
  it('parses a value wrapped entirely in backticks', () => {
    expect(projectsFromBody('**Project:** `aeg-core`')).toEqual(['aeg-core'])
  })

  it('parses a value wrapped entirely in bold', () => {
    expect(projectsFromBody('Project: **aeg-core**')).toEqual(['aeg-core'])
  })

  it('parses a value carrying the sentence full stop, so the registry can refuse it', () => {
    expect(projectsFromBody('**Project:** notaproject.')).toEqual(['notaproject'])
  })

  it('still parses the tolerant plain form', () => {
    expect(projectsFromBody('Project: aeg, aeg-core')).toEqual(['aeg', 'aeg-core'])
  })

  it('still parses the bold form', () => {
    expect(projectsFromBody('**Project:** aeg-core, vinaya')).toEqual(['aeg-core', 'vinaya'])
  })

  it('still refuses the `**Project(s) + blast radius**` prose heading', () => {
    expect(projectsFromBody('**Project(s) + blast radius** — `vinaya`. Touches packages/ui.')).toEqual([])
  })
})

describe('projectFieldFromBody — absent is distinguishable from unparseable', () => {
  it('reports a body with no Project field as undeclared', () => {
    const body = '**Project(s) + blast radius** — `vinaya`.\n\n**Boundary** — x'
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [], unreadable: false })
  })

  it('reports a declared value that did not parse, rather than dropping it', () => {
    // #554's exact body line: prose in the field. It still yields no project
    // name — but the caller can now see that a value WAS declared.
    const body = '**Project:** (none — tools/admin is unregistered; see Project(s) + blast radius above)'
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: [],
      unparsed: ['(none — tools/admin is unregistered; see Project(s) + blast radius above)'],
      unreadable: false
    })
  })

  it('reports the parsed names and the unparsed residue side by side', () => {
    const body = '**Project:** aeg-core, a value with spaces'
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: ['aeg-core'],
      unparsed: ['a value with spaces'],
      unreadable: false
    })
  })

  it('de-duplicates repeated names, as `declaredProjects` already does', () => {
    expect(projectFieldFromBody('**Project:** vinaya, vinaya')).toEqual({
      declared: true,
      names: ['vinaya'],
      unparsed: [],
      unreadable: false
    })
  })

  it('reports an empty value as declared — the field exists, it just says nothing', () => {
    expect(projectFieldFromBody('**Project:**   \n')).toEqual({
      declared: true,
      names: [],
      unparsed: [],
      unreadable: false
    })
  })

  it('reports a fully-parsed declaration with no residue', () => {
    expect(projectFieldFromBody('**Project:** aeg-core, vinaya')).toEqual({
      declared: true,
      names: ['aeg-core', 'vinaya'],
      unparsed: [],
      unreadable: false
    })
  })

  it('reads the same field, past the same fences, that `projectsFromBody` does', () => {
    expect(projectFieldFromBody(FENCED_EXAMPLE_THEN_FOOT_DECLARATION)).toEqual({
      declared: true,
      names: ['aeg-forge-state'],
      unparsed: [],
      unreadable: false
    })
  })
})

/**
 * An unterminated fence runs to end of body (CommonMark, and how GitHub renders
 * it), so a strip-then-read parser goes blind from the stray fence onward — and
 * the foot declaration is exactly what lives down there. Mapping that onto
 * `declared: false` hands the gate a pass on a body the pre-fix parser refused,
 * which is the same fail-open this whole change exists to close, one layer in.
 *
 * The reader is not asked to guess the author's intent: a body whose fences do
 * not balance is malformed, and the honest answer is "a field is there and I
 * cannot trust my read of it" — `declared: true` with the value as residue, so
 * the gate fails closed and says why.
 */
describe('projectFieldFromBody — an unterminated fence must not read as "no project"', () => {
  it('reports a field swallowed by a stray unclosed fence as declared, not absent', () => {
    const body = ['```', 'some example', '', '**Project:** notaproject'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: [],
      unparsed: ['notaproject'],
      unreadable: true
    })
  })

  it('reports a field swallowed by a four-backtick fence closed by three', () => {
    const body = ['````', 'x', '```', '', '**Project:** notaproject'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: [],
      unparsed: ['notaproject'],
      unreadable: true
    })
  })

  it('reports a field swallowed by an unterminated tilde fence', () => {
    const body = ['~~~', 'x', '', '**Project:** aeg-core'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: [],
      unparsed: ['aeg-core'],
      unreadable: true
    })
  })

  it('still reports a genuinely absent field as absent when the fences balance', () => {
    const body = ['```', 'example', '```', '', '**Boundary** — x'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [], unreadable: false })
  })

  it('still refuses a Project line that lives only inside a BALANCED fence', () => {
    // The defect this PR fixes. A balanced fence is a real example, and an
    // example is still not a declaration — the unterminated-fence guard must
    // not resurrect it.
    const body = ['```', '**Project:** example-only', '```', '', '**Boundary** — x'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [], unreadable: false })
  })

  it('prefers the real foot declaration when the fences balance', () => {
    const body = ['```', '**Project:** example-only', '```', '', '**Project:** aeg-core'].join('\n')
    expect(projectFieldFromBody(body).names).toEqual(['aeg-core'])
  })
})

describe('projectFieldFromBody — the wrapper peel is anchored to the value’s ends', () => {
  it('still peels a fully backticked value', () => {
    expect(projectsFromBody('**Project:** `aeg-core`')).toEqual(['aeg-core'])
  })

  it('still peels a trailing sentence full stop', () => {
    expect(projectsFromBody('**Project:** notaproject.')).toEqual(['notaproject'])
  })

  it('still peels a backticked value carrying the sentence full stop outside the span', () => {
    expect(projectsFromBody('**Project:** `aeg-core`.')).toEqual(['aeg-core'])
  })

  it('does NOT erase interior punctuation to manufacture a name', () => {
    // Erasing `.` anywhere let `v.i.n.a.y.a` resolve to the registered
    // `vinaya`: a body could read to a human as one thing and to the gate,
    // the board and the blast-radius check as a registered project.
    expect(projectFieldFromBody('**Project:** v.i.n.a.y.a')).toEqual({
      declared: true,
      names: [],
      unparsed: ['v.i.n.a.y.a'],
      unreadable: false
    })
  })

  it('does NOT erase an interior semicolon to manufacture a name', () => {
    expect(projectFieldFromBody('**Project:** vin;aya')).toEqual({
      declared: true,
      names: [],
      unparsed: ['vin;aya'],
      unreadable: false
    })
  })
})

describe('projectFieldFromBody — an HTML comment still wins first match (pre-existing)', () => {
  it('pins the known gap: a commented-out field outranks the real foot declaration', () => {
    // NOT introduced by the fence fix — the pre-fix parser gave the identical
    // answer, and an HTML comment is not code, so `stripCode` leaves it. Pinned
    // so the behaviour is a recorded decision rather than a silent surprise;
    // closing it means teaching the parser to skip comments, which is the
    // `Project:` field GRAMMAR and deliberately out of this change's scope.
    const body = ['<!--', '**Project:** vinaya', '-->', '', '**Project:** notaproject'].join('\n')
    expect(projectsFromBody(body)).toEqual(['vinaya'])
  })
})

describe('projectFieldFromBody — an indented code block is swallowed the same as a balanced fence', () => {
  // CommonMark treats a ≥4-column-indented run after a blank line as code, the
  // same as it treats a fenced block — and stripCode already blanks both the
  // same way (`maskIndentedCode`, `strip-code.ts`). A Project line down there is
  // an example, not a declaration, by the SAME deliberate rule this file
  // already applies to a balanced fence (see the fence-blindness describe
  // block above). An indented block always terminates by definition
  // (indentation drops, or the body ends) — there is no "unterminated
  // indented block" state analogous to an unbalanced fence, so `unreadable`
  // correctly never fires here. Pinned as a recorded decision.
  it('reports a 4-space-indented-only declaration as absent, not unreadable', () => {
    const body = ['Prose.', '', '    **Project:** notaproject'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [], unreadable: false })
  })

  it('reports a tab-indented-only declaration as absent, not unreadable', () => {
    const body = ['Prose.', '', '\t**Project:** notaproject'].join('\n')
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [], unreadable: false })
  })

  it('still reads a declaration indented inside LIST context — not code by CommonMark', () => {
    const body = ['- item', '', '    **Project:** aeg-core'].join('\n')
    expect(projectFieldFromBody(body).names).toEqual(['aeg-core'])
  })

  it('still reads an indented declaration with no preceding blank line — not code by CommonMark', () => {
    const body = ['Prose continues here.', '    **Project:** aeg-core'].join('\n')
    expect(projectFieldFromBody(body).names).toEqual(['aeg-core'])
  })
})

/**
 * The field's VALUE routinely sits on the
 * line after the label — GitHub renders `Project:\nvinaya` as the single
 * paragraph "Project: vinaya", and the tolerant-plain-form cohort the brief's
 * Traps section names is exactly this shape. `\s*` around the colon and after
 * `**` therefore MUST cross a line break; narrowing it to `[ \t]*` (a task 3
 * perf attempt, reverted) silently dropped this declaration to `declared:
 * false` (plain form) or a false "the field is empty" fail (bold form) — the
 * same silent-drop and vacuous-fail-open classes this whole task exists to
 * close, reintroduced one layer in. Nothing pinned this shape before; these
 * four tests do.
 */
describe('projectFieldFromBody — the value may sit on the line after the label', () => {
  it('reads the plain form when the value is on the next line', () => {
    const body = '**Project(s) + blast radius** — `vinaya`, edits `apps/cli`.\n\nProse.\n\nProject:\nvinaya'
    expect(projectFieldFromBody(body)).toEqual({ declared: true, names: ['vinaya'], unparsed: [], unreadable: false })
  })

  it('reads the bold form when the value is on the next line — does not report a false "field is empty"', () => {
    const body = 'Prose.\n\n**Project:**\nvinaya'
    expect(projectFieldFromBody(body)).toEqual({ declared: true, names: ['vinaya'], unparsed: [], unreadable: false })
  })

  it('reads the plain next-line shape — the form GitHub renders as one paragraph', () => {
    const body = 'Project:\nvinaya'
    expect(projectsFromBody(body)).toEqual(['vinaya'])
  })

  it('reads the bold next-line shape', () => {
    const body = '**Project:**\nvinaya'
    expect(projectsFromBody(body)).toEqual(['vinaya'])
  })
})

/**
 * Deleting the whitespace run immediately before the colon left the whole
 * suite green — an unpinned tolerance is how a narrowing of this pattern
 * ships unnoticed. `Project :` (a space before the colon) is a shape the
 * pattern already accepts; pin it so any future narrowing of that specific
 * run fails a test instead of passing silently.
 */
describe('projectFieldFromBody — tolerates a space before the colon', () => {
  it('parses "Project : x" — space before the colon', () => {
    expect(projectsFromBody('Project : vinaya')).toEqual(['vinaya'])
  })

  it('parses "**Project** : x" — space before the colon, bold form', () => {
    expect(projectsFromBody('**Project** : vinaya')).toEqual(['vinaya'])
  })
})

describe('the leading whitespace run is part of the grammar', () => {
  // A revert that restored only the runs around the colon left `^[ \t]*`
  // in place, so these shapes still dropped silently while `declaredProjects`
  // kept reading the name. `\s` covers them; `[ \t]` does not.
  const EXOTIC: Array<[string, string]> = [
    ['non-breaking space', '\u00a0'],
    ['form feed', '\f'],
    ['vertical tab', '\v']
  ]

  for (const [name, ws] of EXOTIC) {
    it(`reads a field line prefixed by a ${name}`, () => {
      expect(projectsFromBody(`${ws}**Project:** vinaya`)).toEqual(['vinaya'])
      expect(projectFieldFromBody(`${ws}**Project:** vinaya`).declared).toBe(true)
    })
  }
})
