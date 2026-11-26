import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TaskToolErrorSchema } from '@harness/kernel/tools/catalog/task-tools'
import { makeCheckError } from '@harness/workflow/tools/task-contract/forge/forge-write'
import { PLANNER_TOOL_ENTRIES, PLANNER_TOOL_NAMES, plannerToolHandlers, type PlannerOperations } from './planner-tools'

const finding = (check: string) => makeCheckError(check, `${check} message`, `${check} recovery`)

/** Operations that record what they were called with and answer what a test says. */
function stubOps(
  over: Partial<PlannerOperations> = {}
): PlannerOperations & { calls: { op: string; arg: unknown; body?: string }[] } {
  const calls: { op: string; arg: unknown; body?: string }[] = []
  const bodyOf = (args: string[]) => {
    const i = args.indexOf('--body-file')
    return i >= 0 ? readFileSync(args[i + 1] as string, 'utf8') : undefined
  }
  const ops: PlannerOperations = {
    createIssue: async (input) => {
      calls.push({ op: 'create', arg: input, body: bodyOf(input.ghArgs) })
      return {
        ok: true,
        written: !input.validateOnly,
        url: input.validateOnly ? '' : 'https://example.test/issues/7',
        renderSkipped: null,
        warnings: []
      }
    },
    editIssue: async (input) => {
      calls.push({ op: 'edit', arg: input, body: bodyOf(input.args) })
      return {
        ok: true,
        written: !input.validateOnly,
        url: input.validateOnly ? '' : 'https://example.test/issues/9',
        renderSkipped: null,
        warnings: []
      }
    },
    editObjectives: async (args) => {
      calls.push({ op: 'objectives', arg: args })
      return { ok: true, version: 'v2', url: 'https://example.test/issues/9#c', supersedeUrl: null }
    },
    printIssueSurface: (args) => {
      calls.push({ op: 'surface', arg: args, body: bodyOf(args) })
      return { ok: true, set: { forced: [] } as never, json: false, text: 'surface text' }
    },
    renderBrief: async (input) => {
      calls.push({ op: 'brief', arg: input })
      return { ok: true, brief: '# brief', waiting: [] }
    },
    submitPlanDraft: (input) => {
      calls.push({ op: 'draft-submit', arg: input })
      return { ok: true, tranche: 'sample-plan', fingerprint: 'sha256:abc', tasks: 1 }
    },
    readPlanDraft: (tranche) => {
      calls.push({ op: 'draft-read', arg: tranche })
      return { ok: false, message: `no draft is stored for tranche "${tranche}" on this machine` }
    },
    ...over
  }
  return Object.assign(ops, { calls })
}

const call = (ops: PlannerOperations, name: (typeof PLANNER_TOOL_NAMES)[number], input: unknown) =>
  plannerToolHandlers(ops)[name](input, { caller: null })

const refusalFindings = (r: Awaited<ReturnType<typeof call>>) => {
  if (r.ok) throw new Error('expected a refusal')
  expect(TaskToolErrorSchema.safeParse(r.error).success).toBe(true)
  expect(r.error.kind).toBe('validation')
  return JSON.parse(r.error.detail as string) as { check: string; message: string; recovery: string }[]
}

const DRAFT = {
  schemaVersion: 1,
  tranche: 'sample-plan',
  revision: 'a'.repeat(40),
  reviewQuestionVersion: 'q1',
  tasks: [{ number: 1, issue: null, title: 'First', body: 'Body', labels: ['vinaya/tranche:sample-plan'] }],
  scope: [{ item: 'Everything', disposition: { kind: 'delivered', task: 1 } }]
}

describe('the plan draft tools', () => {
  it('plan_draft_submit hands a whole draft to the store and returns its fingerprint', async () => {
    const ops = stubOps()
    const r = await call(ops, 'plan_draft_submit', DRAFT)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toEqual({ tranche: 'sample-plan', fingerprint: 'sha256:abc', tasks: 1 })
    expect(ops.calls.map((c) => c.op)).toEqual(['draft-submit'])
  })

  it('plan_draft_submit refuses a malformed draft before it reaches the store', async () => {
    const ops = stubOps()
    const r = await call(ops, 'plan_draft_submit', { ...DRAFT, revision: 'main' })
    expect(r.ok).toBe(false)
    expect(refusalFindings(r)[0]?.check).toBe('tool-input')
    expect(ops.calls).toEqual([])
  })

  it('plan_draft_submit refuses a scope item delivered by a task the draft lacks', async () => {
    const r = await call(stubOps(), 'plan_draft_submit', {
      ...DRAFT,
      scope: [{ item: 'X', disposition: { kind: 'delivered', task: 9 } }]
    })
    expect(r.ok).toBe(false)
  })

  it('plan_draft_read returns the stored draft and its fingerprint, and refuses an absent one', async () => {
    const present = await call(
      stubOps({ readPlanDraft: () => ({ ok: true, draft: DRAFT as never, fingerprint: 'sha256:abc' }) }),
      'plan_draft_read',
      { tranche: 'sample-plan' }
    )
    expect(present.ok).toBe(true)
    if (present.ok) expect(present.result).toEqual({ draft: DRAFT, fingerprint: 'sha256:abc' })
    const absent = await call(stubOps(), 'plan_draft_read', { tranche: 'sample-plan' })
    expect(absent.ok).toBe(false)
    expect(refusalFindings(absent)[0]?.check).toBe('plan-draft')
  })
})

