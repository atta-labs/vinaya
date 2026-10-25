import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { compileFlow, type StepsFlow } from '@atta/engine'
import { buildAgentSpawnStateGraph } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import { developerTurnResultJsonSchema } from '../../../apps/cli/src/lib/developer-turn-result'
import { reviewResultJsonSchema } from '../../../apps/cli/src/lib/review-result'

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        camelize(item)
      ])
    )
  return value
}

describe('Vinaya process packed runtime boundary', () => {
  test('loads, compiles, builds, and resolves every agent permission and schema', () => {
    const folder = resolve(import.meta.dir, '..')
    const loaded = loadProcess(folder)
    const flow = camelize(parse(readFileSync(loaded.flowPath, 'utf8'))) as StepsFlow
    const plan = compileFlow(flow, 'Compile the Vinaya process')
    const executor = async () => ({})
    const config = { roles: {}, mechanicalActions: {} }
    expect(() => buildAgentSpawnStateGraph(plan, executor, config as never)).not.toThrow()
    const steps = flow.steps as Array<{ type: string; role?: string; permission?: string }>
    const agents = steps.filter((step) => step.type === 'agent')
    expect(plan.graph.nodes).toBeDefined()
    expect(Object.keys(plan.graph.nodes)).toHaveLength(27)
    for (const step of agents) {
      expect(step.permission).toBe(`${step.role}/grants.yaml`)
      const roleFolder = join(dirname(loaded.flowPath), step.role!)
      expect(() => JSON.parse(readFileSync(join(roleFolder, 'output.schema.json'), 'utf8'))).not.toThrow()
      expect(readFileSync(join(roleFolder, 'grants.yaml'), 'utf8')).toContain(`role: ${step.role}`)
      const actualSchema = JSON.parse(readFileSync(join(roleFolder, 'output.schema.json'), 'utf8'))
      const expectedSchema =
        step.role === 'developer'
          ? developerTurnResultJsonSchema({ knownFindingIds: [], requiredSources: [] })
          : reviewResultJsonSchema(step.role as 'code-reviewer' | 'security-reviewer')
      expect(actualSchema).toEqual(expectedSchema)
    }
  })

  test('after the local gates, the forge gates run in the standalone round order before any reviewer is dispatched', () => {
    const loaded = loadProcess(resolve(import.meta.dir, '..'))
    const flow = camelize(parse(readFileSync(loaded.flowPath, 'utf8'))) as StepsFlow
    const ids = (flow.steps as Array<{ id: string }>).map((step) => step.id)
    const order = ['run-mechanical-gates', 'check-mergeability', 'read-forge-ci', 'check-premise', 'assess-gate']
    expect(ids.filter((id) => order.includes(id))).toEqual(order)
    expect(ids.indexOf('check-premise')).toBeLessThan(ids.indexOf('dispatch-reviewers'))
    // A conflicting head goes back to the Developer before any CI wait; a mergeable one goes on to the CI read.
    const classify = (flow.steps as Array<{ id: string; decision?: Record<string, unknown> }>).find(
      (step) => step.id === 'classify-mergeability'
    )
    expect(classify?.decision).toMatchObject({
      examine: 'check-mergeability',
      ifTrue: 'develop',
      ifFalse: 'read-forge-ci'
    })
    expect(ids.indexOf('classify-mergeability')).toBe(ids.indexOf('check-mergeability') + 1)
    const plan = compileFlow(flow, 'Compile the Vinaya process')
    for (const id of order) expect(Object.keys(plan.graph.nodes)).toContain(id)
  })

  test('mergeability is read again before publication, and a conflicting head goes back to the Developer', () => {
    const loaded = loadProcess(resolve(import.meta.dir, '..'))
    const flow = camelize(parse(readFileSync(loaded.flowPath, 'utf8'))) as StepsFlow
    const steps = flow.steps as Array<{ id: string; decision?: Record<string, unknown> }>
    const ids = steps.map((step) => step.id)
    expect(ids.slice(-3)).toEqual([
      'check-publish-mergeability',
      'classify-publish-mergeability',
      'publish-ready-for-merge'
    ])
    expect(steps.find((step) => step.id === 'classify-live-result')?.decision).toMatchObject({
      ifFalse: 'check-publish-mergeability'
    })
    expect(steps.find((step) => step.id === 'classify-publish-mergeability')?.decision).toMatchObject({
      examine: 'check-publish-mergeability',
      ifTrue: 'develop',
      ifFalse: 'publish-ready-for-merge'
    })
  })
})

describe('version 2 flow (review locally, push once)', () => {
  const folder = resolve(import.meta.dir, '..')
  const loaded = loadProcess(folder, { flow: 'v2' })
  const flow = camelize(parse(readFileSync(loaded.flowPath, 'utf8'))) as StepsFlow
  const ids = (flow.steps as Array<{ id: string }>).map((step) => step.id)

  test('loads as v2 beside v1 and compiles into a graph', () => {
    expect(loaded.flowKey).toBe('v2')
    expect(loadProcess(folder).flowKey).toBe('v1')
    const plan = compileFlow(flow, 'Compile the Vinaya process, version 2')
    expect(() =>
      buildAgentSpawnStateGraph(plan, async () => ({}), { roles: {}, mechanicalActions: {} } as never)
    ).not.toThrow()
  })

  test('a local round reads no forge: no mergeability poll and no CI wait before the reviewers', () => {
    const reviewers = ids.indexOf('dispatch-reviewers')
    expect(ids.slice(0, reviewers)).not.toContain('read-forge-ci')
    expect(ids.slice(0, reviewers)).not.toContain('check-mergeability')
    expect(ids).not.toContain('read-forge-ci')
  })

  test('after the approval: ready push, then the pull request opens, then CI once, then publication', () => {
    const order = [
      'run-live-checks',
      'ready-push',
      'open-pull-request',
      'read-ci-once',
      'check-publish-mergeability',
      'publish-ready-for-merge'
    ]
    const positions = order.map((id) => ids.indexOf(id))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})
