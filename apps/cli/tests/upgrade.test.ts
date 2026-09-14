import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOC_OWNERS_PATH } from '@attalabs/aeg-core'
import type { DoctorDeps, Finding } from '../src/commands/doctor.js'
import { runDoctor } from '../src/commands/doctor.js'
import type { InitDeps } from '../src/commands/init.js'
import { runInit } from '../src/commands/init.js'
import type { UpgradeDeps } from '../src/commands/upgrade.js'
import { planRingsMigration, runUpgrade } from '../src/commands/upgrade.js'
import { CHECKS_WORKFLOW_PATH, CONFIG_PATH, MCP_JSON_PATH, REVIEW_WORKFLOW_PATH } from '../src/lib/artifacts.js'
import { CLAUDE_COMMAND_PATH } from '../src/lib/claude-command-emitter.js'
import { CLAUDE_SETTINGS_PATH, CLAUDE_STOP_HOOK_SCRIPT_PATH } from '../src/lib/claude-stop-hook-emitter.js'
import { GEMINI_COMMAND_PATH } from '../src/lib/gemini-command-emitter.js'
import type { LabelGateway } from '../src/lib/ops.js'

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
    hookDirFor: () => '.husky',
    customHooksPath: async () => null,
    setHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

function upgradeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    hookDirFor: () => '.husky',
    readHooksPath: async () => null,
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
    hookDirFor: () => '.husky',
    readHooksPath: async () => null,
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

