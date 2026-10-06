/**
 * The driver-run `fetch_documentation` dev tool: a public https page fetched
 * from the driver, outside any sandbox, with the read recorded by the driver
 * and accepted by both agents' Documentation Stop hooks.
 *
 * The network is faked at the module's two seams — name resolution and one
 * request to one validated address — so every check the tool runs (scheme,
 * address, redirect, content type, size, receipt) runs for real.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  codexDocumentationStopHookScript,
  DOCUMENTATION_READ_MIN_SIZE as DISPATCH_MIN_SIZE,
  documentationStopHookScript,
  writeCodexHookFiles
} from '../../../src/lib/dispatch.js'
import { createDeveloperDevToolContext } from '../../../src/lib/task-tools/developer-dev-tools-context.js'
import {
  createDevToolsMcpServer,
  DEV_TOOL_CATALOG,
  DEV_TOOL_NAMES
} from '../../../src/lib/task-tools/dev-tools-server.js'
import {
  buildRequest,
  createFetchDocumentationTool,
  DOCUMENTATION_READ_MIN_SIZE,
  documentationReceiptsPath,
  documentationSourceId,
  FETCH_DOCUMENTATION_MAX_BYTES,
  FETCH_DOCUMENTATION_PAGE_CHARS,
  FETCH_DOCUMENTATION_TOOL,
  type FetchDocumentationDeps,
  type FetchTarget,
  FetchTransportError,
  isPublicAddress,
  parseHttpResponse,
  type RawResponse,
  type ResolvedAddress,
  UNTRUSTED_PAGE_NOTICE
} from '../../../src/lib/task-tools/fetch-documentation.js'
import {
  buildCodexSandboxConfigToml,
  DOCUMENTATION_HOSTS,
  protectedPathsForTurn,
  startTurnWriteAttribution,
  taskControlDir
} from '../../../src/lib/worker-boundary.js'
import {
  cleanupWorlds,
  controlDir,
  developerPublishesViaToolsDeps,
  makeWorld,
  runLoopInProcess
} from '../dev-review-loop-harness.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture'

const tempDirs: string[] = []
afterEach(() => {
  cleanupWorlds()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const PUBLIC_V4: ResolvedAddress = { address: '93.184.215.14', family: 4 }
const PAGE = `# Hooks\n\n${'Documentation text. '.repeat(200)}`

type Route = { status: number; headers?: Record<string, string>; body?: string }

/** A fake network: DNS answers per host (a list consumed one answer per lookup), and responses per `https://host/path`. */
function fakeNetwork(opts: {
  dns: Record<string, ResolvedAddress[][]>
  routes: Record<string, Route | FetchTransportError>
}): { deps: FetchDocumentationDeps; requests: FetchTarget[]; lookups: string[] } {
  const requests: FetchTarget[] = []
  const lookups: string[] = []
  const answered: Record<string, number> = {}
  const deps: FetchDocumentationDeps = {
    resolve: async (hostname) => {
      lookups.push(hostname)
      const answers = opts.dns[hostname]
      if (!answers) throw new Error(`ENOTFOUND ${hostname}`)
      const index = Math.min(answered[hostname] ?? 0, answers.length - 1)
      answered[hostname] = (answered[hostname] ?? 0) + 1
      return answers[index] ?? []
    },
    request: async (target) => {
      requests.push(target)
      const route = opts.routes[`https://${target.hostname}${target.path}`]
      if (!route) throw new FetchTransportError('connection-failed', 'no route')
      if (route instanceof FetchTransportError) throw route
      const body = new TextEncoder().encode(route.body ?? '')
      const response: RawResponse = { status: route.status, headers: route.headers ?? {}, body }
      return response
    },
    now: () => new Date('2026-10-06T00:00:00.000Z')
  }
  return { deps, requests, lookups }
}

function tool(network: ReturnType<typeof fakeNetwork>, receiptsPath: string) {
  return createFetchDocumentationTool({ receiptsPath, deps: network.deps })
}

