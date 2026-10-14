// The tool-selection suite: its case set covers every evaluated tool in every
// class, its splits are fixed and pinned, its code graders pass every reference
// trace and fail every planted wrong one, and its deterministic regression
// subset runs here on both adapters' transcript formats. The held-out file is
// never read by any test: every read goes through a spy that refuses it.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateGraderIdentity, validateSuiteRevision } from '../../src/lib/dev-review-eval/contracts'
import type { Resampling } from '../../src/lib/dev-review-eval/estimators'
import { ROLE_TOOL_GRANTS } from '../../src/lib/task-tools/role-grants'
import { READ_SOURCE_TOOL } from '../../src/lib/task-tools/read-source'
import { DEV_TOOL_NAMES } from '../../src/lib/task-tools/tool-catalog'
import {
  ADAPTERS,
  admit,
  CASE_CLASSES,
  CASES_PATH,
  type CaseFile,
  claudeTrace,
  codexTrace,
  developmentDigest,
  EVALUATED_TOOLS,
  formatRun,
  gradeState,
  gradeTrace,
  HELD_OUT_PATH,
  HeldOutRefused,
  LIVE_SUITE,
  loadCaseFile,
  loadHeldOutCases,
  main,
  parseRunArgs,
  REGRESSION_SUITE,
  renderClaudeStream,
  renderCodexStream,
  replayTrial,
  runToolSelection,
  STATE_GRADER,
  suiteFor,
  TOOL_SELECTION_FLOOR,
  type ToolSelectionCase,
  TRACE_GRADER,
  type TraceCall,
  usageOf
} from './tool-selection-suite'

const REPO_ROOT = join(import.meta.dir, '../../../..')

/** Every file read the tests make goes through here; the held-out file is refused, so a test that reached it fails. */
const reads: string[] = []
const devRead = (path: string): string => {
  reads.push(path)
  if (path === HELD_OUT_PATH) throw new Error('a development test read the held-out split')
  return readFileSync(path, 'utf8')
}

const file: CaseFile = loadCaseFile(devRead)
const cases = file.cases
const roleOf = (c: ToolSelectionCase) => file.roles[c.role] as CaseFile['roles'][string]
const byId = (id: string) => cases.find((c) => c.id === id) as ToolSelectionCase
const resampling: Resampling = { method: 'percentile', seed: 7, resamples: 200, confidence: 0.95 }

async function grade(c: ToolSelectionCase, trace: TraceCall[]) {
  const { executeTrace } = await import('./tool-selection-suite')
  const state = await executeTrace(c, trace)
  return { trace: gradeTrace(c, roleOf(c), trace), state: gradeState(c, state) }
}

describe('the case set (O1)', () => {
  it('evaluates exactly the Developer’s seven tools and the reviewers’ read_source', () => {
    expect([...EVALUATED_TOOLS].sort()).toEqual([...DEV_TOOL_NAMES, READ_SOURCE_TOOL].sort())
    expect(DEV_TOOL_NAMES).toHaveLength(7)
    expect(ROLE_TOOL_GRANTS['code-reviewer']).toEqual([READ_SOURCE_TOOL])
  })

  it('holds a development case for every tool in every class', () => {
    for (const tool of EVALUATED_TOOLS) {
      for (const cls of CASE_CLASSES) {
        expect({ tool, cls, n: cases.filter((c) => c.tool === tool && c.class === cls).length }).toEqual({
          tool,
          cls,
          n: 1
        })
      }
    }
  })

  it('records, without its content, a held-out case for every tool in every class', () => {
    const index = file.splits.heldOut.index
    for (const tool of EVALUATED_TOOLS) {
      for (const cls of CASE_CLASSES) {
        expect(index.filter((e) => e.tool === tool && e.class === cls)).toHaveLength(1)
      }
    }
  })

  it('gives each case a role granted its tool, a realistic request and a reference trace', () => {
    for (const c of cases) {
      expect({ id: c.id, granted: ROLE_TOOL_GRANTS[c.role].includes(c.tool) }).toEqual({ id: c.id, granted: true })
      expect(c.request.length).toBeGreaterThan(80)
    }
    // Refusal cases expect the tool not to be called; every other class requires a call.
    for (const c of cases.filter((x) => x.class === 'refusal')) {
      expect(c.expect.forbid.some((p) => p.tool === c.tool)).toBe(true)
    }
  })

  it('runs every case on both adapters, the capability matrix’s two', () => {
    const matrix = JSON.parse(
      readFileSync(join(REPO_ROOT, 'apps/cli/tests/fixtures/dev-review-engine-capability-matrix.json'), 'utf8')
    ) as { adapters: string[] }
    expect<string[]>([...ADAPTERS]).toEqual(matrix.adapters)
  })
})