describe('the Planner tool entries', () => {
  it('are each tool of the seat, each with an input and an output schema', () => {
    expect(PLANNER_TOOL_ENTRIES.map((e) => e.name)).toEqual([...PLANNER_TOOL_NAMES])
    for (const entry of PLANNER_TOOL_ENTRIES) {
      expect(entry.inputSchema.type).toBe('object')
      expect(entry.outputSchema?.type).toBe('object')
    }
  })

  it('describe the Issue writers without a retired command word', () => {
    for (const name of ['task_issue_create', 'task_issue_edit']) {
      const description = PLANNER_TOOL_ENTRIES.find((e) => e.name === name)?.description ?? ''
      expect(description).not.toBe('')
      for (const word of ['issue', 'brief', 'milestone']) expect(description).not.toContain(`vinaya ${word}`)
    }
  })
})

describe('success returns the library’s outcome', () => {
  it('task_issue_create returns the written Issue’s link and hands the library the body as a file', async () => {
    const ops = stubOps()
    const r = await call(ops, 'task_issue_create', { title: 'T', body: '## Objectives\nO1.', labels: ['a', 'b'] })
    expect(r).toEqual({
      ok: true,
      result: { written: true, url: 'https://example.test/issues/7', renderSkipped: null, warnings: [] }
    })
    expect(ops.calls[0]?.body).toBe('## Objectives\nO1.')
    const ghArgs = ((ops.calls[0] as { arg: unknown }).arg as { ghArgs: string[] }).ghArgs
    expect(ghArgs).toContain('--title')
    expect(ghArgs.filter((a) => a === '--label')).toHaveLength(2)
  })
  it('task_issue_edit passes the Issue first and returns the link', async () => {
    const ops = stubOps()
    const r = await call(ops, 'task_issue_edit', { issue: 9, body: 'B', addLabels: ['x'] })
    expect(r).toMatchObject({ ok: true, result: { written: true, url: 'https://example.test/issues/9' } })
    expect(((ops.calls[0] as { arg: unknown }).arg as { args: string[] }).args[0]).toBe('9')
    expect(ops.calls[0]?.body).toBe('B')
  })
  it('task_issue_validate runs validate-only for create and for edit and writes nothing', async () => {
    const ops = stubOps()
    const c = await call(ops, 'task_issue_validate', { mode: 'create', body: 'B' })
    const e = await call(ops, 'task_issue_validate', { mode: 'edit', issue: 9, body: 'B' })
    expect(c).toMatchObject({ ok: true, result: { written: false, url: '' } })
    expect(e).toMatchObject({ ok: true, result: { written: false, url: '' } })
    expect(ops.calls.map((x) => (x.arg as { validateOnly?: boolean }).validateOnly)).toEqual([true, true])
  })
  it('task_issue_surface returns the library’s text', async () => {
    expect(await call(stubOps(), 'task_issue_surface', { body: 'B' })).toMatchObject({
      ok: true,
      result: { text: 'surface text' }
    })
  })
  it('task_objectives_edit builds the library’s arguments from the operation', async () => {
    const ops = stubOps()
    const r = await call(ops, 'task_objectives_edit', {
      op: 'replace',
      issue: 9,
      id: 'O2',
      sentence: 'S',
      reason: 'why'
    })
    expect(r).toMatchObject({ ok: true, result: { version: 'v2', supersedeUrl: null } })
    expect(ops.calls[0]?.arg).toEqual(['9', '--replace', 'O2', 'S', '--reason', 'why'])
    await call(ops, 'task_objectives_edit', { op: 'add', issue: 9, sentence: 'S', reason: 'why', part: 'P' })
    expect(ops.calls[1]?.arg).toEqual(['9', '--add', 'S', '--part', 'P', '--reason', 'why'])
  })
  it('brief_render returns the rendered text', async () => {
    const ops = stubOps()
    expect(await call(ops, 'brief_render', { tranche: 't', id: '3' })).toEqual({
      ok: true,
      result: { brief: '# brief', waiting: [] }
    })
    expect(ops.calls[0]?.arg).toEqual({ trancheSlug: 't', taskId: '3' })
  })
  it('brief_render returns the brief with the reasons the task cannot start yet', async () => {
    const ops = stubOps({
      renderBrief: async () => ({ ok: true, brief: '# brief', waiting: ['depends on task 1'] })
    })
    expect(await call(ops, 'brief_render', { tranche: 't', id: '3' })).toEqual({
      ok: true,
      result: { brief: '# brief', waiting: ['depends on task 1'] }
    })
  })
  it('brief_render with an Issue number alone returns that Issue’s brief', async () => {
    const ops = stubOps()
    expect(await call(ops, 'brief_render', { issue: 12 })).toEqual({
      ok: true,
      result: { brief: '# brief', waiting: [] }
    })
    expect(ops.calls[0]?.arg).toEqual({ issue: 12 })
  })
  it('brief_render refuses an Issue number given with a tranche and task id, and an address with neither', async () => {
    const ops = stubOps()
    expect((await call(ops, 'brief_render', { issue: 12, tranche: 't', id: '3' })).ok).toBe(false)
    expect((await call(ops, 'brief_render', { tranche: 't' })).ok).toBe(false)
    expect((await call(ops, 'brief_render', {})).ok).toBe(false)
    expect(ops.calls).toEqual([])
  })
})

