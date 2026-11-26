import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  captureRefusal,
  makeCheckError,
  objectivesVersionMarkerPrefixes,
  refuse
} from '../../../tools/task-contract/forge/forge-write'
import {
  type ObjectivesDeps,
  type PlannerForge,
  createIssue,
  editIssue,
  editObjectives,
  printIssueSurface,
  renderBrief
} from './planner-operations'

const finding = (check: string) => makeCheckError(check, `${check} message`, `${check} recovery`)

/** A forge whose every step passes; a test overrides the step it exercises. */
function stubForge(over: Partial<PlannerForge> = {}): PlannerForge & { calls: string[] } {
  const calls: string[] = []
  const forge: PlannerForge = {
    fetchLabels: () => ({ labels: ['vinaya/tranche:demo'] }),
    frozenSectionChange: () => [],
    validate: async () => ({ errors: [], blocking: false, renderSkipped: null }),
    ensureTrancheLabel: (slug) => {
      calls.push(`label:${slug}`)
      return []
    },
    milestoneArgs: (args) => ({ args: [...args, '--milestone', 'M'], notice: null }),
    ghWrite: (cmd, args) => {
      calls.push(`gh ${cmd.join(' ')} ${args.join(' ')}`)
      return { ok: true, url: 'https://example.test/issues/7' }
    },
    ...over
  }
  return Object.assign(forge, { calls })
}

function withBody<T>(body: string, run: (bodyFile: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), 'planner-ops-'))
  const file = join(dir, 'body.md')
  writeFileSync(file, body, 'utf8')
  const done = () => rmSync(dir, { recursive: true, force: true })
  try {
    const out = run(file)
    if (out instanceof Promise) return out.finally(done)
    done()
    return out
  } catch (e) {
    done()
    throw e
  }
}

const createArgs = (file: string) => [
  '--title',
  '[demo] 1 — A task',
  '--label',
  'vinaya/tranche:demo',
  '--body-file',
  file
]

describe('createIssue', () => {
  it('passes: ensures the label, attaches the Milestone, and returns the written link', async () => {
    const forge = stubForge()
    const out = await withBody('body', (f) => createIssue({ ghArgs: createArgs(f) }, {}, forge))
    expect(out).toMatchObject({ ok: true, written: true, url: 'https://example.test/issues/7' })
    expect(forge.calls[0]).toBe('label:demo')
    expect(forge.calls[1]).toContain('--milestone M')
  })

  it('validate-only runs the gates and writes nothing', async () => {
    const forge = stubForge()
    const out = await withBody('body', (f) => createIssue({ ghArgs: createArgs(f), validateOnly: true }, {}, forge))
    expect(out).toMatchObject({ ok: true, written: false, url: '', renderSkipped: null })
    expect(forge.calls).toEqual([])
  })

  it('refuses with the gate findings and writes nothing', async () => {
    const forge = stubForge({
      validate: async () => ({ errors: [finding('brief-shape')], blocking: true, renderSkipped: null })
    })
    const out = await withBody('body', (f) => createIssue({ ghArgs: createArgs(f) }, {}, forge))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings.map((e) => e.check)).toEqual(['brief-shape'])
    expect(forge.calls).toEqual([])
  })

  it('reports a warning without refusing', async () => {
    const warning = makeCheckError('depends-on', 'unmerged', 'wait', 'warning')
    const seen: string[] = []
    const forge = stubForge({ validate: async () => ({ errors: [warning], blocking: false, renderSkipped: null }) })
    const out = await withBody('body', (f) =>
      createIssue({ ghArgs: createArgs(f) }, { warning: (e) => seen.push(e.check) }, forge)
    )
    expect(out.ok).toBe(true)
    expect(seen).toEqual(['depends-on'])
  })

  it('refuses an unreadable invocation (--body-file with no path) as a forge-args finding', async () => {
    const out = await createIssue({ ghArgs: ['--body-file'] }, {}, stubForge())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-args')
  })

  it('returns the tranche-label failure as a finding, before the write', async () => {
    const forge = stubForge({ ensureTrancheLabel: () => [finding('forge-fetch')] })
    const out = await withBody('body', (f) => createIssue({ ghArgs: createArgs(f) }, {}, forge))
    expect(out.ok).toBe(false)
    expect(forge.calls).toEqual([])
  })

  it('returns a failed gh write as a refusal carrying the raw error', async () => {
    const boom = new Error('gh exploded')
    const forge = stubForge({ ghWrite: () => ({ ok: false, errors: [finding('forge-write')], cause: boom }) })
    const out = await withBody('body', (f) => createIssue({ ghArgs: createArgs(f) }, {}, forge))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.forgeError).toBe(boom)
      expect(out.findings[0]?.check).toBe('forge-write')
    }
  })
})