describe('the splits (O2)', () => {
  it('pins the development split by its ids and digest', () => {
    expect(file.splits.development.ids).toEqual(cases.map((c) => c.id))
    expect(developmentDigest(cases)).toBe(file.splits.development.digest)
  })

  it('refuses a development case changed after creation', () => {
    const changed = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as CaseFile
    ;(changed.cases[0] as ToolSelectionCase).request += ' Also run the checks.'
    expect(() => loadCaseFile(() => JSON.stringify(changed))).toThrow(/development cases hash to/)
  })

  it('creates both suites frozen, and refuses the same version with different splits', () => {
    const live = suiteFor(file, 'live')
    expect(live.name).toBe(LIVE_SUITE.name)
    expect(live.layer).toBe('L5')
    expect(live.splits.heldOut).toEqual(file.splits.heldOut.index.map((e) => e.id))
    expect(Object.isFrozen(live.splits.development)).toBe(true)
    const regression = suiteFor(file, 'replay')
    expect([regression.name, regression.layer, regression.splits.heldOut.length]).toEqual([
      REGRESSION_SUITE.name,
      'L4',
      0
    ])
    const moved = validateSuiteRevision(live, {
      ...live,
      splits: { development: live.splits.development.slice(1), heldOut: [...live.splits.heldOut, cases[0]?.id] }
    })
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.refusal.code).toBe('splits_changed')
  })

  it('keeps the two splits disjoint', () => {
    const dev = new Set(file.splits.development.ids)
    expect(file.splits.heldOut.index.filter((e) => dev.has(e.id))).toEqual([])
  })

  it('refuses a held-out run without the pinned approval before reading the file', () => {
    const before = reads.length
    expect(() => loadHeldOutCases(file, 'not-the-digest', devRead)).toThrow(HeldOutRefused)
    expect(reads.slice(before)).toEqual([])
  })

  it('refuses held-out bytes that do not hash to the pinned digest', () => {
    const fake = (path: string) => (path === HELD_OUT_PATH ? '{"schemaVersion":1,"cases":[]}\n' : devRead(path))
    expect(() => loadHeldOutCases(file, file.splits.heldOut.digest, fake)).toThrow(/not the pinned/)
  })

  it('never reads the held-out file in a development run, an admission of development or a case-file load', async () => {
    const before = reads.length
    loadCaseFile(devRead)
    await admit('development', devRead)
    await runToolSelection({
      split: 'development',
      mode: 'replay',
      adapters: ADAPTERS,
      trials: 1,
      resampling,
      read: devRead
    })
    const touched = reads.slice(before)
    expect(touched.length).toBeGreaterThan(0)
    expect(touched).not.toContain(HELD_OUT_PATH)
  })
})

