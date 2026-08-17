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
    expect(projectFieldFromBody(body)).toEqual({ declared: false, names: [], unparsed: [] })
  })

  it('reports a declared value that did not parse, rather than dropping it', () => {
    // #554's exact body line: prose in the field. It still yields no project
    // name — but the caller can now see that a value WAS declared.
    const body = '**Project:** (none — tools/admin is unregistered; see Project(s) + blast radius above)'
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: [],
      unparsed: ['(none — tools/admin is unregistered; see Project(s) + blast radius above)']
    })
  })

  it('reports the parsed names and the unparsed residue side by side', () => {
    const body = '**Project:** aeg-core, a value with spaces'
    expect(projectFieldFromBody(body)).toEqual({
      declared: true,
      names: ['aeg-core'],
      unparsed: ['a value with spaces']
    })
  })

  it('de-duplicates repeated names, as `declaredProjects` already does', () => {
    expect(projectFieldFromBody('**Project:** vinaya, vinaya')).toEqual({
      declared: true,
      names: ['vinaya'],
      unparsed: []
    })
  })

  it('reports an empty value as declared — the field exists, it just says nothing', () => {
    expect(projectFieldFromBody('**Project:**   \n')).toEqual({ declared: true, names: [], unparsed: [] })
  })

  it('reports a fully-parsed declaration with no residue', () => {
    expect(projectFieldFromBody('**Project:** aeg-core, vinaya')).toEqual({
      declared: true,
      names: ['aeg-core', 'vinaya'],
      unparsed: []
    })
  })

  it('reads the same field, past the same fences, that `projectsFromBody` does', () => {
    expect(projectFieldFromBody(FENCED_EXAMPLE_THEN_FOOT_DECLARATION)).toEqual({
      declared: true,
      names: ['aeg-forge-state'],
      unparsed: []
    })
  })
})