function receipts(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

const html = { 'content-type': 'text/html; charset=utf-8' }

describe('O1: a seventh dev tool both agents call through the dev-tools server', () => {
  it('the catalog lists fetch_documentation with an input and an output schema', () => {
    expect(DEV_TOOL_NAMES).toHaveLength(7)
    expect(DEV_TOOL_NAMES).toContain(FETCH_DOCUMENTATION_TOOL)
    const def = DEV_TOOL_CATALOG.find((d) => d.name === FETCH_DOCUMENTATION_TOOL)
    expect(def?.inputSchema).toMatchObject({ type: 'object', required: ['url'] })
    expect(def?.outputSchema).toMatchObject({ type: 'object' })
  })

  it('a tools/call over the MCP protocol reaches the driver-side fetch and returns the page text', async () => {
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4]] },
      routes: {
        'https://docs.example.com/hooks.md': { status: 200, headers: { 'content-type': 'text/markdown' }, body: PAGE }
      }
    })
    const receiptsPath = join(tempDir('fetch-doc-'), 'hooks', 'documentation-receipts.jsonl')
    const context = createDeveloperDevToolContext({
      readPublicationCheckInput: () => {
        throw new Error('unused')
      },
      commitAndPush: async () => ({ ok: true, result: { pushedHead: 'x' } }),
      validatePrBody: () => ({ ok: true }),
      openPullRequest: async () => ({ ok: true, result: { prNumber: 1 } }),
      updatePullRequestBody: async () => ({ ok: true, result: { prNumber: 1 } }),
      refreshEvidence: async () => ({ ok: true, result: { head: 'x', checksPassed: true, evidence: '' } }),
      readPullRequest: async () => ({
        ok: true,
        result: { prNumber: 1, state: 'OPEN', head: 'x', checks: null, reviews: null, body: '', failedChecks: [] }
      }),
      runChecks: async () => ({ ok: true, result: { passed: true, output: '' } }),
      fetchDocumentation: tool(network, receiptsPath)
    })
    const server = createDevToolsMcpServer({ serverVersion: '0.0.0-test', context })
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: FETCH_DOCUMENTATION_TOOL, arguments: { url: 'https://docs.example.com/hooks.md' } }
    })
    const parsed = JSON.parse((await server.handleLine(line)) as string)
    expect(parsed.result.isError).toBe(false)
    expect(parsed.result.structuredContent.text).toContain('# Hooks')
    expect(parsed.result.structuredContent.receipt).toEqual({ recorded: true })
  })

  it('a malformed argument is a tool-input refusal', async () => {
    const context = createDeveloperDevToolContext({
      readPublicationCheckInput: () => {
        throw new Error('unused')
      },
      commitAndPush: async () => ({ ok: true, result: { pushedHead: 'x' } }),
      validatePrBody: () => ({ ok: true }),
      openPullRequest: async () => ({ ok: true, result: { prNumber: 1 } }),
      updatePullRequestBody: async () => ({ ok: true, result: { prNumber: 1 } }),
      refreshEvidence: async () => ({ ok: true, result: { head: 'x', checksPassed: true, evidence: '' } }),
      readPullRequest: async () => ({
        ok: true,
        result: { prNumber: 1, state: 'OPEN', head: 'x', checks: null, reviews: null, body: '', failedChecks: [] }
      }),
      runChecks: async () => ({ ok: true, result: { passed: true, output: '' } })
    })
    const server = createDevToolsMcpServer({ serverVersion: '0.0.0-test', context })
    for (const args of [{}, { url: 'https://x.example.com', offset: -1 }]) {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: FETCH_DOCUMENTATION_TOOL, arguments: args }
      })
      const parsed = JSON.parse((await server.handleLine(line)) as string)
      expect(parsed.result.isError).toBe(true)
      expect(parsed.result.structuredContent.error.check).toBe('tool-input')
    }
  })

  it('follows a redirect to another public host and marks the returned text untrusted', async () => {
    const network = fakeNetwork({
      dns: { 'developers.openai.com': [[PUBLIC_V4]], 'learn.chatgpt.com': [[{ address: '104.18.1.1', family: 4 }]] },
      routes: {
        'https://developers.openai.com/codex/hooks': {
          status: 301,
          headers: { location: 'https://learn.chatgpt.com/docs/hooks.md' }
        },
        'https://learn.chatgpt.com/docs/hooks.md': { status: 200, headers: html, body: PAGE }
      }
    })
    const result = await tool(
      network,
      join(tempDir('fetch-doc-'), 'r.jsonl')
    )({ url: 'https://developers.openai.com/codex/hooks' })
    if (!result.ok) throw new Error(result.error.output)
    expect(result.result.finalUrl).toBe('https://learn.chatgpt.com/docs/hooks.md')
    expect(result.result.untrusted).toBe(true)
    expect(result.result.notice).toBe(UNTRUSTED_PAGE_NOTICE)
    expect(network.lookups).toEqual(['developers.openai.com', 'learn.chatgpt.com'])
  })

  it('returns the text one bounded page at a time', async () => {
    const long = 'a'.repeat(FETCH_DOCUMENTATION_PAGE_CHARS + 10)
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4]] },
      routes: { 'https://docs.example.com/big': { status: 200, headers: html, body: long } }
    })
    const fetch = tool(network, join(tempDir('fetch-doc-'), 'r.jsonl'))
    const first = await fetch({ url: 'https://docs.example.com/big' })
    if (!first.ok) throw new Error(first.error.output)
    expect(first.result.text).toHaveLength(FETCH_DOCUMENTATION_PAGE_CHARS)
    expect(first.result.nextOffset).toBe(FETCH_DOCUMENTATION_PAGE_CHARS)
    const second = await fetch({ url: 'https://docs.example.com/big', offset: first.result.nextOffset ?? 0 })
    if (!second.ok) throw new Error(second.error.output)
    expect(second.result.text).toHaveLength(10)
    expect(second.result.nextOffset).toBeNull()
  })
})

