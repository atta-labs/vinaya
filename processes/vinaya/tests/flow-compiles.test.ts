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
    expect(Object.keys(plan.graph.nodes)).toHaveLength(18)
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
})
