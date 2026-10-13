import { describe, expect, it } from 'bun:test'
import { validatesJsonSchema } from '../../../src/lib/task-tools/result-proof.js'
import {
  AGENT_TOOL_CATALOG,
  DEV_TOOL_CATALOG,
  describeTool,
  serveTool
} from '../../../src/lib/task-tools/tool-catalog.js'
import { createDevToolsMcpServer, type DevToolContext } from '../../../src/lib/task-tools/dev-tools-server.js'

const required = [
  'name',
  'namespace',
  'version',
  'purpose',
  'realisticUsageExamples',
  'approvalRequirement',
  'limits',
  'selectionBoundary',
  'inputSchema',
  'successOutputSchema',
  'refusalSchema',
  'infrastructureErrorSchema',
  'requiredAuthority',
  'idempotencyAndReplay',
  'timeoutAndCancellation',
  'preconditions',
  'verifiedPostconditions',
  'redaction',
  'telemetryEvents',
  'annotations'
] as const

function assertStrict(schema: unknown): void {
  if (typeof schema !== 'object' || schema === null) return
  const value = schema as Record<string, unknown>
  if (value.type === 'object') expect(value.additionalProperties).toBe(false)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(assertStrict)
    else assertStrict(child)
  }
}

describe('canonical agent tool catalog', () => {
  it('carries every contract field for all seven Developer tools and planned read_source', () => {
    expect(AGENT_TOOL_CATALOG).toHaveLength(8)
    expect(DEV_TOOL_CATALOG).toHaveLength(7)
    expect(AGENT_TOOL_CATALOG.at(-1)?.name).toBe('read_source')
    for (const tool of AGENT_TOOL_CATALOG) for (const field of required) expect(tool[field]).toBeDefined()
  })

  it('uses strict input, success, refusal, and infrastructure-error schemas', () => {
    for (const tool of AGENT_TOOL_CATALOG) {
      for (const schema of [
        tool.inputSchema,
        tool.successOutputSchema,
        tool.refusalSchema,
        tool.infrastructureErrorSchema
      ])
        assertStrict(schema)
      expect(
        validatesJsonSchema(tool.inputSchema, { ...tool.realisticUsageExamples[0]?.input, unexpected: true })
      ).toBe(false)
    }
  })

  it('validates every realistic example against its tool input schema', () => {
    for (const tool of AGENT_TOOL_CATALOG)
      for (const example of tool.realisticUsageExamples)
        expect(validatesJsonSchema(tool.inputSchema, example.input)).toBe(true)
  })

  it('renders the served listing from catalog fields alone and does not serve read_source', async () => {
    const unavailable = async () =>
      ({ ok: false, error: { check: 'unused', output: 'unused', fix: 'unused' } }) as const
    const context = {
      publishChanges: unavailable,
      openPullRequest: unavailable,
      updatePullRequestBody: unavailable,
      refreshEvidence: unavailable,
      readPullRequest: unavailable,
      runChecks: unavailable,
      fetchDocumentation: unavailable
    } as unknown as DevToolContext
    const server = createDevToolsMcpServer({ serverVersion: 'test', context })
    const response = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))) as string
    )
    expect(response.result.tools).toEqual(DEV_TOOL_CATALOG.map(serveTool))
    expect(response.result.tools.some((tool: { name: string }) => tool.name === 'read_source')).toBe(false)
    for (const tool of DEV_TOOL_CATALOG) expect(describeTool(tool)).toContain(tool.selectionBoundary.whenNotToUse)
  })
})
