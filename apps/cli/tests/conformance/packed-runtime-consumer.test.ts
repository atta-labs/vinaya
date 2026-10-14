import { describe, expect, it } from 'bun:test'
import { buildStateGraph, type NodeExecutor } from '@atta/adapter-langgraph'
import { compileFlow, type StepsFlow } from '@atta/engine'

describe('the packed Atta runtime public consumer boundary', () => {
  it('compiles a steps Flow and accepts the consumer supplied executor', async () => {
    const flow: StepsFlow = {
      schemaVersion: '2.0',
      id: 'vinaya-packed-consumer',
      displayName: 'Vinaya packed consumer',
      description: 'Exercises the packed public compiler and graph builder.',
      experimental: true,
      benchmarked: false,
      defaults: { model: 'consumer-supplied' },
      agents: [{ role: 'developer' }],
      steps: [
        {
          id: 'develop',
          type: 'agent',
          role: 'developer',
          promptTemplate: 'Implement the prepared task.',
          permission: 'workspace-write',
          workingDirectory: '.',
          maxTurns: 1
        }
      ]
    }
    const plan = compileFlow(flow, 'Verify the packed boundary')
    const executed: string[] = []
    const executor: NodeExecutor = async (_state, { node }) => {
      executed.push(node.id)
      return { executionOrder: [node.id] }
    }

    const graph = buildStateGraph(plan, executor)
    await graph.invoke({ question: plan.question, customVars: {}, outputs: {}, executionOrder: [] })

    expect(plan.graph.entryNode).toBe('develop')
    expect(executed).toEqual(['develop'])
  })
})