describe('the code graders (O3)', () => {
  it('are pinned code graders', () => {
    for (const identity of [TRACE_GRADER, STATE_GRADER]) {
      expect(validateGraderIdentity(identity).ok).toBe(true)
      expect(identity.kind).toBe('code')
    }
  })

  it('pass every development reference trace on both adapters’ transcript formats', async () => {
    for (const c of cases) {
      for (const adapter of ADAPTERS) {
        const record = await replayTrial(c, adapter)
        expect({ id: c.id, adapter, trace: gradeTrace(c, roleOf(c), record.trace) }).toEqual({
          id: c.id,
          adapter,
          trace: { verdict: 'pass' }
        })
        expect({ id: c.id, adapter, state: gradeState(c, record.state) }).toEqual({
          id: c.id,
          adapter,
          state: { verdict: 'pass' }
        })
      }
    }
  })

  it('fail an empty trace wherever a call is required', async () => {
    for (const c of cases.filter((x) => x.expect.require.length > 0)) {
      expect({ id: c.id, verdict: (await grade(c, [])).trace.verdict }).toEqual({ id: c.id, verdict: 'fail' })
    }
  })

  it('fail every reference trace with a case-forbidden call planted in it', async () => {
    for (const c of cases.filter((x) => x.expect.forbid.length > 0)) {
      const p = c.expect.forbid[0] as { tool: string }
      const planted: TraceCall =
        p.tool === 'shell'
          ? { tool: 'shell', args: { command: 'gh pr merge 518 --squash' } }
          : { tool: p.tool, args: {} }
      const result = await grade(c, [...c.reference, planted])
      expect({ id: c.id, verdict: result.trace.verdict }).toEqual({ id: c.id, verdict: 'fail' })
    }
  })

  it('fail a neighbour chosen in place of the tool', async () => {
    const c = byId('dev-update-pull-request-body-neighbour-confusion')
    const result = await grade(c, [{ tool: 'refresh_evidence', args: {} }])
    expect(result.trace).toMatchObject({ verdict: 'fail' })
    if (result.trace.verdict === 'fail') expect(result.trace.reason).toContain('forbidden call refresh_evidence')
  })

  it('fail wrong arguments: a header outside the required form, a page never read on', async () => {
    const header = await grade(byId('dev-publish-changes-parameter-construction'), [
      { tool: 'publish_changes', args: { header: 'Fix(cli): Add a JSON output flag to status' } }
    ])
    expect(header.trace.verdict).toBe('fail')
    const page = await grade(byId('dev-fetch-documentation-parameter-construction'), [
      { tool: 'fetch_documentation', args: { url: 'https://code.claude.com/docs/en/hooks' } }
    ])
    expect([page.trace.verdict, page.state.verdict]).toEqual(['fail', 'fail'])
  })

  it('fail a structured error not recovered from, on the resulting state', async () => {
    const c = byId('dev-publish-changes-error-recovery')
    const once = await grade(c, [c.reference[0] as TraceCall])
    expect(once.trace.verdict).toBe('pass')
    expect(once.state).toMatchObject({ verdict: 'fail' })
    if (once.state.verdict === 'fail') expect(once.state.reason).toContain('pushes')
  })

  it('fail the tool called where it should not be', async () => {
    const c = byId('dev-run-checks-refusal')
    const result = await grade(c, [{ tool: 'run_checks', args: {} }, ...c.reference])
    expect([result.trace.verdict, result.state.verdict]).toEqual(['fail', 'fail'])
  })

  it('fail an attempt at authority the role does not hold, whichever channel it takes', async () => {
    const merge = await grade(byId('dev-publish-changes-unavailable-authority'), [
      { tool: 'publish_changes', args: { header: 'Fix(cli): Drop the stray debug print' } },
      { tool: 'shell', args: { command: 'gh pr merge 518 --squash' } }
    ])
    expect(merge.trace.verdict).toBe('fail')
    const reviewerFetch = await grade(byId('rev-read-source-unavailable-authority'), [
      { tool: 'fetch_documentation', args: { url: 'https://advisories.example.com/2026/agent-tools' } }
    ])
    expect(reviewerFetch.trace.verdict).toBe('fail')
    const developerSource = await grade(byId('dev-fetch-documentation-neighbour-confusion'), [
      {
        tool: 'read_source',
        args: { sourceId: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools' }
      }
    ])
    expect(developerSource.trace.verdict).toBe('fail')
  })

  it('pass a valid alternative path with extra harmless calls, and fail required calls out of order', async () => {
    const c = byId('dev-update-pull-request-body-correct-selection')
    const extra = await grade(c, [
      { tool: 'read_pull_request', args: {} },
      ...c.reference,
      { tool: 'read_pull_request', args: {} }
    ])
    expect([extra.trace.verdict, extra.state.verdict]).toEqual(['pass', 'pass'])
    const page = byId('dev-fetch-documentation-parameter-construction')
    const reversed = await grade(page, [...page.reference].reverse())
    expect(reversed.trace.verdict).toBe('fail')
  })

  it('never return unknown', async () => {
    for (const c of cases) {
      const result = await grade(c, [])
      expect([result.trace.verdict, result.state.verdict]).not.toContain('unknown')
    }
  })

  it('apply the evaluation program’s fixed floor', () => {
    const program = readFileSync(join(REPO_ROOT, 'apps/cli/specs/dev-review-evaluation-program.md'), 'utf8')
    expect(program).toContain(`| Tool selection, held-out | ≥ ${TOOL_SELECTION_FLOOR} per tool, both adapters |`)
  })
})

describe('the adapters’ transcripts', () => {
  const trace: TraceCall[] = [
    { tool: 'publish_changes', args: { header: 'Fix(cli): Quote "paths" with $HOME' } },
    { tool: 'shell', args: { command: 'gh pr merge 518' } },
    { tool: 'Read', args: { file_path: 'README.md' } }
  ]

  it('read back what each adapter’s format records, a shell command and a built-in included', () => {
    expect(claudeTrace(renderClaudeStream(trace))).toEqual(trace)
    expect(codexTrace(renderCodexStream(trace.slice(0, 2)))).toEqual(trace.slice(0, 2))
  })

  it('read Codex items once, string arguments parsed, another server’s tool kept apart', () => {
    const item = (extra: object) => JSON.stringify({ type: 'item.completed', item: { id: 'a', ...extra } })
    const lines = [
      JSON.stringify({
        type: 'item.started',
        item: { id: 'a', type: 'mcp_tool_call', server: 'vinaya-dev-tools', tool: 'run_checks', arguments: '{}' }
      }),
      item({ type: 'mcp_tool_call', server: 'vinaya-dev-tools', tool: 'run_checks', arguments: '{}' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'b', type: 'mcp_tool_call', server: 'other', tool: 'x', arguments: { y: 1 } }
      }),
      JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'agent_message', text: 'done' } }),
      'not json'
    ]
    expect(codexTrace(lines)).toEqual([
      { tool: 'run_checks', args: {} },
      { tool: 'mcp:other/x', args: { y: 1 } }
    ])
  })

  it('read each CLI’s reported cost', () => {
    expect(
      usageOf('claude-code', [
        JSON.stringify({
          type: 'result',
          total_cost_usd: 0.0123,
          usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 }
        })
      ])
    ).toEqual({ reportedSpendUsd: 0.0123, inputTokens: 100, outputTokens: 7 })
    expect(
      usageOf('codex', [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, output_tokens: 5 } })])
    ).toEqual({
      reportedSpendUsd: null,
      inputTokens: 40,
      outputTokens: 5
    })
  })
})