describe('O4: refusals, each naming its reason', () => {
  const refusalCases: [string, string, Parameters<typeof fakeNetwork>[0], string][] = [
    ['a non-https URL', 'http://docs.example.com/a', { dns: {}, routes: {} }, 'not-https'],
    ['credentials in the URL', 'https://user:pw@docs.example.com/a', { dns: {}, routes: {} }, 'credentials-in-url'],
    ['a non-default port', 'https://docs.example.com:8443/a', { dns: {}, routes: {} }, 'disallowed-port'],
    ['a loopback literal', 'https://127.0.0.1/a', { dns: {}, routes: {} }, 'private-address'],
    ['an IPv6 loopback literal', 'https://[::1]/a', { dns: {}, routes: {} }, 'private-address'],
    ['the cloud metadata address', 'https://169.254.169.254/latest', { dns: {}, routes: {} }, 'private-address'],
    [
      'a host resolving to a private address',
      'https://intranet.example.com/a',
      { dns: { 'intranet.example.com': [[{ address: '10.1.2.3', family: 4 }]] }, routes: {} },
      'private-address'
    ],
    [
      'a host whose answers mix public and private',
      'https://mixed.example.com/a',
      {
        dns: {
          'mixed.example.com': [[PUBLIC_V4, { address: '192.168.1.10', family: 4 }]]
        },
        routes: {}
      },
      'private-address'
    ],
    [
      'a redirect to http',
      'https://docs.example.com/a',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]] },
        routes: { 'https://docs.example.com/a': { status: 302, headers: { location: 'http://docs.example.com/b' } } }
      },
      'redirect-not-https'
    ],
    [
      'a redirect to a private host',
      'https://docs.example.com/a',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]], 'internal.example.com': [[{ address: '172.16.0.5', family: 4 }]] },
        routes: {
          'https://docs.example.com/a': { status: 307, headers: { location: 'https://internal.example.com/secret' } }
        }
      },
      'private-address'
    ],
    [
      'a redirect to a metadata literal',
      'https://docs.example.com/a',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]] },
        routes: {
          'https://docs.example.com/a': { status: 302, headers: { location: 'https://[fd00:ec2::254]/latest' } }
        }
      },
      'private-address'
    ],
    [
      'a disallowed content type',
      'https://docs.example.com/a.png',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]] },
        routes: {
          'https://docs.example.com/a.png': { status: 200, headers: { 'content-type': 'image/png' }, body: PAGE }
        }
      },
      'disallowed-content-type'
    ],
    [
      'a response over the size cap',
      'https://docs.example.com/huge',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]] },
        routes: { 'https://docs.example.com/huge': new FetchTransportError('too-large', 'response body exceeds cap') }
      },
      'too-large'
    ],
    [
      'a redirect loop',
      'https://docs.example.com/loop',
      {
        dns: { 'docs.example.com': [[PUBLIC_V4]] },
        routes: { 'https://docs.example.com/loop': { status: 302, headers: { location: '/loop' } } }
      },
      'too-many-redirects'
    ]
  ]

  it.each(refusalCases)('refuses %s', async (_name, url, network, reason) => {
    const receiptsPath = join(tempDir('fetch-doc-'), 'r.jsonl')
    const result = await tool(fakeNetwork(network), receiptsPath)({ url })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.check).toBe(reason)
    expect(result.error.output.length).toBeGreaterThan(0)
    expect(result.error.fix.length).toBeGreaterThan(0)
    expect(receipts(receiptsPath)).toEqual([])
  })

  it('never connects for a refused address', async () => {
    const network = fakeNetwork({ dns: { 'intranet.example.com': [[{ address: '10.0.0.1', family: 4 }]] }, routes: {} })
    await tool(network, join(tempDir('fetch-doc-'), 'r.jsonl'))({ url: 'https://intranet.example.com/' })
    expect(network.requests).toEqual([])
  })

  it('connects only to the address it validated — one lookup per hop, never a second answer', async () => {
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4], [{ address: '127.0.0.1', family: 4 }]] },
      routes: { 'https://docs.example.com/a': { status: 200, headers: html, body: PAGE } }
    })
    const result = await tool(network, join(tempDir('fetch-doc-'), 'r.jsonl'))({ url: 'https://docs.example.com/a' })
    expect(result.ok).toBe(true)
    expect(network.lookups).toEqual(['docs.example.com'])
    expect(network.requests.map((r) => [r.address, r.hostname])).toEqual([[PUBLIC_V4.address, 'docs.example.com']])
  })

  it('sends no cookie, token or authorization header', () => {
    const request = buildRequest({
      address: PUBLIC_V4.address,
      family: 4,
      hostname: 'docs.example.com',
      port: 443,
      path: '/a'
    })
    expect(request).toMatch(/^GET \/a HTTP\/1\.1\r\nHost: docs\.example\.com\r\n/)
    expect(request.toLowerCase()).not.toMatch(/cookie|authorization|token/)
  })

  it.each([
    ['127.0.0.1', false],
    ['10.0.0.1', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['172.31.255.255', false],
    ['192.168.0.1', false],
    ['0.0.0.0', false],
    ['224.0.0.1', false],
    ['::', false],
    ['::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:10.0.0.1', false],
    ['64:ff9b::a00:1', false],
    ['fe80::1', false],
    ['fd00:ec2::254', false],
    ['fc00::1', false],
    ['ff02::1', false],
    ['2002:7f00:1::', false],
    ['93.184.215.14', true],
    ['8.8.8.8', true],
    ['::ffff:8.8.8.8', true],
    ['2606:4700::6810:84e5', true],
    ['not-an-ip', false]
  ])('isPublicAddress(%s) is %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })

  it('parses a chunked body and refuses one whose declared length exceeds the cap', () => {
    const chunked = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'
    )
    const parsed = parseHttpResponse(chunked, FETCH_DOCUMENTATION_MAX_BYTES)
    expect(parsed.status).toBe(200)
    expect(new TextDecoder().decode(parsed.body)).toBe('hello world')
    const declared = new TextEncoder().encode(
      `HTTP/1.1 200 OK\r\nContent-Length: ${FETCH_DOCUMENTATION_MAX_BYTES + 1}\r\n\r\n`
    )
    expect(() => parseHttpResponse(declared, FETCH_DOCUMENTATION_MAX_BYTES)).toThrow(FetchTransportError)
  })
})

