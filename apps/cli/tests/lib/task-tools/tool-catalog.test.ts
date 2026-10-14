import { describe, expect, it } from 'bun:test'
import { validatesJsonSchema } from '../../../src/lib/task-tools/result-proof.js'
import {
  AGENT_TOOL_CATALOG,
  DEV_TOOL_CATALOG,
  describeTool,
  serveTool,
  TOOL_ERROR_FIELDS_SCHEMA,
  TOOL_INFRASTRUCTURE_ERROR_SCHEMA,
  TOOL_REFUSAL_SCHEMA
} from '../../../src/lib/task-tools/tool-catalog.js'
import { createDevToolsMcpServer, type DevToolContext } from '../../../src/lib/task-tools/dev-tools-server.js'
import { projectPrChecks, projectPrReviews } from '../../../src/lib/dev-review-loop.js'

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
  expect(typeof schema).toBe('object')
  expect(schema).not.toBeNull()
  const value = schema as Record<string, unknown>
  if (value.type === 'object') expect(value.additionalProperties).toBe(false)
  expect(
    'type' in value || 'anyOf' in value || 'oneOf' in value || 'allOf' in value || '$ref' in value || 'const' in value
  ).toBe(true)
  if (typeof value.properties === 'object' && value.properties !== null)
    Object.values(value.properties).forEach(assertStrict)
  if (value.items !== undefined) assertStrict(value.items)
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const)
    if (Array.isArray(value[keyword])) value[keyword].forEach(assertStrict)
}