describe('editIssue', () => {
  const edit = (f: string) => ['7', '--body-file', f]

  it('passes: writes and returns the link', async () => {
    const forge = stubForge()
    const out = await withBody('body', (f) => editIssue({ args: edit(f) }, {}, forge))
    expect(out).toMatchObject({ ok: true, written: true, url: 'https://example.test/issues/7' })
    expect(forge.calls.at(-1)).toContain('gh issue edit 7')
  })

  it('validate-only writes nothing', async () => {
    const forge = stubForge()
    const out = await withBody('body', (f) => editIssue({ args: edit(f), validateOnly: true }, {}, forge))
    expect(out).toMatchObject({ ok: true, written: false })
    expect(forge.calls).toEqual([])
  })

  it('refuses without a target Issue', async () => {
    const out = await editIssue({ args: ['--body-file', 'x'] }, {}, stubForge())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-args')
  })

  it('refuses a change to a frozen section before validating', async () => {
    const forge = stubForge({ frozenSectionChange: () => [finding('issue-frozen-brief')] })
    const out = await withBody('body', (f) => editIssue({ args: edit(f) }, {}, forge))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('issue-frozen-brief')
  })

  it('refuses when the label fetch fails', async () => {
    const forge = stubForge({ fetchLabels: () => ({ errors: [finding('forge-fetch')] }) })
    const out = await withBody('body', (f) => editIssue({ args: edit(f) }, {}, forge))
    expect(out.ok).toBe(false)
    expect(forge.calls).toEqual([])
  })

  it('returns a failed gh write as a refusal carrying the raw error', async () => {
    const boom = new Error('gh exploded')
    const forge = stubForge({ ghWrite: () => ({ ok: false, errors: [finding('forge-write')], cause: boom }) })
    const out = await withBody('body', (f) => editIssue({ args: edit(f) }, {}, forge))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.forgeError).toBe(boom)
  })
})

describe('printIssueSurface', () => {
  it('refuses with exit code 2 when no body is given', () => {
    const out = printIssueSurface([])
    expect(out).toEqual({
      ok: false,
      exitCode: 2,
      message: 'task_issue_surface: supply the draft Issue text in the `body` field.\n'
    })
  })

  it('refuses with exit code 2 when the Surface does not parse', async () => {
    const out = await withBody('no surface here', (f) => printIssueSurface(['--body-file', f]))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('does not parse')
  })

  it('refuses a body file that cannot be read without ending the process', () => {
    const out = printIssueSurface(['--body-file', '/nonexistent/planner-ops-body.md'])
    expect(out).toMatchObject({ ok: false, exitCode: 2 })
  })
})

describe('renderBrief', () => {
  it('returns the missing facts as a refusal for a task that does not exist', async () => {
    const assemble = (async (trancheSlug: string) => ({
      ok: false,
      missing: [`tranche ${trancheSlug} does not exist on the forge`]
    })) as never
    const out = await renderBrief({ trancheSlug: 'no-such-tranche-planner-ops', taskId: '1' }, assemble)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.missing.length).toBeGreaterThan(0)
  })
})

describe('editObjectives', () => {
  it('returns an argument refusal as findings, never exiting', async () => {
    const out = await editObjectives(['7'])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-args')
  })

  it('refuses a missing --reason', async () => {
    const out = await editObjectives(['7', '--add', 'Do a thing.'])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.message).toContain('--reason')
  })

  it('refuses --add without --part', async () => {
    const out = await editObjectives(['7', '--add', 'Do a thing.', '--reason', 'because'])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('objectives-part-required')
  })
})