beforeEach(() => {
  root = join(tmpdir(), `vinaya-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# widget\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vinaya upgrade', () => {
  it('is a clean no-op on a repo that is already current', async () => {
    await runInit(['--yes'], initDeps())
    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain('already current')
  })

  it('removes a stale generated agent skill for a retired role, dropping it from the manifest', async () => {
    await runInit(['--yes'], initDeps())

    // No role file under aeg-root/roles/ is named this, so it is stale by
    // construction — the same shape a real role retirement leaves behind in
    // a repo that generated the skill before the role was removed.
    const stalePath = '.agents/skills/vinaya-retired-fixture-role/SKILL.md'
    mkdirSync(join(root, '.agents/skills/vinaya-retired-fixture-role'), { recursive: true })
    writeFileSync(join(root, stalePath), '---\nname: vinaya-retired-fixture-role\n---\nstale\n')
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files.push(stalePath)
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain(`remove ${stalePath}`)
    expect(existsSync(join(root, stalePath))).toBe(false)

    const after = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(after.managed.files).not.toContain(stalePath)
  })

  it('--dry-run leaves a stale generated agent skill on disk, only reporting it', async () => {
    await runInit(['--yes'], initDeps())
    const stalePath = '.agents/skills/vinaya-retired-fixture-role/SKILL.md'
    mkdirSync(join(root, '.agents/skills/vinaya-retired-fixture-role'), { recursive: true })
    writeFileSync(join(root, stalePath), '---\nname: vinaya-retired-fixture-role\n---\nstale\n')
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files.push(stalePath)
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)

    const out = await captureStdout(() => runUpgrade(['--dry-run'], upgradeDeps()))
    expect(out).toContain(`remove ${stalePath}`)
    expect(existsSync(join(root, stalePath))).toBe(true)
  })

  it('--dry-run shows the regeneration diff and writes nothing', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')
    const before = readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')

    const out = await captureStdout(() => runUpgrade(['--dry-run'], upgradeDeps()))
    expect(out).toContain('regenerate')
    expect(out).toContain(CHECKS_WORKFLOW_PATH)
    expect(out).toContain('nothing was written')
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).toBe(before) // unchanged
  })

  it('regenerates a drifted workflow, then doctor reports clean', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).not.toBe('name: hand-edited\n')
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).toContain('Vinaya Checks')

    const doctorRc = await runDoctor([], doctorDeps())
    expect(doctorRc).toBe(0)
  })

  it('recreates a missing (fresh-clone-drifted) hook host', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, '.husky/pre-commit'))

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true)
    expect(readFileSync(join(root, '.husky/pre-commit'), 'utf-8')).toContain('vinaya:managed:pre-commit')

    const doctorRc = await runDoctor([], doctorDeps())
    expect(doctorRc).toBe(0)
  })

  it('restores a corrupted managed block, keeping the adopter host file', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, '.husky/pre-push'), '#!/usr/bin/env sh\necho not-vinaya-anymore\n')

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    const content = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(content).toContain('echo not-vinaya-anymore') // adopter line survives
    expect(content).toContain('vinaya:managed:pre-push')
  })

  it('regenerates a drifted Claude Code Stop-hook script and settings.json, then doctor reports clean', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CLAUDE_SETTINGS_PATH), '{ "hand-edited": true }\n')
    const script = readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')
    writeFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), script.replace('track-transcript', 'tampered'))

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain(`regenerate ${CLAUDE_SETTINGS_PATH}`)
    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), 'utf-8')).not.toBe('{ "hand-edited": true }\n')
    expect(readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')).toContain('vinaya:managed:track-transcript')

    const doctorRc = await runDoctor([], doctorDeps())
    expect(doctorRc).toBe(0)
  })

  it('recreates a missing (fresh-clone-drifted) Claude Code Stop-hook script', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(existsSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))).toBe(true)
    expect(readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')).toContain('vinaya:managed:track-transcript')
  })

  it('recreates a task-tools .mcp.json a pre-feature manifest never recorded', async () => {
    await runInit(['--yes'], initDeps())
    // Simulate a repo initialised before `.mcp.json` existed: drop it from the
    // manifest AND disk, so the `!owned && !exists` retrofit branch is what runs.
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files = (cfg.managed.files as string[]).filter((f) => f !== MCP_JSON_PATH)
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    rmSync(join(root, MCP_JSON_PATH), { force: true })

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(existsSync(join(root, MCP_JSON_PATH))).toBe(true)
    const written = JSON.parse(readFileSync(join(root, MCP_JSON_PATH), 'utf-8'))
    expect(written.mcpServers['vinaya-task-tools']).toBeDefined()
    // Recorded back into the manifest, so a second upgrade is a no-op for it.
    const after = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(after.managed.files).toContain(MCP_JSON_PATH)
  })

  it("never touches vinaya.config.json's adopter-owned keys (rings/checks/briefSchema)", async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.rings.ring1_forgeWriteInterception = true
    cfg.checks = { custom: { run: 'scripts/vinaya-checks/custom.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)

    // force a real regeneration alongside the adopter edit
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')

    await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    const after = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(after.rings.ring1_forgeWriteInterception).toBe(true)
    expect(after.checks).toEqual({ custom: { run: 'scripts/vinaya-checks/custom.ts', scope: 'full' } })
    // manifest itself was still regenerated (version stamped)
    expect(after.managed.version).toBeDefined()
  })

  it('never touches .vinaya/doc-owners once real bindings are added (found live: upgrade would regenerate it back to empty)', async () => {
    await runInit(['--yes'], initDeps())
    const bound = 'apps/foo/src/**  apps/foo/specs/foo.md\n'
    writeFileSync(join(root, DOC_OWNERS_PATH), bound, { flag: 'a' })

    // force a real regeneration alongside the adopter edit
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    expect(readFileSync(join(root, DOC_OWNERS_PATH), 'utf-8')).toContain(bound)
    // the real drift elsewhere still got regenerated — this isn't a no-op run
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).not.toBe('name: hand-edited\n')
    expect(out).not.toContain(`regenerate   ${DOC_OWNERS_PATH}`)
  })

  it("recreates a missing .vinaya/doc-owners (recorded as owned) instead of leaving `doctor`'s remedy dead-ended (#182)", async () => {
    await runInit(['--yes'], initDeps())
    const pristine = readFileSync(join(root, DOC_OWNERS_PATH), 'utf-8')
    rmSync(join(root, DOC_OWNERS_PATH))

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain(`+ recreate   ${DOC_OWNERS_PATH}`)
    expect(existsSync(join(root, DOC_OWNERS_PATH))).toBe(true)
    // recreated exactly as the pristine starter `init` would have written —
    // never partially, never with a placeholder.
    expect(readFileSync(join(root, DOC_OWNERS_PATH), 'utf-8')).toBe(pristine)

    // the measured deadlock from `#182`: three consecutive `upgrade --yes`
    // runs left the file absent and `doctor` still erroring. One run now
    // closes it.
    const doctorRc = await runDoctor([], doctorDeps())
    expect(doctorRc).toBe(0)
  })

  // vinaya.config.json shares the SAME classification exemption in
  // `planUpgrade` (`op.path === CONFIG_PATH || op.path === DOC_OWNERS_PATH`),
  // but does NOT share the runtime deadlock: `runUpgrade` reads
  // `vinaya.config.json` for the manifest before `planUpgrade` is ever
  // called, and bails out with "not initialized" the instant that read finds
  // the file missing (never reaching this fix's `!exists` fallthrough at
  // all). The case is decided explicitly here, not left implicit: recreating
  // a missing `vinaya.config.json` from a starter is a materially different
  // decision (it carries the ownership manifest itself) and is deliberately
  // out of this fix's scope — see `upgrade.ts`'s classification comment.
  it("a missing vinaya.config.json is refused outright, not silently regenerated — CONFIG_PATH does not share DOC_OWNERS_PATH's deadlock", async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, CONFIG_PATH))

    const rc = await runUpgrade(['--yes'], upgradeDeps())
    expect(rc).toBe(1)
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false)
  })

  it('leaves foreign (non-vinaya-owned) content at a vinaya path untouched', async () => {
    await runInit(['--yes'], initDeps())
    // Drop DOCTRINE_POINTER_PATH from the manifest so upgrade sees it as
    // foreign (present on disk, not owned), and hand-edit its content —
    // alongside a real drift elsewhere so the run isn't a trivial no-op.
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files = cfg.managed.files.filter((f: string) => f !== 'VINAYA.md')
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    writeFileSync(join(root, 'VINAYA.md'), '# my own notes, not vinaya-generated\n')
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))
    expect(out).toContain('REFUSE')
    expect(readFileSync(join(root, 'VINAYA.md'), 'utf-8')).toBe('# my own notes, not vinaya-generated\n')
    // the real drift elsewhere still got regenerated
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).not.toBe('name: hand-edited\n')
  })

  it('does not warn when a regenerated workflow keeps the same trigger type', async () => {
    await runInit(['--yes'], initDeps())
    // on-disk drift with the SAME `pull_request` trigger as the generator
    // emits for this file — a real regenerate, just not a trigger migration.
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\non:\n  pull_request:\n    types: [opened]\n')

    const out = await captureStdout(() => runUpgrade(['--dry-run'], upgradeDeps()))
    expect(out).toContain(`regenerate ${CHECKS_WORKFLOW_PATH}`)
    expect(out).not.toContain('TRIGGER CHANGE')
  })

  it('warns with the correct from/to when a regenerated workflow is migrating trigger types', async () => {
    await runInit(['--yes'], initDeps())
    // REVIEW_WORKFLOW_PATH's generator emits `pull_request_target`; hand-edit
    // the on-disk copy to declare the older `pull_request` trigger, the exact
    // shape of the atta-labs/attalabs 0.16.0 -> 0.17.1 migration this brief
    // fixes for.
    writeFileSync(join(root, REVIEW_WORKFLOW_PATH), 'name: hand-edited\non:\n  pull_request:\n    types: [opened]\n')

    const out = await captureStdout(() => runUpgrade(['--dry-run'], upgradeDeps()))
    expect(out).toContain('TRIGGER CHANGE')
    expect(out).toContain(`${REVIEW_WORKFLOW_PATH} is moving from \`pull_request\` to \`pull_request_target\`.`)
  })

  it('the trigger-change warning is informational only — regenerate and apply proceed unaffected', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, REVIEW_WORKFLOW_PATH), 'name: hand-edited\non:\n  pull_request:\n    types: [opened]\n')

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain('TRIGGER CHANGE')
    const content = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    expect(content).not.toContain('hand-edited')
    expect(content).toContain('pull_request_target')
  })

  it('refuses when vinaya is not initialized', async () => {
    const rc = await runUpgrade(['--yes'], upgradeDeps())
    expect(rc).toBe(1)
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false)
  })

  it('refuses on a non-git-repo', async () => {
    const rc = await runUpgrade(['--yes'], upgradeDeps({ detectRepo: async () => null }))
    expect(rc).toBe(1)
  })

  it('refuses when the manifest version is newer than the installed package understands', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.version = 999
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)

    const rc = await runUpgrade(['--yes'], upgradeDeps())
    expect(rc).toBe(1)
  })

  it('aborting the confirmation writes nothing', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')

    const rc = await runUpgrade([], upgradeDeps({ confirm: async () => false }))
    expect(rc).toBe(0)
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).toBe('name: hand-edited\n')
  })
})

