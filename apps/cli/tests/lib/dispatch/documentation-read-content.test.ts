import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture'
import {
  DOCUMENTATION_READ_MIN_SIZE,
  documentationLogHookScript,
  documentationStopHookScript
} from '../../../src/lib/dispatch'

const RUN_ID = 'run-1'
const SOURCE = 'https://code.claude.com/docs/en/hooks'
const body = (n: number) => 'x'.repeat(n)

/** WebFetch PostToolUse payload as the hooks reference documents it: `status`, `code`, final `url`, `bytes`/`size`, `result`. */
function payload(response: Record<string, unknown>, url = SOURCE) {
  return JSON.stringify({ tool_name: 'WebFetch', tool_input: { url, prompt: 'p' }, tool_response: response })
}

describe('documentation read counts only a fetch that returned real content', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-read-'))
    writeFileSync(
      join(dir, `documentation-sources-${RUN_ID}.json`),
      JSON.stringify([{ source: SOURCE, mechanism: 'PostToolUse payload' }])
    )
    writeFileSync(join(dir, 'log.mjs'), documentationLogHookScript(dir))
    writeFileSync(join(dir, 'stop.mjs'), documentationStopHookScript(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const run = (script: string, input: string) =>
    spawnSyncBudgeted('bun', [join(dir, script)], {
      input,
      env: { ...stripVinayaEnv(), VINAYA_RUN_ID: RUN_ID },
      encoding: 'utf8'
    })
  const stop = () => run('stop.mjs', JSON.stringify({ hook_event_name: 'Stop' }))

  it('records status, final URL and size', () => {
    run('log.mjs', payload({ status: 200, code: '200', url: SOURCE, bytes: 4096, size: 4096, result: body(10) }))
    const line = JSON.parse(readFileSync(join(dir, `documentation-log-${RUN_ID}.jsonl`), 'utf8').trim())
    expect(line).toEqual({ url: SOURCE, finalUrl: SOURCE, status: 200, size: 4096 })
  })

  it('counts a successful same-host fetch above the minimum size', () => {
    run('log.mjs', payload({ status: 200, url: SOURCE, bytes: DOCUMENTATION_READ_MIN_SIZE, result: body(5) }))
    expect(stop().status).toBe(0)
  })

  it.each([
    ['an error status', { status: 404, url: SOURCE, bytes: 9000 }, 'HTTP 404'],
    [
      'a redirect to another host',
      { status: 200, url: 'https://linear.app/login', bytes: 9000 },
      'another host (linear.app'
    ],
    ['a near-empty page', { status: 200, url: SOURCE, bytes: 12 }, 'only 12 bytes'],
    ['a response with no status', { url: SOURCE, bytes: 9000 }, 'no HTTP status']
  ])('refuses %s, naming the source and the reason', (_name, response, reason) => {
    run('log.mjs', payload(response))
    const out = stop()
    expect(out.status).toBe(2)
    expect(out.stderr).toContain(SOURCE)
    expect(out.stderr).toContain(reason)
  })

  it('refuses a source never fetched', () => {
    const out = stop()
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('never fetched')
  })

  it('counts the source once any one fetch of it was good', () => {
    run('log.mjs', payload({ status: 200, url: 'https://linear.app/login', bytes: 9000 }))
    run('log.mjs', payload({ status: 200, url: SOURCE, bytes: 9000 }))
    expect(stop().status).toBe(0)
  })
})