describe('editObjectives with a stubbed forge', () => {
  const issueBody = ['## Objectives', '', 'O1. First thing.', '', '## Parts', '', 'Part 1 (O1) — does it', ''].join(
    '\n'
  )

  function stubDeps(
    over: Partial<ObjectivesDeps> = {}
  ): ObjectivesDeps & { posted: string[]; forgeStub: ReturnType<typeof stubForge> } {
    const posted: string[] = []
    const forgeStub = stubForge()
    const deps: ObjectivesDeps = {
      forge: forgeStub,
      requirePrincipal: () => {},
      resolvePrincipals: () => ['someone'],
      fetchIssue: () => ({ number: 7, body: issueBody, title: '[demo] 1 — A task', labels: [], comments: [] }),
      supersede: (async () => ({ commentUrl: 'https://example.test/super' })) as never,
      postComment: (_kind, _ref, marker) => {
        posted.push(marker)
        return 'https://example.test/comment'
      },
      ...over
    }
    return Object.assign(deps, { posted, forgeStub })
  }

  const addArgs = ['7', '--add', 'Second thing.', '--part', 'Part 2 (O2) — does more', '--reason', 'because']

  it('skips the frozen-section check for its own write and posts the next comment on an Issue already carrying one', async () => {
    const skips: boolean[] = []
    const prior = {
      body: `${objectivesVersionMarkerPrefixes()[0]}1 -->\nVersion: old`,
      url: 'https://example.test/c/1',
      author: 'someone'
    }
    const deps = stubDeps({
      fetchIssue: () => ({ number: 7, body: issueBody, title: '[demo] 1 — A task', labels: [], comments: [prior] })
    })
    deps.forgeStub.frozenSectionChange = (_ref, _body, _retry, skip) => {
      skips.push(skip === true)
      return skip === true ? [] : [finding('issue-objectives-edit')]
    }
    const out = await editObjectives(addArgs, {}, deps)
    expect(out).toMatchObject({ ok: true, url: 'https://example.test/comment' })
    expect(skips).toEqual([true])
    expect(deps.posted).toEqual([`${objectivesVersionMarkerPrefixes()[0]}2 -->`])
  })

  it('passes: writes the Issue, posts the audit comment and returns the link', async () => {
    const deps = stubDeps()
    const out = await editObjectives(addArgs, {}, deps)
    expect(out).toMatchObject({ ok: true, url: 'https://example.test/comment', supersedeUrl: null })
    expect(deps.posted).toHaveLength(1)
    expect(deps.forgeStub.calls.at(-1)).toContain('gh issue edit 7')
  })

  it('refuses when the Principal gate refuses, before reading the Issue', async () => {
    let fetched = false
    const deps = stubDeps({
      requirePrincipal: () => refuse([finding('principal-only')]),
      fetchIssue: () => {
        fetched = true
        throw new Error('unreachable')
      }
    })
    const out = await editObjectives(addArgs, {}, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('principal-only')
    expect(fetched).toBe(false)
  })

  it('refuses with the label-fetch failure and posts nothing', async () => {
    const deps = stubDeps({ forge: stubForge({ fetchLabels: () => ({ errors: [finding('forge-fetch')] }) }) })
    const out = await editObjectives(addArgs, {}, deps)
    expect(out.ok).toBe(false)
    expect(deps.posted).toEqual([])
  })

  it('rethrows a failed gh write and posts no comment', async () => {
    const boom = new Error('gh exploded')
    const deps = stubDeps({
      forge: stubForge({ ghWrite: () => ({ ok: false, errors: [finding('forge-write')], cause: boom }) })
    })
    await expect(editObjectives(addArgs, {}, deps)).rejects.toBe(boom)
    expect(deps.posted).toEqual([])
  })

  /** A frozen brief on the Issue, so the edit supersedes it; and a forge that records each body it writes. */
  function frozenDeps(over: Partial<ObjectivesDeps> & { failRestore?: boolean } = {}) {
    const bodies: string[] = []
    const forge = stubForge({
      ghWrite: (_cmd, args) => {
        bodies.push(readFileSync(args[args.indexOf('--body-file') + 1] as string, 'utf8'))
        if (over.failRestore && bodies.length > 1)
          return { ok: false as const, errors: [finding('forge-write')], cause: undefined }
        return { ok: true as const, url: 'https://example.test/issues/7' }
      }
    })
    const deps = stubDeps({
      forge,
      fetchIssue: () => ({
        number: 7,
        body: issueBody,
        title: '[demo] 1 — A task',
        labels: ['vinaya/tranche:demo'],
        comments: [{ body: '<!-- vinaya:brief:v1 -->\nBrief hash: abc\nold brief', author: 'someone' }] as never
      }),
      supersede: (async () => {
        throw new Error('supersede refused')
      }) as never,
      ...over
    })
    return { deps, bodies }
  }

  it('puts the previous Issue body back and posts no comment when the supersede fails', async () => {
    const { deps, bodies } = frozenDeps()
    await expect(editObjectives(addArgs, {}, deps)).rejects.toThrow('supersede refused')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toContain('O2. Second thing.')
    expect(bodies[1]).toBe(issueBody)
    expect(deps.posted).toEqual([])
  })

  it('names both failures when the restore after a failed supersede also fails', async () => {
    const { deps } = frozenDeps({ failRestore: true })
    await expect(editObjectives(addArgs, {}, deps)).rejects.toThrow(
      /supersede refused[\s\S]*Restoring Issue 7's previous body also failed/
    )
    expect(deps.posted).toEqual([])
  })

  it('returns a failed comment post as findings', async () => {
    const deps = stubDeps({ postComment: () => refuse([finding('forge-comment')]) })
    const out = await editObjectives(addArgs, {}, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-comment')
  })
})

describe('refusal capture is fail-closed', () => {
  it('turns a refusal deep in awaited work into findings, never a pass', async () => {
    const r = await captureRefusal(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      refuse([finding('deep')])
      return 'continued'
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]?.check).toBe('deep')
  })

  it('rethrows an unrelated error rather than reporting a refusal', async () => {
    await expect(
      captureRefusal(() => {
        throw new Error('not a refusal')
      })
    ).rejects.toThrow('not a refusal')
  })
})

describe('printIssueSurface pass', () => {
  it('returns the forced set and its rendering for a parseable Surface', async () => {
    const body = '## Surface\n\nin: packages/ui/**\nout: —\n\n**Project:** vinaya\n'
    const out = await withBody(body, (f) => printIssueSurface(['--body-file', f]))
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.json).toBe(false)
      expect(out.text.length).toBeGreaterThan(0)
    }
    const asJson = await withBody(body, (f) => printIssueSurface(['--body-file', f, '--json']))
    expect(asJson.ok && asJson.json).toBe(true)
  })
})

