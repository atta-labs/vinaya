import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DoctorDeps } from '../../src/commands/doctor.js'
import { runDoctor } from '../../src/commands/doctor.js'
import type { InitDeps } from '../../src/commands/init.js'
import { runInit } from '../../src/commands/init.js'
import type { UpgradeDeps } from '../../src/commands/upgrade.js'
import { runUpgrade } from '../../src/commands/upgrade.js'
import { CONFIG_PATH, TRACKED_HOOK_DIR } from '../../src/lib/artifacts.js'
import {
  CLAUDE_SETTINGS_PATH,
  CLAUDE_STOP_HOOK_MARKER,
  CLAUDE_STOP_HOOK_SCRIPT_PATH
} from '../../src/lib/claude-stop-hook-emitter.js'
import type { LabelGateway } from '../../src/lib/ops.js'

// Task 3 (#397): a repo that ran `vinaya init` before the Claude Code Stop
// hook existed has a `claude`-selected manifest with no record of either
// Stop-hook artifact and neither file on disk — exactly the shape that made
// PR #396's token rows read `—/—/—` (`resolveMeteringCapability` had no
// transcript pointer to find because nothing ever wrote one). `vinaya
// upgrade` must retrofit both artifacts the same way `init` would on a
// fresh install, and record them so a second run — and `doctor` — see them
// as genuinely owned, not perpetually "not installed".

let root: string

function initDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  const labels: LabelGateway = {
    async exists() {
      return false
    },
    async create() {}
  }
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    checkGhAuth: async () => true,
    labelGateway: () => labels,
    hookDirFor: () => TRACKED_HOOK_DIR,
    customHooksPath: async () => null,
    setHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

function upgradeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    hookDirFor: () => TRACKED_HOOK_DIR,
    readHooksPath: async () => TRACKED_HOOK_DIR,
    setHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

function doctorDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    ghAuthStatus: async () => ({ authenticated: true, detail: 'ok' }),
    branchProtectionConfigured: async () => null,
    hookDirFor: () => TRACKED_HOOK_DIR,
    readHooksPath: async () => TRACKED_HOOK_DIR,
    nodeVersion: () => 'v99.0.0',
    bunVersion: () => null,
    packageVersion: () => '0.1.0-test',
    meteringCapability: () => ({ capable: false, reason: 'no-transcript-resolved', detail: 'fixture' }),
    ...overrides
  }
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return buf
}

/** Strip the two Stop-hook manifest records and delete the files on disk —
 * simulating a `claude`-vendor install recorded before the Stop hook
 * existed, without hand-writing a whole synthetic manifest. */
function revertToPreStopHookInstall(): void {
  const configAbs = join(root, CONFIG_PATH)
  const cfg = JSON.parse(readFileSync(configAbs, 'utf-8'))
  cfg.managed.files = cfg.managed.files.filter((f: string) => f !== CLAUDE_SETTINGS_PATH)
  cfg.managed.blocks = cfg.managed.blocks.filter(
    (b: { path: string; marker: string }) =>
      !(b.path === CLAUDE_STOP_HOOK_SCRIPT_PATH && b.marker === CLAUDE_STOP_HOOK_MARKER)
  )
  writeFileSync(configAbs, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')
  rmSync(join(root, '.claude'), { recursive: true, force: true })
}

beforeEach(() => {
  root = join(tmpdir(), `vinaya-upgrade-stop-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# widget\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vinaya upgrade — retrofits the Claude Code Stop hook (task 3, #397)', () => {
  it('a scaffold with core.hooksPath=.vinaya/hooks and no .claude/ gets both files, doctor reports them recorded', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    revertToPreStopHookInstall()
    expect(existsSync(join(root, '.claude'))).toBe(false)

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)

    const settings = JSON.parse(readFileSync(join(root, CLAUDE_SETTINGS_PATH), 'utf-8'))
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(CLAUDE_STOP_HOOK_SCRIPT_PATH)

    const script = readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')
    expect(script).toContain('vinaya:managed:track-transcript')

    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.files).toContain(CLAUDE_SETTINGS_PATH)
    expect(cfg.managed.blocks).toContainEqual({
      path: CLAUDE_STOP_HOOK_SCRIPT_PATH,
      marker: CLAUDE_STOP_HOOK_MARKER,
      comment: 'hash'
    })

    const doctorRc = await runDoctor([], doctorDeps())
    expect(doctorRc).toBe(0)
  })

  it('a second upgrade run is a clean no-op once retrofitted — the manifest, not re-derived ownership, now carries it', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    revertToPreStopHookInstall()
    await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))
    expect(out).toContain('already current')
  })

  it('never overwrites a foreign .claude/settings.json — refuses and leaves it exactly as found', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    revertToPreStopHookInstall()
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, CLAUDE_SETTINGS_PATH), '{ "hand-rolled": true }\n')

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), 'utf-8')).toBe('{ "hand-rolled": true }\n')
    expect(out).toContain('REFUSE')
    expect(out).toContain(CLAUDE_SETTINGS_PATH)

    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.files).not.toContain(CLAUDE_SETTINGS_PATH)

    // the Stop-hook script (a managed block, never foreign-blocked the same
    // way) is still retrofitted in the same run.
    expect(existsSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))).toBe(true)
  })

  it('appends to an existing Stop-hook script with foreign content — never overwrites it', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    revertToPreStopHookInstall()
    mkdirSync(join(root, '.claude/hooks'), { recursive: true })
    writeFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), '#!/usr/bin/env sh\necho "hand-rolled"\n')

    await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    const script = readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')
    expect(script).toContain('echo "hand-rolled"')
    expect(script).toContain('vinaya:managed:track-transcript')
  })
})