describe('O2: the driver records a receipt only for a counted read', () => {
  it('uses the same minimum size the WebFetch read check uses', () => {
    expect(DOCUMENTATION_READ_MIN_SIZE).toBe(DISPATCH_MIN_SIZE)
  })

  it('records source identity, final URL, content type, size and digest for a counted read', async () => {
    const receiptsPath = join(tempDir('fetch-doc-'), 'hooks', 'documentation-receipts.jsonl')
    const network = fakeNetwork({
      dns: { 'developers.openai.com': [[PUBLIC_V4]], 'learn.chatgpt.com': [[{ address: '104.18.1.1', family: 4 }]] },
      routes: {
        'https://developers.openai.com/codex/hooks/': {
          status: 308,
          headers: { location: 'https://learn.chatgpt.com/docs/hooks.md' }
        },
        'https://learn.chatgpt.com/docs/hooks.md': {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
          body: PAGE
        }
      }
    })
    const result = await tool(
      network,
      receiptsPath
    )({ url: 'https://developers.openai.com/codex/hooks/#tool-coverage' })
    expect(result.ok).toBe(true)
    const [receipt] = receipts(receiptsPath)
    expect(receipt).toMatchObject({
      source: 'https://developers.openai.com/codex/hooks',
      requestedUrl: 'https://developers.openai.com/codex/hooks/#tool-coverage',
      finalUrl: 'https://learn.chatgpt.com/docs/hooks.md',
      status: 200,
      contentType: 'text/markdown',
      size: new TextEncoder().encode(PAGE).length,
      tool: FETCH_DOCUMENTATION_TOOL
    })
    expect(receipt?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['an error status', { status: 404, headers: html, body: PAGE }, 'HTTP 404'],
    ['a near-empty page', { status: 200, headers: html, body: 'tiny' }, 'only 4 bytes']
  ])('records no receipt for %s, and says why', async (_name, route, reason) => {
    const receiptsPath = join(tempDir('fetch-doc-'), 'r.jsonl')
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4]] },
      routes: { 'https://docs.example.com/a': route }
    })
    const result = await tool(network, receiptsPath)({ url: 'https://docs.example.com/a' })
    if (!result.ok) throw new Error(result.error.output)
    expect(result.result.receipt).toMatchObject({ recorded: false })
    expect(JSON.stringify(result.result.receipt)).toContain(reason)
    expect(receipts(receiptsPath)).toEqual([])
  })
})