describe('renderBrief with a stubbed assembler', () => {
  it('returns the rendered brief on a pass', async () => {
    const out = await renderBrief({ trancheSlug: 't', taskId: '1' }, (async () => ({
      ok: true,
      brief: 'BRIEF'
    })) as never)
    expect(out).toEqual({ ok: true, brief: 'BRIEF', waiting: [] })
  })

  it('asks the tranche assembly for a preview and returns the waiting reasons beside the brief', async () => {
    const seen: unknown[] = []
    const out = await renderBrief({ trancheSlug: 't', taskId: '2', globs: ['g'] }, (async (...args: unknown[]) => {
      seen.push(args)
      return { ok: true, brief: 'BRIEF', issue: 5, waiting: ['depends on 1'] }
    }) as never)
    expect(out).toEqual({ ok: true, brief: 'BRIEF', waiting: ['depends on 1'] })
    expect(seen).toEqual([['t', '2', ['g'], undefined, { preview: true }]])
  })

  it('renders a single Issue by its number alone through the Issue assembly, asking for a preview', async () => {
    const seen: unknown[] = []
    const out = await renderBrief(
      { issue: 42 },
      (async () => {
        throw new Error('the tranche assembly must not run')
      }) as never,
      (async (...args: unknown[]) => {
        seen.push(args)
        return { ok: true, brief: 'ISSUE BRIEF', issue: 42, waiting: [] }
      }) as never
    )
    expect(out).toEqual({ ok: true, brief: 'ISSUE BRIEF', waiting: [] })
    expect(seen).toEqual([[42, undefined, { preview: true }]])
  })

  it('returns the missing facts as a refusal', async () => {
    const out = await renderBrief({ trancheSlug: 't', taskId: '1' }, (async () => ({
      ok: false,
      missing: ['a', 'b']
    })) as never)
    expect(out).toEqual({ ok: false, missing: ['a', 'b'] })
  })

  it('lets an assembler failure (the forge) propagate', async () => {
    await expect(
      renderBrief({ trancheSlug: 't', taskId: '1' }, async () => {
        throw new Error('forge down')
      })
    ).rejects.toThrow('forge down')
  })
})