// task 5 (#152) — `upgrade` takes no `--agents` flag; it must read the
// selection back from `managed.agents` rather than re-deriving the default,
// so a narrowed `init` selection is neither silently widened nor dropped.
describe('vinaya upgrade — the persisted --agents selection, never re-flagged', () => {
  it('a repo initialized with --agents=claude regenerates only the Claude Code file on a flagless upgrade — never adds the other vendors', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(true)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)

    // Drift the owned file so upgrade has real work to do.
    writeFileSync(join(root, CLAUDE_COMMAND_PATH), '# hand-edited\n')

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))
    expect(out).toContain(`regenerate ${CLAUDE_COMMAND_PATH}`)
    expect(readFileSync(join(root, CLAUDE_COMMAND_PATH), 'utf-8')).not.toBe('# hand-edited\n')

    // The vendors never selected at init time stay absent — a flagless
    // upgrade must not silently widen the selection.
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)

    // The recorded selection itself survives the upgrade unchanged.
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.agents).toEqual(['claude'])
  })

  it('a repo initialized with --agents=none stays that way across an upgrade — the selection is never silently dropped', async () => {
    await runInit(['--yes', '--agents=none'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n') // real work for upgrade to do

    await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))

    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.agents).toEqual([])
  })

  it('a manifest written before managed.agents existed (pre-task-5) is treated as every vendor — upgrade installs all three, the same default a fresh init gives, without anyone re-running init', async () => {
    await runInit(['--yes'], initDeps())
    // Simulate a pre-task-5 install: files exist, but the manifest has never
    // heard of the agents key or any of the three vendor files.
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    delete cfg.managed.agents
    cfg.managed.files = cfg.managed.files.filter(
      (f: string) => f !== CLAUDE_COMMAND_PATH && f !== GEMINI_COMMAND_PATH && !f.startsWith('.agents/skills/')
    )
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    rmSync(join(root, CLAUDE_COMMAND_PATH))
    rmSync(join(root, GEMINI_COMMAND_PATH))
    rmSync(join(root, '.agents'), { recursive: true, force: true })
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n') // real work for upgrade to do

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))
    expect(out).toContain(`regenerate ${CHECKS_WORKFLOW_PATH}`)
    expect(out).toContain(`+ recreate   ${CLAUDE_COMMAND_PATH}`)
    expect(out).toContain(`+ recreate   ${GEMINI_COMMAND_PATH}`)
    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(true)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(true)
    expect(existsSync(join(root, '.agents/skills'))).toBe(true)
  })

  it('a manifest with an explicit, narrower --agents selection is NEVER widened by the defaulted-adopt path — only a truly unrecorded manifest gets every vendor', async () => {
    await runInit(['--yes', '--agents=claude'], initDeps())
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n') // real work for upgrade to do

    const out = await captureStdout(() => runUpgrade(['--yes'], upgradeDeps()))
    expect(out).not.toContain(GEMINI_COMMAND_PATH)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)
  })
})