describe('O3: both agents’ Stop hooks accept the driver’s receipts', () => {
  const RUN_ID = 'run-receipt'
  const SOURCE = 'https://learn.chatgpt.com/docs/hooks.md'

  function hooksArea(): string {
    const hooks = join(tempDir('fetch-doc-hooks-'), 'hooks')
    mkdirSync(hooks, { recursive: true })
    return hooks
  }

  const runStop = (script: string) =>
    spawnSyncBudgeted('bun', [script], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      env: { ...stripVinayaEnv(), VINAYA_RUN_ID: RUN_ID },
      encoding: 'utf8'
    })

  function writeReceipt(hooks: string): void {
    writeFileSync(
      documentationReceiptsPath(hooks),
      `${JSON.stringify({ source: documentationSourceId(SOURCE), finalUrl: SOURCE, tool: FETCH_DOCUMENTATION_TOOL })}\n`
    )
  }

  it('Claude: a source with no read blocks the Stop; the driver’s receipt clears it', () => {
    const hooks = hooksArea()
    const dir = join(hooks, 'developer')
    mkdirSync(dir)
    writeFileSync(
      join(dir, `documentation-sources-${RUN_ID}.json`),
      JSON.stringify([{ source: SOURCE, mechanism: 'hooks', objectiveIds: [] }])
    )
    const script = join(dir, 'stop.mjs')
    writeFileSync(script, documentationStopHookScript(dir))
    const blocked = runStop(script)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain(FETCH_DOCUMENTATION_TOOL)
    writeReceipt(hooks)
    expect(runStop(script).status).toBe(0)
  })

  it('Codex: the receipt satisfies the Stop hook with no curl at all', () => {
    const hooks = hooksArea()
    const dir = join(hooks, 'developer', 'codex')
    writeCodexHookFiles(dir, RUN_ID, [{ source: SOURCE, mechanism: 'hooks', objectiveIds: [] }])
    const script = join(dir, 'documentation-stop.mjs')
    expect(readFileSync(script, 'utf8')).toBe(codexDocumentationStopHookScript(dir))
    const blocked = JSON.parse(runStop(script).stdout.trim())
    expect(blocked.decision).toBe('block')
    expect(blocked.reason).toContain(FETCH_DOCUMENTATION_TOOL)
    writeReceipt(hooks)
    expect(runStop(script).stdout.trim()).toBe('')
  })

  it('Codex’s sandbox network allowlist gains no documentation host', () => {
    expect(DOCUMENTATION_HOSTS).toEqual([
      'developers.openai.com',
      'platform.openai.com',
      'docs.anthropic.com',
      'code.claude.com'
    ])
    const toml = buildCodexSandboxConfigToml({
      role: 'developer',
      agent: 'codex',
      worktreeDir: '/w',
      scratchDir: '/s',
      allowedHosts: ['github.com']
    })
    expect(toml).not.toContain('learn.chatgpt.com')
  })
})

