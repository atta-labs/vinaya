import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  agentControlsRefusal,
  agentDispatchControls,
  describeInactiveControls,
  enforcementControlsActive
} from '../../src/lib/enforcement-controls.js'
import {
  hookRoutingRepairLine,
  installedHookDir,
  localGateControl,
  realLocalGateControl,
  repairLocalGateControl
} from '../../src/lib/local-gate-control.js'
import { fixtureDir } from './test-temp-fixture'
import { checkTaskDispatchReadiness } from '../../src/lib/dev-review-loop/developer-dispatch.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

function tempRepo(): string {
  const root = fixtureDir('enforcement-controls-')
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

describe('safe task-run hook routing repair', () => {
  function git(root: string, ...args: string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  }
  function trackedRepo(): string {
    const root = realpathSync(tempRepo())
    git(root, 'init', '-q')
    writeHooks(root)
    writeFileSync(
      join(root, 'vinaya.config.json'),
      JSON.stringify({ managed: { blocks: [{ path: '.vinaya/hooks/pre-commit' }] } })
    )
    return root
  }
  for (const spelling of ['unset', 'absolute', 'trailing slash', 'dot prefix', 'symlink']) {
    it(`repairs ${spelling} routing and narrates the mutation once`, () => {
      const root = trackedRepo()
      if (spelling === 'symlink') symlinkSync(join(root, '.vinaya/hooks'), join(root, 'hook-link'))
      const oldValue =
        spelling === 'unset'
          ? null
          : spelling === 'absolute'
            ? join(root, '.vinaya/hooks')
            : spelling === 'trailing slash'
              ? '.vinaya/hooks/'
              : spelling === 'dot prefix'
                ? './.vinaya/hooks'
                : 'hook-link'
      if (oldValue !== null) git(root, 'config', 'core.hooksPath', oldValue)
      const before = readFileSync(join(root, '.git/config'), 'utf8')
      const lines: string[] = []
      const result = repairLocalGateControl(root, (change) => lines.push(hookRoutingRepairLine(change)))
      expect(result.control.active).toBe(true)
      expect(result.repair).toEqual({ oldValue, newValue: '.vinaya/hooks' })
      expect(git(root, 'config', '--get', 'core.hooksPath')).toBe('.vinaya/hooks')
      expect(readFileSync(join(root, '.git/config'), 'utf8')).not.toBe(before)
      expect(lines).toEqual([`Repaired core.hooksPath from ${JSON.stringify(oldValue)} to ".vinaya/hooks"`])
      const after = readFileSync(join(root, '.git/config'), 'utf8')
      expect(repairLocalGateControl(root).repair).toBeNull()
      expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(after)
    })
  }
  for (const value of [null, '.vinaya/hooks', '.vinaya/hooks/', './.vinaya/hooks', 'absolute', 'other']) {
    it(`preserves config for foreign raw hooks with routing ${value}`, () => {
      const root = trackedRepo()
      const routing = value === 'absolute' ? join(root, '.vinaya/hooks') : value
      if (routing !== null) git(root, 'config', 'core.hooksPath', routing)
      const hook = join(root, '.git/hooks/pre-commit')
      writeFileSync(hook, '#!/bin/sh\necho adopter\n')
      chmodSync(hook, 0o755)
      const before = readFileSync(join(root, '.git/config'), 'utf8')
      const result = repairLocalGateControl(root)
      expect(result.control.active).toBe(false)
      expect(result.control.remedy).toBe(localGateControl(root, '.vinaya/hooks', null).remedy)
      expect(result.repair).toBeNull()
      expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before)
    })
  }
  it('refuses another folder without mutating config', () => {
    const root = trackedRepo()
    mkdirSync(join(root, 'other-hooks'))
    git(root, 'config', 'core.hooksPath', 'other-hooks')
    const before = readFileSync(join(root, '.git/config'), 'utf8')
    expect(repairLocalGateControl(root).control).toEqual(realLocalGateControl(root))
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before)
  })
  it('keeps already-relative routing byte-for-byte unchanged', () => {
    const root = trackedRepo()
    git(root, 'config', 'core.hooksPath', '.vinaya/hooks')
    const before = readFileSync(join(root, '.git/config'), 'utf8')
    expect(repairLocalGateControl(root)).toEqual({ control: realLocalGateControl(root), repair: null })
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before)
  })
  for (const location of ['subdirectory', 'linked worktree']) {
    it(`repairs the main checkout's absolute routing from a ${location}`, () => {
      const root = trackedRepo()
      const directory = join(root, 'caller')
      if (location === 'subdirectory') mkdirSync(directory)
      else {
        git(
          root,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'fixture'
        )
        git(root, 'worktree', 'add', '-q', '-b', 'fixture-linked', directory)
      }
      git(root, 'config', 'core.hooksPath', join(root, '.vinaya/hooks'))
      const result = repairLocalGateControl(directory)
      expect(result.control.active).toBe(true)
      expect(result.repair?.oldValue).toBe(join(root, '.vinaya/hooks'))
      expect(git(directory, 'config', '--get', 'core.hooksPath')).toBe('.vinaya/hooks')
      expect(git(root, 'config', '--get', 'core.hooksPath')).toBe('.vinaya/hooks')
    })
  }
  it('preserves the refusal and adds the write error when config is locked', () => {
    const root = trackedRepo()
    const before = readFileSync(join(root, '.git/config'), 'utf8')
    writeFileSync(join(root, '.git/config.lock'), '')
    const result = repairLocalGateControl(root)
    expect(result.control.active).toBe(false)
    expect(result.control.detail).toContain('ring 0 is INERT')
    expect(result.control.detail).toContain('Hook routing repair failed:')
    expect(result.repair).toBeNull()
    expect(readFileSync(join(root, '.git/config'), 'utf8')).toBe(before)
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