// Regression coverage for the ENOTDIR crash found live (task 9, #881): every
// AEG Developer works in a linked git worktree (`roles/developer.md`), where
// `<repoRoot>/.git` is a FILE (a gitdir pointer), not a directory. `upgrade`'s
// managed-block (hook) classification and writes used a bare
// `join(repoRoot, '.git/hooks/…')`, which — unlike a missing-file miss —
// `mkdir`s *under a file* and throws `ENOTDIR`, aborting the whole apply
// before any later op (e.g. VINAYA.md) ever runs. `doctor.ts` already carried
// the fix (`resolveManagedBlockPath`, `git rev-parse --git-common-dir`);
// `upgrade` never got it. Fixed by lifting that resolver into `lib/ops.ts` as
// the single shared implementation doctor, upgrade, init (via
// `appendBlock`/`createHost`/`planInstall`) and `demo break` all now call.
describe('vinaya upgrade — raw git hooks inside a linked worktree', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  async function runDoctorJson(overrides: Partial<DoctorDeps> = {}): Promise<{ findings: Finding[] }> {
    const original = process.stdout.write.bind(process.stdout)
    let buf = ''
    process.stdout.write = ((chunk: string) => {
      buf += chunk
      return true
    }) as typeof process.stdout.write
    try {
      await runDoctor(['--json'], doctorDeps(overrides))
    } finally {
      process.stdout.write = original
    }
    return JSON.parse(buf).data
  }

  it('completes from a linked worktree, writing hooks into the shared common dir — and from the primary checkout, both landing in the same place — confirmed by `doctor` from the worktree', async () => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    await runInit(['--yes'], initDeps({ hookDirFor: () => '.git/hooks' }))
    git(root, ['add', '-A'])
    // --no-verify: same reasoning as doctor.test.ts's sibling test — the real
    // hook shells to a network-dependent `npx`; irrelevant to what this test
    // verifies (upgrade's own path resolution).
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    // Drift both hooks so `upgrade` has real work to do, not a no-op.
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/usr/bin/env sh\necho stale\n')
    writeFileSync(join(root, '.git/hooks/pre-push'), '#!/usr/bin/env sh\necho stale\n')

    const wtRoot = join(tmpdir(), `vinaya-upgrade-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['worktree', 'add', wtRoot, '-b', 'task/demo/1'])

    try {
      // Proof 1 — from the linked worktree: no longer crashes, hooks land in
      // the shared common dir (the worktree's OWN `.git` is a gitlink file).
      let wtRc = -1
      await captureStdout(async () => {
        wtRc = await runUpgrade(
          ['--yes'],
          upgradeDeps({
            detectRepo: async () => ({ repoRoot: wtRoot, owner: 'acme', repo: 'widget' }),
            hookDirFor: () => '.git/hooks'
          })
        )
      })
      expect(wtRc).toBe(0)
      // The stale content had no vinaya markers, so this is a fresh append
      // (an adopter's own lines are never clobbered) — the proof here is that
      // the managed block landed at all (in the SHARED common dir, not
      // nowhere / not thrown), which a pre-fix ENOTDIR crash would prevent.
      const hookFromWt = readFileSync(join(root, '.git/hooks/pre-commit'), 'utf-8')
      expect(hookFromWt).toContain('echo stale')
      expect(hookFromWt).toContain('vinaya:managed:pre-commit')

      // Proof 2 — from the primary checkout: still works, same destination.
      writeFileSync(join(root, '.git/hooks/pre-push'), '#!/usr/bin/env sh\necho stale-again\n')
      let mainRc = -1
      await captureStdout(async () => {
        mainRc = await runUpgrade(['--yes'], upgradeDeps({ hookDirFor: () => '.git/hooks' }))
      })
      expect(mainRc).toBe(0)
      const hookFromMain = readFileSync(join(root, '.git/hooks/pre-push'), 'utf-8')
      expect(hookFromMain).toContain('vinaya:managed:pre-push')

      // Proof 3 — `doctor`, probed FROM THE WORKTREE, reports both hooks
      // present and matching (not "missing" — the false-negative the naive
      // join would otherwise still report even after a successful write from
      // the primary checkout, since doctor's own read path is separately
      // worktree-aware).
      const report = await runDoctorJson({
        detectRepo: async () => ({ repoRoot: wtRoot, owner: 'acme', repo: 'widget' }),
        hookDirFor: () => '.git/hooks'
      })
      const hookFindings = report.findings.filter((f) => f.check === 'hooks')
      expect(hookFindings.length).toBeGreaterThan(0)
      expect(hookFindings.some((f) => f.message.includes('is missing'))).toBe(false)
      // Every file-level finding is ok; the ONE non-ok is the deliberate
      // clone-gap routing warn a `.git/hooks` install now always carries
      // (atta-labs/attalabs#927) — git never tracks `.git/hooks`, so this
      // install shape leaves every fresh clone without ring 0.
      const nonOk = hookFindings.filter((f) => f.severity !== 'ok')
      expect(nonOk.length).toBe(1)
      expect(nonOk[0]?.severity).toBe('warn')
      expect(nonOk[0]?.message).toContain('which git does not track')
    } finally {
      git(root, ['worktree', 'remove', '--force', wtRoot])
    }
  }, 20_000) // real `runInit` + `worktree add` + two `runUpgrade`s + `runDoctor` — bun's 5s default is too tight on a cold CI runner
})

// issue-545, O2 — rings.ring1_forgeWriteInterception/ring2_asyncAudits had
// their meaning inverted; `vinaya upgrade` migrates a config still holding
// the old literal starter default (`false`), version-gated so it fires at
// most once per repo.
describe('planRingsMigration', () => {
  it('migrates both keys when the manifest predates version 3 and both are the stale `false` default', () => {
    expect(planRingsMigration(2, { ring1_forgeWriteInterception: false, ring2_asyncAudits: false })).toEqual({
      ring1: { from: false, to: true },
      ring2: { from: false, to: true }
    })
  })

  it('migrates a mixed config — each key flips independently of the other', () => {
    expect(planRingsMigration(2, { ring1_forgeWriteInterception: false, ring2_asyncAudits: true })).toEqual({
      ring1: { from: false, to: true },
      ring2: { from: true, to: false }
    })
  })

  it('review round 2, BLOCKER 1: migrates a config holding the old, deliberate opt-in-to-skip `true` too — not just the stale `false` default', () => {
    expect(planRingsMigration(2, { ring1_forgeWriteInterception: true, ring2_asyncAudits: true })).toEqual({
      ring1: { from: true, to: false },
      ring2: { from: true, to: false }
    })
  })

  it('never migrates a manifest already at version 3, even if both keys are literally `false`', () => {
    expect(planRingsMigration(3, { ring1_forgeWriteInterception: false, ring2_asyncAudits: false })).toBeNull()
  })

  it('never migrates when rings is absent entirely', () => {
    expect(planRingsMigration(2, undefined)).toBeNull()
  })

  it('never migrates a key that is absent, even when its sibling key is present and migrates', () => {
    expect(planRingsMigration(2, { ring1_forgeWriteInterception: false })).toEqual({
      ring1: { from: false, to: true },
      ring2: null
    })
  })
})

describe('vinaya upgrade — rings migration end-to-end', () => {
  it('rewrites a stale `false`/`false` config to `true`/`true`, bumps the manifest version, and prints what changed', async () => {
    await runInit(['--yes'], initDeps())
    const configAbs = join(root, CONFIG_PATH)
    const cfg = JSON.parse(readFileSync(configAbs, 'utf-8'))
    // Simulate a pre-fix install: the old starter default, at the old
    // manifest version.
    cfg.rings = { ring1_forgeWriteInterception: false, ring2_asyncAudits: false }
    cfg.managed.version = 2
    writeFileSync(configAbs, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain('rings.ring1_forgeWriteInterception: false → true')
    expect(out).toContain('rings.ring2_asyncAudits: false → true')

    const after = JSON.parse(readFileSync(configAbs, 'utf-8'))
    expect(after.rings).toEqual({ ring1_forgeWriteInterception: true, ring2_asyncAudits: true })
    expect(after.managed.version).toBe(3)
  })

  it('review round 2, BLOCKER 1: rewrites a deliberate old opt-in-to-skip `true`/`true` config to `false`/`false`, never leaving it silently reinterpreted as "run"', async () => {
    await runInit(['--yes'], initDeps())
    const configAbs = join(root, CONFIG_PATH)
    const cfg = JSON.parse(readFileSync(configAbs, 'utf-8'))
    // An adopter who ran `vinaya init` before this fix and deliberately
    // opted BOTH rings into their old "skip" meaning (`true`).
    cfg.rings = { ring1_forgeWriteInterception: true, ring2_asyncAudits: true }
    cfg.managed.version = 2
    writeFileSync(configAbs, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')

    const out = await captureStdout(async () => {
      await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(out).toContain('rings.ring1_forgeWriteInterception: true → false')
    expect(out).toContain('rings.ring2_asyncAudits: true → false')

    const after = JSON.parse(readFileSync(configAbs, 'utf-8'))
    expect(after.rings).toEqual({ ring1_forgeWriteInterception: false, ring2_asyncAudits: false })
    expect(after.managed.version).toBe(3)
  })

  it('never re-migrates a config already at version 3, even if an adopter deliberately set a ring back to `false`', async () => {
    await runInit(['--yes'], initDeps())
    const configAbs = join(root, CONFIG_PATH)
    const cfg = JSON.parse(readFileSync(configAbs, 'utf-8'))
    // Already migrated (version 3), but the adopter has since chosen to
    // opt out of ring 2 on purpose — this must survive untouched.
    cfg.rings = { ring1_forgeWriteInterception: true, ring2_asyncAudits: false }
    writeFileSync(configAbs, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8')

    const out = await captureStdout(async () => {
      await runUpgrade(['--yes'], upgradeDeps())
    })
    expect(out).not.toContain('Rings migrated')

    const after = JSON.parse(readFileSync(configAbs, 'utf-8'))
    expect(after.rings).toEqual({ ring1_forgeWriteInterception: true, ring2_asyncAudits: false })
  })
})