describe('O5: the driver’s own documentation writes are never the Developer’s', () => {
  function taskRuntime(): { root: string; hooks: string } {
    const root = tempDir('fetch-doc-runtime-')
    const hooks = join(root, 'tasks-execution', '7', 'hooks')
    mkdirSync(hooks, { recursive: true })
    mkdirSync(taskControlDir(root, 7), { recursive: true })
    return { root, hooks }
  }

  it('a receipt the tool writes inside its driver tool call is attributed to the driver', async () => {
    const { root, hooks } = taskRuntime()
    const receiptsPath = documentationReceiptsPath(hooks)
    const entries = protectedPathsForTurn({
      runtimeDir: root,
      task: 7,
      round: 1,
      role: 'developer',
      vinayaConfigPath: null
    })
    expect(entries.map((e) => e.path)).toContain(receiptsPath)
    const attribution = startTurnWriteAttribution(entries, [taskControlDir(root, 7), receiptsPath])
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4]] },
      routes: { 'https://docs.example.com/a': { status: 200, headers: html, body: PAGE } }
    })
    const result = await attribution.driverToolCall(() =>
      tool(network, receiptsPath)({ url: 'https://docs.example.com/a' })
    )
    expect(result.ok).toBe(true)
    expect(receipts(receiptsPath)).toHaveLength(1)
    expect(attribution.changedPaths()).toEqual([])
  })

  it('a receipt written outside any tool call is reported as the worker’s', async () => {
    const { root, hooks } = taskRuntime()
    const receiptsPath = documentationReceiptsPath(hooks)
    const entries = protectedPathsForTurn({
      runtimeDir: root,
      task: 7,
      round: 1,
      role: 'developer',
      vinayaConfigPath: null
    })
    const attribution = startTurnWriteAttribution(entries, [taskControlDir(root, 7), receiptsPath])
    writeFileSync(receiptsPath, '{"source":"https://forged.example.com"}\n')
    expect(attribution.changedPaths()).toEqual([receiptsPath])
  })

  it('the loop serves the tool through the driver: its receipt raises no after-turn reask', async () => {
    const world = makeWorld({ worktreeExists: true })
    const publishing = developerPublishesViaToolsDeps(world)
    const network = fakeNetwork({
      dns: { 'docs.example.com': [[PUBLIC_V4]] },
      routes: { 'https://docs.example.com/a': { status: 200, headers: html, body: PAGE } }
    })
    let fetched: unknown = null
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'codex' },
      {
        ...publishing,
        fetchDocumentationDeps: network.deps,
        dispatchRole: async (role, agent, prompt, opts) => {
          if (role === 'developer' && fetched === null) {
            fetched = await world.devToolContext!.fetchDocumentation({ url: 'https://docs.example.com/a' })
          }
          return publishing.dispatchRole!(role, agent, prompt, opts)
        }
      }
    )
    expect(fetched).toMatchObject({ ok: true, result: { receipt: { recorded: true } } })
    expect(receipts(documentationReceiptsPath(join(dirname(controlDir(world)), 'hooks')))).toHaveLength(1)
    const reasks = world.dispatches.filter((d) =>
      (d.prompt ?? '').includes('protected path(s) changed during this turn')
    )
    expect(reasks).toHaveLength(0)
    expect(result.finalDecision).toEqual({ type: 'publish' })
  })

  it('a later Codex dispatch with no Documentation section leaves the sources manifest untouched', () => {
    const { root, hooks } = taskRuntime()
    const dir = join(hooks, 'developer', 'codex')
    writeCodexHookFiles(dir, 'run-1', [{ source: 'https://docs.example.com/a', mechanism: 'm', objectiveIds: [] }])
    const entries = protectedPathsForTurn({
      runtimeDir: root,
      task: 7,
      round: 2,
      role: 'developer',
      vinayaConfigPath: null
    })
    const manifest = join(dir, 'documentation-sources-run-1.json')
    expect(entries.map((e) => e.path)).toContain(manifest)
    const attribution = startTurnWriteAttribution(entries, [taskControlDir(root, 7)])
    writeCodexHookFiles(dir, 'run-1', [])
    expect(attribution.changedPaths()).toEqual([])
  })
})

describe('O6: the handler, contract and receipt live in their own module', () => {
  it('imports nothing from the loop driver or the dispatch module', () => {
    const source = readFileSync(
      join(dirname(import.meta.path), '../../../src/lib/task-tools/fetch-documentation.ts'),
      'utf8'
    )
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports.filter((s) => /dev-review-loop|dispatch/.test(s ?? ''))).toEqual([])
  })

  it('keys a receipt by the source’s normalized URL, never a section name', () => {
    expect(documentationSourceId(' https://docs.example.com/a/#part ')).toBe('https://docs.example.com/a')
  })
})
