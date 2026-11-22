import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'

const temp = mkdtempSync(join(tmpdir(), 'log-sdk-bounded-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function open(events?: Record<string, { fields: Record<string, 'text' | 'number'> }>) {
  const folder = mkdtempSync(join(temp, 'logs-'))
  const errors: unknown[] = []
  const handle = connect({
    runId: 'run-1',
    repository: 'acme/widgets',
    repoRoot: '/nonexistent-log-sdk-test-root',
    runtimeDir: mkdtempSync(join(temp, 'rt-')),
    destination: { folder, ...(events === undefined ? {} : { events }) },
    onError: (e) => errors.push(e)
  } as Parameters<typeof connect>[0])
  return { handle, folder, errors }
}

/** Every string attribute value named `key` in the run's local copy. */
function copied(folder: string, key: string): string[] {
  const out: string[] = []
  const seek = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(seek)
    else if (node !== null && typeof node === 'object') {
      const o = node as { key?: string; value?: { stringValue?: string } }
      if (o.key === key && o.value?.stringValue !== undefined) out.push(o.value.stringValue)
      Object.values(node).forEach(seek)
    }
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else
        for (const line of readFileSync(join(dir, entry.name), 'utf8').split('\n')) {
          if (line.trim() !== '') seek(JSON.parse(line))
        }
    }
  }
  walk(folder)
  return out
}

test('a long why and a long first error line are written 500 characters long, ending in …', async () => {
  const { handle, folder, errors } = open()
  handle.run.started()
  handle.run.paused({ why: 'w'.repeat(100_000) })
  handle.agent.sent({ seat: 'developer' })
  const step = handle.agent.stepStarted({ tool: 'Bash' })
  handle.agent.stepEnded(step, { errorType: 'failed', errorLine: 'e'.repeat(100_000) })
  await handle.shutdown()
  expect(errors).toEqual([])
  const whys = copied(folder, 'vinaya.pause.why')
  const lines = copied(folder, 'vinaya.step.error_line')
  expect(whys.length).toBeGreaterThan(0)
  expect(lines.length).toBeGreaterThan(0)
  for (const v of [...whys, ...lines]) {
    expect(v).toHaveLength(500)
    expect(v.endsWith('…')).toBe(true)
  }
})

test('a 500-character value is written unchanged', async () => {
  const { handle, folder, errors } = open()
  handle.run.started()
  handle.run.paused({ why: 'w'.repeat(500) })
  await handle.shutdown()
  expect(errors).toEqual([])
  const whys = copied(folder, 'vinaya.pause.why')
  expect(whys.length).toBeGreaterThan(0)
  for (const v of whys) expect(v).toBe('w'.repeat(500))
})

test('a cut never splits a surrogate pair', async () => {
  const { handle, folder } = open()
  handle.run.started()
  handle.run.paused({ why: `${'a'.repeat(498)}😀${'b'.repeat(50)}` })
  await handle.shutdown()
  const whys = copied(folder, 'vinaya.pause.why')
  expect(whys.length).toBeGreaterThan(0)
  for (const v of whys) {
    expect(v).toBe(`${'a'.repeat(498)}…`)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v)).toBe(false)
  }
})

test('a custom text field over 500 characters is still refused with too_long, not cut', async () => {
  const { handle, folder, errors } = open({ 'team.checked': { fields: { path: 'text' } } })
  handle.custom.recorded('team.checked', { path: 'x'.repeat(501) })
  handle.custom.recorded('team.checked', { path: 'y'.repeat(500) })
  await handle.shutdown()
  expect(errors.map(String)).toEqual(['Error: custom event refused (too_long) [path]'])
  expect(copied(folder, 'path')).toEqual(['y'.repeat(500)])
})
