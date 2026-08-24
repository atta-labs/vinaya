/**
 * End-to-end: `vinaya check --plan` / `--plan --json` resolving the `roles`
 * config block against the REAL bundled doctrine (`resolveDoctrineRoot()`
 * finds this monorepo's own `aeg-root/` via its vendored-dev fallback,
 * exactly as `doctrine.test.ts` relies on) — an override and an additive
 * role resolve, render, and validate, and every malformed variant fails
 * closed with a named error, mirroring `check-flip.test.ts`'s own
 * behavioural style for the checks resolver.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

let repoDir: string | undefined
let homeDir: string | undefined

afterEach(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true })
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
  repoDir = undefined
  homeDir = undefined
})

function fixture(config?: unknown): { repo: string; home: string } {
  repoDir = mkdtempSync(join(tmpdir(), 'vinaya-roles-plan-repo-'))
  homeDir = mkdtempSync(join(tmpdir(), 'vinaya-roles-plan-home-'))
  mkdirSync(join(homeDir, '.vinaya'), { recursive: true })
  if (config !== undefined) {
    writeFileSync(join(repoDir, 'vinaya.config.json'), JSON.stringify(config, null, 2), 'utf-8')
  }
  return { repo: repoDir, home: homeDir }
}

const VALID_HEADER = (roleId: string, title: string) => `---
title: ${title}
order: 99
role_id: ${roleId}
description: A test-authored role contract.
actor: agent
performs:
  - do-the-thing
refuses_when: Never.
summary: Ever needed one more role?
---
## The short version

This role does the thing.
`

function writeContract(repo: string, file: string, content: string): void {
  writeFileSync(join(repo, file), content, 'utf-8')
}

type Run = { code: number; stdout: string; stderr: string }

async function runCli(args: string[], repo: string, home: string): Promise<Run> {
  const proc = Bun.spawn(['bun', INDEX, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

type Plan = {
  roles:
    | {
        available: true
        resolved: Record<string, { state: string; source: string; rendersAs: string; title: string; gating: string }>
        errors: Array<{ key: string; reason: string }>
      }
    | { available: false; reason: string }
}

async function plan(repo: string, home: string): Promise<Plan> {
  const run = await runCli(['check', '--plan', '--json'], repo, home)
  return JSON.parse(run.stdout) as Plan
}

describe('vinaya check --plan — roles half resolves against real bundled doctrine', () => {
  it('with no vinaya.config.json, core doctrine roles resolve as default/core', async () => {
    const { repo, home } = fixture()
    const result = await plan(repo, home)
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toEqual([])
    expect(result.roles.resolved.developer).toMatchObject({ state: 'default', source: 'core', rendersAs: 'developer' })
  })

  it('an override with a matching role_id resolves as overridden, exit 0', async () => {
    const { repo, home } = fixture({ roles: { developer: { contract: './custom-developer.md' } } })
    writeContract(repo, 'custom-developer.md', VALID_HEADER('developer', 'Custom Developer'))
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(0)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toEqual([])
    expect(result.roles.resolved.developer).toMatchObject({
      state: 'overridden',
      source: 'config',
      rendersAs: 'developer',
      title: 'Custom Developer',
      gating: 'core'
    })
  })

  it('an additive role resolves as additive, renders under its own role_id, and is flagged inert', async () => {
    const { repo, home } = fixture({ roles: { 'acme/qa-lead': { contract: './qa-lead.md' } } })
    writeContract(repo, 'qa-lead.md', VALID_HEADER('qa-lead', 'QA Lead'))
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(0)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toEqual([])
    expect(result.roles.resolved['acme/qa-lead']).toMatchObject({
      state: 'additive',
      source: 'config',
      rendersAs: 'qa-lead',
      title: 'QA Lead',
      gating: 'inert'
    })
  })

  it('a config-level rejection (bare filename, no "/") fails at config load, not resolver time', async () => {
    const { repo, home } = fixture({ roles: { developer: { contract: 'custom-developer.md' } } })
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    // No `checks` failure here — the malformed `roles` entry fails Zod
    // validation, which `loadConfigChecked()` surfaces as a `checks`-side
    // refusal (the whole config is unreadable), independent of roles.
    expect(run.code).not.toBe(0)
  })

  it('an override whose contract role_id does not match the config key fails closed, named', async () => {
    const { repo, home } = fixture({ roles: { developer: { contract: './wrong-id.md' } } })
    writeContract(repo, 'wrong-id.md', VALID_HEADER('not-developer', 'Wrong'))
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(1)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toHaveLength(1)
    expect(result.roles.errors[0]?.key).toBe('developer')
    expect(result.roles.errors[0]?.reason).toContain('role_id')
  })

  it('a role contract missing a required frontmatter key fails closed, named', async () => {
    const { repo, home } = fixture({ roles: { 'acme/qa-lead': { contract: './qa-lead.md' } } })
    writeContract(
      repo,
      'qa-lead.md',
      VALID_HEADER('qa-lead', 'QA Lead').replace('summary: Ever needed one more role?\n', '')
    )
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(1)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toHaveLength(1)
    expect(result.roles.errors[0]?.reason).toContain('summary')
  })

  it('an additive role rendering under an existing core role id fails closed, named', async () => {
    const { repo, home } = fixture({ roles: { 'acme/developer': { contract: './dev.md' } } })
    writeContract(repo, 'dev.md', VALID_HEADER('developer', 'Shadow Developer'))
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(1)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toHaveLength(1)
    expect(result.roles.errors[0]?.reason).toContain('collides with a core role id')
  })

  it('a bare, un-namespaced config key matching no core role id fails closed, named', async () => {
    const { repo, home } = fixture({ roles: { badkey: { contract: './x.md' } } })
    writeContract(repo, 'x.md', VALID_HEADER('badkey', 'Bad'))
    const run = await runCli(['check', '--plan', '--json'], repo, home)
    expect(run.code).toBe(1)
    const result = JSON.parse(run.stdout) as Plan
    expect(result.roles.available).toBe(true)
    if (!result.roles.available) return
    expect(result.roles.errors).toEqual([{ key: 'badkey', reason: 'bare key has no "/" and matches no core role id' }])
  })

  it('the human table renders a RENDERS AS column and does not crash', async () => {
    const { repo, home } = fixture({ roles: { 'acme/qa-lead': { contract: './qa-lead.md' } } })
    writeContract(repo, 'qa-lead.md', VALID_HEADER('qa-lead', 'QA Lead'))
    const run = await runCli(['check', '--plan'], repo, home)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('RENDERS AS')
    expect(run.stdout).toContain('acme/qa-lead')
    expect(run.stdout).toContain('qa-lead')
  })
})
