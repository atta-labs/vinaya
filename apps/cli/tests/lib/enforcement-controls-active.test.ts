import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentDispatchControls,
  describeInactiveControls,
  enforcementControlsActive,
  localGateControl
} from '../../src/lib/enforcement-controls.js'
import { checkTaskDispatchReadiness } from '../../src/lib/dev-review-loop/developer-dispatch.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'enforcement-controls-'))
  roots.push(root)
  return root
}

function writeHooks(root: string, mode = 0o755, names: string[] = ['pre-commit', 'pre-push']): void {
  mkdirSync(join(root, '.vinaya', 'hooks'), { recursive: true })
  for (const n of names) {
    const p = join(root, '.vinaya', 'hooks', n)
    writeFileSync(p, '#!/bin/sh\nexit 0\n')
    chmodSync(p, mode)
  }
}

describe('local gate control', () => {
  it('is active when routing is the tracked directory and the required hooks are executable', () => {
    const root = tempRepo()
    writeHooks(root)
    expect(localGateControl(root, '.vinaya/hooks', '.vinaya/hooks').active).toBe(true)
  })

  it('is inactive, with the doctor remedy, when routing is not set', () => {
    const root = tempRepo()
    writeHooks(root)
    const c = localGateControl(root, '.vinaya/hooks', null)
    expect(c.active).toBe(false)
    expect(c.remedy).toContain('git config core.hooksPath .vinaya/hooks')
  })

  it('is inactive when routing points at a directory that does not exist', () => {
    const root = tempRepo()
    const c = localGateControl(root, '.vinaya/hooks', '.vinaya/hooks')
    expect(c.active).toBe(false)
    expect(c.detail).toContain('does not exist')
  })

  it('is inactive when a required hook is missing', () => {
    const root = tempRepo()
    writeHooks(root, 0o755, ['pre-commit'])
    const c = localGateControl(root, '.vinaya/hooks', '.vinaya/hooks')
    expect(c.active).toBe(false)
    expect(c.detail).toContain('missing: .vinaya/hooks/pre-push')
  })

  it('is inactive when a required hook is not executable', () => {
    const root = tempRepo()
    writeHooks(root, 0o644)
    const c = localGateControl(root, '.vinaya/hooks', '.vinaya/hooks')
    expect(c.active).toBe(false)
    expect(c.detail).toContain('not executable')
    expect(c.remedy).toContain('chmod +x')
  })
})

describe('agent controls', () => {
  it('claude settings with a readable hook script are active', () => {
    const root = tempRepo()
    const script = join(root, 'hook.mjs')
    const settings = join(root, 'settings.json')
    writeFileSync(script, '')
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `bun "${script}"` }] }] } })
    )
    expect(agentDispatchControls('claude', { claudeSettingsPath: settings, codexHooksPath: null })[0]?.active).toBe(
      true
    )
  })

  it('claude settings that failed to write are inactive', () => {
    const [c] = agentDispatchControls('claude', { claudeSettingsPath: null, codexHooksPath: null })
    expect(c?.active).toBe(false)
  })

  it('codex hooks naming a missing script are inactive', () => {
    const root = tempRepo()
    const hooks = join(root, 'hooks.json')
    writeFileSync(
      hooks,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `bun "${join(root, 'gone.mjs')}"` }] }] }
      })
    )
    const [c] = agentDispatchControls('codex', { claudeSettingsPath: null, codexHooksPath: hooks })
    expect(c?.active).toBe(false)
    expect(c?.detail).toContain('gone.mjs')
  })

  it('a vendor without per-dispatch hooks carries no control', () => {
    expect(agentDispatchControls('gemini', { claudeSettingsPath: null, codexHooksPath: null })).toEqual([])
  })
})

describe('the shared predicate', () => {
  it('names each inactive control and its remedy, and stays active only when all are', () => {
    const report = enforcementControlsActive([
      { control: 'a', active: true, detail: '', remedy: '' },
      { control: 'b', active: false, detail: 'broken.', remedy: 'fix it.' }
    ])
    expect(report.active).toBe(false)
    expect(describeInactiveControls(report)).toBe("enforcement control 'b' is inactive: broken. Remedy: fix it.")
  })

  it('dispatch readiness refuses, naming the control, when the local gate is inactive', () => {
    const result = checkTaskDispatchReadiness(
      'task/some-tranche/1',
      () => 'ok',
      () => ({ control: 'local-gate', active: false, detail: 'ring 0 is INERT.', remedy: 'arm it.' })
    )
    expect(result.ready).toBe(false)
    expect(result.output).toContain("enforcement control 'local-gate' is inactive")
  })
})