describe('refusal keeps every finding’s check name and recovery text', () => {
  const findings = [finding('first-check'), finding('second-check')]

  it('an Issue write refusal: message is the first finding, detail is every finding', async () => {
    const ops = stubOps({ createIssue: async () => ({ ok: false, findings, warnings: [] }) })
    const r = await call(ops, 'task_issue_create', { title: 'T', body: 'B' })
    expect(!r.ok && r.error.message).toBe('first-check message')
    expect(refusalFindings(r)).toEqual([
      { check: 'first-check', message: 'first-check message', recovery: 'first-check recovery' },
      { check: 'second-check', message: 'second-check message', recovery: 'second-check recovery' }
    ])
  })
  it('the edit, validate and objectives tools refuse the same way', async () => {
    const ops = stubOps({
      editIssue: async () => ({ ok: false, findings, warnings: [] }),
      createIssue: async () => ({ ok: false, findings, warnings: [] }),
      editObjectives: async () => ({ ok: false, findings })
    })
    const results = [
      await call(ops, 'task_issue_edit', { issue: 1, title: 'T' }),
      await call(ops, 'task_issue_validate', { mode: 'create', body: 'B' }),
      await call(ops, 'task_issue_validate', { mode: 'edit', issue: 1, body: 'B' }),
      await call(ops, 'task_objectives_edit', { op: 'drop', issue: 1, id: 'O1', reason: 'r' })
    ]
    for (const r of results) expect(refusalFindings(r).map((f) => f.check)).toEqual(['first-check', 'second-check'])
  })
  it('a surface refusal and a brief refusal carry a check name and recovery text', async () => {
    const ops = stubOps({
      printIssueSurface: () => ({ ok: false, exitCode: 2, message: 'issue surface: no parse\n' }),
      renderBrief: async () => ({ ok: false, missing: ['Boundary', 'Parts'] })
    })
    const s = refusalFindings(await call(ops, 'task_issue_surface', { body: 'B' }))
    expect(s[0]).toMatchObject({ check: 'issue-surface', message: 'issue surface: no parse' })
    expect(s[0]?.recovery.length).toBeGreaterThan(0)
    const b = refusalFindings(await call(ops, 'brief_render', { tranche: 't', id: '3' }))
    expect(b.map((f) => f.check)).toEqual(['brief-render', 'brief-render'])
    expect(b[1]?.message).toContain('Parts')
  })
  it('a malformed input is refused in the same encoding, before any library call', async () => {
    const ops = stubOps()
    const r = await call(ops, 'task_issue_create', { title: '' })
    expect(refusalFindings(r)[0]?.check).toBe('tool-input')
    expect((await call(ops, 'task_issue_edit', { issue: 3 })).ok).toBe(false)
    expect((await call(ops, 'task_issue_validate', { mode: 'edit', body: 'B' })).ok).toBe(false)
    expect(ops.calls).toEqual([])
  })
})

describe('no tool ends the server', () => {
  it('a library that throws is an infrastructure error, not an escape', async () => {
    const ops = stubOps({
      createIssue: async () => {
        throw new Error('boom')
      }
    })
    const r = await call(ops, 'task_issue_create', { title: 'T', body: 'B' })
    expect(r).toEqual({ ok: false, error: { kind: 'infrastructure', message: 'boom' } })
  })
})