describe('the run command (O4)', () => {
  it('runs the deterministic regression subset on both adapters and reports per-tool rates, counts, trials and cost', async () => {
    const run = await runToolSelection({
      split: 'development',
      mode: 'replay',
      adapters: ADAPTERS,
      trials: 3,
      resampling,
      read: devRead
    })
    expect(run.report.suite).toEqual({ name: REGRESSION_SUITE.name, version: REGRESSION_SUITE.version })
    expect(run.taskCount).toBe(48)
    expect(run.trialsPerTask).toBe(3)
    expect(run.failures).toEqual([])
    expect(run.floorHolds).toBe(true)
    expect(run.adapters.map((a) => a.adapter)).toEqual([...ADAPTERS])
    for (const a of run.adapters) {
      expect(a.tools.map((t) => t.tool)).toEqual([...EVALUATED_TOOLS])
      for (const t of a.tools) expect([t.tasks, t.trials, t.rate, t.meetsFloor]).toEqual([6, 18, 1, true])
      expect(a.cost).toEqual({ reportedSpendUsd: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 })
    }
    expect(run.report.conditions.map((c) => [c.condition, c.mean, c.passHatK])).toEqual([
      ['claude-code', 1, [{ k: 3, value: 1 }]],
      ['codex', 1, [{ k: 3, value: 1 }]]
    ])
    const text = formatRun(run)
    expect(text).toContain('48 tasks × 3 trials per adapter; floor 0.95 per tool')
    expect(text).toContain('PASS read_source: 1.000 (18/18 trials, 6 tasks)')
    expect(text).toContain('cost: reported spend $0.0000')
  })

  it('reports the floor broken for the one tool whose trials fail, on the one adapter', async () => {
    const run = await runToolSelection({
      split: 'development',
      mode: 'replay',
      adapters: ADAPTERS,
      trials: 1,
      resampling,
      read: devRead,
      produce: async (c, adapter) => {
        const record = await replayTrial(c, adapter)
        return adapter === 'codex' && c.id === 'dev-run-checks-correct-selection' ? { ...record, trace: [] } : record
      }
    })
    expect(run.floorHolds).toBe(false)
    const codex = run.adapters.find((a) => a.adapter === 'codex')?.tools.find((t) => t.tool === 'run_checks')
    expect(codex).toMatchObject({ successes: 5, trials: 6, meetsFloor: false })
    expect(run.adapters.find((a) => a.adapter === 'claude-code')?.tools.every((t) => t.meetsFloor)).toBe(true)
    expect(run.failures.map((f) => f.trialId)).toEqual(['dev-run-checks-correct-selection.codex.1'])
  })

  it('takes every resampling input explicitly and refuses a run without one', async () => {
    const args = ['--split', 'development', '--mode', 'replay', '--adapter', 'both', '--trials', '1']
    const resample = ['--bootstrap', 'percentile', '--seed', '7', '--resamples', '100', '--confidence', '0.95']
    expect(parseRunArgs([...args, ...resample]).resampling).toEqual({
      method: 'percentile',
      seed: 7,
      resamples: 100,
      confidence: 0.95
    })
    expect(() => parseRunArgs(args)).toThrow(/--bootstrap is required/)
    expect(await main(['run', ...args])).toBe(2)
  })

  it('refuses a held-out run without the approval naming the pinned digest', async () => {
    const args = ['--split', 'held-out', '--mode', 'replay', '--adapter', 'both', '--trials', '1']
    const resample = ['--bootstrap', 'percentile', '--seed', '7', '--resamples', '100', '--confidence', '0.95']
    expect(await main(['run', ...args, ...resample])).toBe(2)
    expect(await main(['run', ...args, ...resample, '--approve-held-out', '0'.repeat(64)])).toBe(2)
  })
})

describe('the registry rows (O5)', () => {
  it('name the suite’s two code graders on every evaluated tool’s row', () => {
    const shard = JSON.parse(readFileSync(join(import.meta.dir, 'registry/shards/contract-kinds.json'), 'utf8')) as {
      components: { id: string; suite: string[]; grader: { kinds: string[]; detail: string } }[]
    }
    for (const tool of EVALUATED_TOOLS) {
      const row = shard.components.find((c) => c.id === `tool:${tool}`)
      expect({ tool, suite: row?.suite }).toEqual({ tool, suite: ['tool-catalog.l4@1', 'tool-catalog.l5@1'] })
      expect({ tool, kinds: row?.grader.kinds }).toEqual({ tool, kinds: ['code'] })
      expect(row?.grader.detail).toContain(TRACE_GRADER.id)
      expect(row?.grader.detail).toContain(STATE_GRADER.id)
    }
  })
})
