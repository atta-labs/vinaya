import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ADAPTER_CONTRACT_CASES,
  CONTRACT_ADAPTERS,
  DETERMINISTIC_CHECKS,
  declaredDifferences,
  MATRIX_ADAPTER,
  PLANTED_SECRET,
  runDeterministicCase,
  sessionRuleViolations
} from './adapter-contract.js'
import {
  caseOutcome,
  LIVE_PROOF_COMMANDS,
  parseLiveArgs,
  parseProofSummary,
  renderLiveReport
} from './adapter-contract-live.js'

/**
 * The deterministic subset of the shared adapter-conformance suite, run on
 * every change: each case of `adapter-contract.ts` on Claude Code and on
 * Codex, on every session its role allows, against the real controller with
 * the forge and the agent faked. The live suite runs the same case list with
 * one command per adapter (`adapter-contract-live.ts`).
 */

const CLI_ROOT = join(import.meta.dir, '..', '..')
const MATRIX_DOC = join(CLI_ROOT, 'specs', 'dev-review-engine-capability-matrix.md')
const MATRIX_DATA = join(CLI_ROOT, 'tests', 'fixtures', 'dev-review-engine-capability-matrix.json')
const MODULES = join(CLI_ROOT, 'tests', 'eval', 'registry', 'modules.json')

/** The registry suites the five modules of cutover gate 4 declare at layer L4. */
const GATE_FOUR_MODULES = ['6.3', '6.4', '6.8', '6.21', '6.22']

