import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCheckError, refuse } from '../../../tools/task-contract/forge/forge-write'
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
      message: 'issue surface: pass the draft Issue body with `--body-file <path>`.\n'
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
    const out = await renderBrief({ trancheSlug: 'no-such-tranche-planner-ops', taskId: '1' })
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

  it('returns a failed comment post as findings', async () => {
    const deps = stubDeps({ postComment: () => refuse([finding('forge-comment')]) })
    const out = await editObjectives(addArgs, {}, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-comment')
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
    expect(out).toEqual({ ok: true, brief: 'BRIEF' })
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