describe('canonical agent tool catalog', () => {
  it('carries every contract field for all seven Developer tools and the reviewers’ read_source', () => {
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
      expect(validatesJsonSchema(tool.successOutputSchema, { unexpected: true })).toBe(false)
    }
  })

  it('shares one definition of the three independent error axes', () => {
    const fields = TOOL_ERROR_FIELDS_SCHEMA.properties
    const refusal = TOOL_REFUSAL_SCHEMA.properties
    for (const key of TOOL_ERROR_FIELDS_SCHEMA.required) expect(refusal[key]).toBe(fields[key])
    expect(TOOL_INFRASTRUCTURE_ERROR_SCHEMA).toBe(TOOL_REFUSAL_SCHEMA)
    for (const tool of AGENT_TOOL_CATALOG) {
      expect(tool.refusalSchema).toBe(TOOL_REFUSAL_SCHEMA)
      expect(tool.infrastructureErrorSchema).toBe(TOOL_INFRASTRUCTURE_ERROR_SCHEMA)
    }
  })

  it('states unenforced limits and cancellation behavior without promising them', () => {
    for (const tool of AGENT_TOOL_CATALOG.filter(
      (entry) => entry.name !== 'fetch_documentation' && entry.name !== 'read_source'
    )) {
      expect(tool.limits.inputTokens).toBeNull()
      expect(tool.limits.outputTokens).toBeNull()
      expect(tool.limits.inputBytes).toBeNull()
      expect(tool.limits.outputBytes).toBeNull()
      expect(tool.limits.behavior).toContain('No tool-level')
      expect(tool.timeoutAndCancellation).toContain('ignores cancellation notifications')
    }
    const fetch = AGENT_TOOL_CATALOG.find((tool) => tool.name === 'fetch_documentation')
    expect(fetch?.limits.behavior).toContain('5 MiB')
    expect(fetch?.timeoutAndCancellation).toContain('30-second')
    const readSource = AGENT_TOOL_CATALOG.find((tool) => tool.name === 'read_source')
    expect(readSource?.limits.outputBytes).toBe(48_000)
    expect(readSource?.limits.behavior).toContain('48,000 bytes')
  })

  it('refuses unknown properties inside read_pull_request checks and reviews', () => {
    const schema = AGENT_TOOL_CATALOG.find((tool) => tool.name === 'read_pull_request')?.successOutputSchema
    expect(schema).toBeDefined()
    const base = {
      prNumber: 42,
      state: 'OPEN',
      head: 'abc123',
      checks: [],
      reviews: [],
      body: 'report',
      failedChecks: []
    }
    expect(validatesJsonSchema(schema, base)).toBe(true)
    expect(validatesJsonSchema(schema, { ...base, checks: [{ __typename: 'CheckRun', surprise: true }] })).toBe(false)
    expect(
      validatesJsonSchema(schema, {
        ...base,
        reviews: [{ author: { login: 'reviewer', surprise: true }, body: '', id: 'R1', state: 'APPROVED' }]
      })
    ).toBe(false)
  })

  it('projects GitHub pull-request checks and reviews onto the read_pull_request schema', () => {
    const schema = AGENT_TOOL_CATALOG.find((tool) => tool.name === 'read_pull_request')?.successOutputSchema
    const checks = projectPrChecks([
      {
        __typename: 'CheckRun',
        completedAt: '2026-10-14T00:00:00Z',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
        name: 'check',
        startedAt: '2026-10-14T00:00:00Z',
        status: 'COMPLETED',
        workflowName: 'CI',
        checkSuite: { id: 'CS1' }
      },
      {
        __typename: 'StatusContext',
        context: 'ci/legacy',
        state: 'SUCCESS',
        targetUrl: null,
        isRequired: true
      },
      { name: 'no typename' },
      'junk'
    ])
    const reviews = projectPrReviews([
      {
        id: 'PRR_1',
        author: { login: 'reviewer', name: 'Reviewer' },
        authorAssociation: 'MEMBER',
        body: 'looks good',
        submittedAt: '2026-10-14T00:00:00Z',
        includesCreatedEdit: false,
        reactionGroups: [],
        state: 'APPROVED',
        commit: { oid: 'abc123' }
      },
      { id: 'PRR_2', author: null, body: '', state: 'COMMENTED' },
      { id: 'PRR_3', body: 'missing state' }
    ])
    expect(checks).toEqual([
      {
        __typename: 'CheckRun',
        completedAt: '2026-10-14T00:00:00Z',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/2',
        name: 'check',
        startedAt: '2026-10-14T00:00:00Z',
        status: 'COMPLETED',
        workflowName: 'CI'
      },
      {
        __typename: 'StatusContext',
        context: 'ci/legacy',
        state: 'SUCCESS',
        targetUrl: null
      }
    ])
    expect(reviews).toEqual([
      {
        author: { login: 'reviewer' },
        authorAssociation: 'MEMBER',
        body: 'looks good',
        commit: 'abc123',
        id: 'PRR_1',
        includesCreatedEdit: false,
        state: 'APPROVED',
        submittedAt: '2026-10-14T00:00:00Z'
      },
      { author: null, body: '', id: 'PRR_2', state: 'COMMENTED' }
    ])
    expect(projectPrChecks(null)).toBeNull()
    expect(projectPrReviews(undefined)).toBeNull()
    expect(
      validatesJsonSchema(schema, {
        prNumber: 42,
        state: 'OPEN',
        head: 'abc123',
        checks,
        reviews,
        body: 'report',
        failedChecks: []
      })
    ).toBe(true)
  })

  it('validates every realistic example against its tool input schema', () => {
    for (const tool of AGENT_TOOL_CATALOG)
      for (const example of tool.realisticUsageExamples)
        expect(validatesJsonSchema(tool.inputSchema, example.input)).toBe(true)
  })

  it('renders the Developer’s served listing from catalog fields alone, without the reviewers’ read_source', async () => {
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
    const server = createDevToolsMcpServer({ serverVersion: 'test', context, role: 'developer' })
    const response = JSON.parse(
      (await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))) as string
    )
    expect(response.result.tools).toEqual(DEV_TOOL_CATALOG.map(serveTool))
    expect(response.result.tools.some((tool: { name: string }) => tool.name === 'read_source')).toBe(false)
    for (const tool of DEV_TOOL_CATALOG) expect(describeTool(tool)).toContain(tool.selectionBoundary.whenNotToUse)
  })
})
