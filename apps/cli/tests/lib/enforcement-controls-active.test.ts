import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  agentControlsRefusal,
  agentDispatchControls,
  describeInactiveControls,
  enforcementControlsActive
} from '../../src/lib/enforcement-controls.js'
import { installedHookDir, localGateControl, realLocalGateControl } from '../../src/lib/local-gate-control.js'
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

describe('pre-spawn agent control refusal', () => {
  it('an unattended dispatch whose settings failed to write refuses, naming the control and remedy', () => {
    const refusal = agentControlsRefusal('claude', true, { claudeSettingsPath: null, codexHooksPath: null })
    expect(refusal).toContain('claude-settings-and-hooks')
    expect(refusal).toContain('could not be written')
  })

  it('an attended dispatch never refuses on the adapter control', () => {
    expect(agentControlsRefusal('claude', false, { claudeSettingsPath: null, codexHooksPath: null })).toBeNull()
  })

  it('an unattended codex dispatch with a missing hooks file refuses', () => {
    const root = tempRepo()
    const refusal = agentControlsRefusal('codex', true, {
      claudeSettingsPath: null,
      codexHooksPath: join(root, 'absent.json')
    })
    expect(refusal).toContain('codex-hooks')
  })
})

describe('local gate control from the real repository', () => {
  function gitRepo(legacy = true): string {
    const root = tempRepo()
    execFileSync('git', ['init', '-q', root])
    if (legacy) {
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ managed: { blocks: [{ path: '.git/hooks/pre-commit' }] } })
      )
    }
    return root
  }

  it('the legacy shape reads git routing and refuses while the git hooks are absent', () => {
    const root = gitRepo()
    expect(installedHookDir(root)).toBe('.git/hooks')
    const control = realLocalGateControl(root)
    expect(control.active).toBe(false)
    expect(control.detail).toContain('.git/hooks/pre-commit')
  })

  it('the legacy shape is active once the git hooks are executable', () => {
    const root = gitRepo()
    for (const h of ['pre-commit', 'pre-push']) {
      const p = join(root, '.git', 'hooks', h)
      writeFileSync(p, '#!/bin/sh\nexit 0\n')
      chmodSync(p, 0o755)
    }
    expect(realLocalGateControl(root).active).toBe(true)
  })

  it('a tracked install is inactive until core.hooksPath routes at the tracked directory, then active', () => {
    const root = gitRepo(false)
    writeHooks(root)
    writeFileSync(
      join(root, 'vinaya.config.json'),
      JSON.stringify({ managed: { blocks: [{ path: '.vinaya/hooks/pre-commit' }] } })
    )
    expect(installedHookDir(root)).toBe('.vinaya/hooks')
    expect(realLocalGateControl(root).active).toBe(false)
    execFileSync('git', ['-C', root, 'config', 'core.hooksPath', '.vinaya/hooks'])
    expect(realLocalGateControl(root).active).toBe(true)
  })
})