describe('the shared case list', () => {
  it('holds the per-role session rule: Developer cases on first and resumed sessions, reviewer cases fresh, the one resumed reviewer case a refusal', () => {
    expect(sessionRuleViolations(ADAPTER_CONTRACT_CASES)).toEqual([])
    const refusals = ADAPTER_CONTRACT_CASES.filter((c) => c.refusal === true)
    expect(refusals.map((c) => [c.role, c.sessions])).toEqual([['reviewer', ['resumed']]])
  })

  it('refuses a case list that breaks the session rule', () => {
    const [developerCase] = ADAPTER_CONTRACT_CASES.filter((c) => c.role === 'developer')
    const [reviewerCase] = ADAPTER_CONTRACT_CASES.filter((c) => c.role === 'reviewer' && c.refusal !== true)
    expect(sessionRuleViolations([{ ...developerCase!, sessions: ['first'] }])).toHaveLength(1)
    expect(sessionRuleViolations([{ ...reviewerCase!, sessions: ['resumed'] }])).toHaveLength(1)
  })

  it('has one unique id and one deterministic driver per case', () => {
    const ids = ADAPTER_CONTRACT_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(DETERMINISTIC_CHECKS).sort()).toEqual([...ids].sort())
  })

  it('covers the contracts conformance list, role context delivery and host readiness', () => {
    const ids = new Set(ADAPTER_CONTRACT_CASES.map((c) => c.id))
    for (const id of [
      'catalog-listing',
      'schema-validation',
      'error-classes',
      'result-delivery',
      'malformed-output',
      'semantic-invalid',
      'precondition-retry',
      'second-failure-pause',
      'provider-error',
      'cancellation',
      'context-exhaustion',
      'timeout',
      'redaction',
      'reviewer-resume-refused',
      'role-context-developer',
      'role-context-reviewer',
      'host-readiness'
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('names only suites the module registry declares, and executes every L4 suite of the cutover-gate-4 modules', () => {
    const modules = (
      JSON.parse(readFileSync(MODULES, 'utf8')) as { modules: Array<{ id: string; suite: string[] | unknown }> }
    ).modules
    const declared = new Set(modules.flatMap((m) => (Array.isArray(m.suite) ? (m.suite as string[]) : [])))
    const named = new Set(ADAPTER_CONTRACT_CASES.flatMap((c) => c.suites))
    expect([...named].filter((s) => !declared.has(s))).toEqual([])
    const l4 = modules
      .filter((m) => GATE_FOUR_MODULES.includes(m.id))
      .flatMap((m) => (m.suite as string[]).filter((s) => s.includes('.l4@')))
    expect(l4).toHaveLength(GATE_FOUR_MODULES.length)
    expect(l4.filter((s) => !named.has(s))).toEqual([])
  })

  it('binds every live case to a proof the live command runs', () => {
    for (const c of ADAPTER_CONTRACT_CASES) {
      for (const binding of c.live) expect(Object.keys(LIVE_PROOF_COMMANDS)).toContain(binding.proof)
    }
  })
})

describe('declared differences', () => {
  const rows = (
    JSON.parse(readFileSync(MATRIX_DATA, 'utf8')) as { rows: Array<{ id: string; adapter?: string | null }> }
  ).rows
  const byId = new Map(rows.map((r) => [r.id, r]))

  it("cite a capability-matrix row of the adapter's own", () => {
    for (const d of declaredDifferences()) {
      expect(byId.get(d.matrixRow)?.adapter).toBe(MATRIX_ADAPTER[d.adapter])
    }
  })

  it('are the rows of the capability matrix table, one for one', () => {
    const doc = readFileSync(MATRIX_DOC, 'utf8')
    const section = doc.split('## Declared differences in the adapter conformance suite')[1]?.split('\n## ')[0] ?? ''
    const tableRows = section
      .split('\n')
      .filter((line) => /^\| `[a-z-]+` \|/.test(line))
      .map((line) => {
        const cells = line.split('|').map((cell) => cell.trim())
        return [cells[1]!.replaceAll('`', ''), cells[2], cells[3]!.replaceAll('`', ''), cells[4]]
      })
    const adapterName = { claude: 'Claude Code', codex: 'Codex' } as const
    expect(tableRows).toEqual(
      declaredDifferences().map((d) => [d.caseId, adapterName[d.adapter], d.matrixRow, d.supported ? 'yes' : 'no'])
    )
  })
})

describe('the live command, one per adapter', () => {
  it('takes one adapter and an optional report path, and refuses anything else', () => {
    expect(parseLiveArgs(['--agent', 'codex'])).toEqual({ agent: 'codex', report: null })
    expect(parseLiveArgs(['--agent', 'claude', '--report', '/tmp/r.md'])).toEqual({
      agent: 'claude',
      report: '/tmp/r.md'
    })
    expect(parseLiveArgs(['--agent', 'gemini'])).toHaveProperty('error')
    expect(parseLiveArgs(['--agent', 'claude', '--report'])).toHaveProperty('error')
  })

  it("reads each live proof's summary lines and the one dev-tools verdict", () => {
    const summary = parseProofSummary(
      [
        'PASS  not a summary line yet',
        '=== summary — codex ===',
        'PASS  first session — terminal turn.completed; accepted "first-1"',
        'FAIL  cancelled run — terminal (none)',
        'INCONCLUSIVE  provider error — provider capacity failure twice',
        'PROOF: FAIL'
      ].join('\n')
    )
    expect([...summary.keys()]).toEqual(['first session', 'cancelled run', 'provider error', 'PROOF'])
    expect(summary.get('cancelled run')?.outcome).toBe('FAIL')
    expect(parseProofSummary('\nPROOF: INCOMPLETE — see the fields above.\n').get('PROOF')?.outcome).toBe('FAIL')
    expect(parseProofSummary('\nPROOF: PASS — the result reached it.\n').get('PROOF')?.outcome).toBe('PASS')
  })

  it('fails a case on any failing binding, leaves it NOT RUN on a missing one, and names a case no proof observes', () => {
    const lines: Parameters<typeof caseOutcome>[1] = new Map()
    lines.set('result-proof', new Map([['first session', { outcome: 'PASS', detail: '' }]]))
    lines.set('dev-proof', new Map([['PROOF', { outcome: 'FAIL', detail: 'no call' }]]))
    expect(caseOutcome([{ proof: 'result-proof', case: 'first session' }], lines).outcome).toBe('PASS')
    expect(
      caseOutcome(
        [
          { proof: 'result-proof', case: 'first session' },
          { proof: 'dev-proof', case: 'PROOF' }
        ],
        lines
      ).outcome
    ).toBe('FAIL')
    expect(caseOutcome([{ proof: 'result-proof', case: 'resumed session' }], lines).outcome).toBe('NOT RUN')
    expect(caseOutcome([], lines).outcome).toBe('DETERMINISTIC ONLY')
  })

  it("writes a report naming the CLI version, every case's outcome and the adapter's declared differences, redacted", () => {
    for (const agent of CONTRACT_ADAPTERS) {
      const report = renderLiveReport({
        agent,
        version: '9.9.9 (fixture)',
        host: 'linux x64',
        startedAt: '2026-10-15T00:00:00.000Z',
        outcomes: ADAPTER_CONTRACT_CASES.map((c) => ({
          id: c.id,
          sessions: c.sessions,
          outcome: 'PASS' as const,
          evidence: [`provider said ${PLANTED_SECRET} from ${homedir()}/work`]
        }))
      })
      expect(report).toContain('CLI version: 9.9.9 (fixture)')
      for (const c of ADAPTER_CONTRACT_CASES) expect(report).toContain(`| \`${c.id}\` |`)
      for (const d of declaredDifferences()) {
        expect(report.includes(`| \`${d.caseId}\` | \`${d.matrixRow}\` |`)).toBe(d.adapter === agent)
      }
      expect(report).not.toContain(PLANTED_SECRET)
      expect(report).not.toContain(homedir())
    }
  })
})

for (const adapter of CONTRACT_ADAPTERS) {
  describe(`adapter conformance — ${adapter}`, () => {
    for (const c of ADAPTER_CONTRACT_CASES) {
      for (const session of c.sessions) {
        it(`${c.id} (${c.role}, ${session} session)`, async () => {
          const verdict = await runDeterministicCase(c, adapter, session)
          expect(verdict.failures).toEqual([])
        })
      }
    }
  })
}
