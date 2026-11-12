import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../../../harness/processes/vinaya-strict/integration/commands'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../harness/kernel/conformance/unit/process-fixture'

// The reverse direction of `harness/processes/vinaya-strict/integration/commands.test.ts` (which
// proves every COMMANDS row is dispatched). THIS test proves the opposite:
// every name the router actually dispatches has a COMMANDS row — the
// failure mode that test can't see is a NEW `case` landing in `index.ts`
// with no matching registry entry (silently undocumented, never
// `printHelp()`-visible, never on the web `/docs/cli` reference).
const INDEX_PATH = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const INDEX_SOURCE = readFileSync(INDEX_PATH, 'utf-8')

/**
 * Every command name the router actually reaches: `help` (special-cased
 * pre-switch, see index.ts's own comment), each single-word `case` label,
 * and `"<label> <sub>"` for each `subcommand === '<sub>'` check inside that
 * case's block. A case
 * WITH subcommand branches (`init`, e.g.) still also dispatches its bare
 * label when the `else` branch is a real command call rather than an
 * "Unknown subcommand" refusal (`new`/`pr`, which have no
 * bare form) — detected by the absence of that refusal's
 * `console.error('Unknown ...')` text in the block.
 */
function routedCommandNames(source: string): string[] {
  const names: string[] = ['help']
  const caseRegex = /case '([a-z]+)':([\s\S]*?)(?=\n\s*case '|\n\s*default:)/g
  for (const match of source.matchAll(caseRegex)) {
    const label = match[1] as string
    const block = match[2] as string
    const subcommands = [...block.matchAll(/subcommand === '([a-z][a-z -]*)'/g)].map((m) => m[1] as string)
    // `\s*` matters: biome wraps a long `Unknown '<x>' subcommand` message onto
    // its own line, which silently defeated an adjacency-only regex and made the
    // parser report a bare `pr` form that has no registry row.
    const hasBareForm = subcommands.length === 0 || !/console\.error\(\s*`Unknown/.test(block)
    if (hasBareForm) names.push(label)
    for (const sub of subcommands) names.push(`${label} ${sub}`)
  }
  return names
}

describe('router -> COMMANDS coverage', () => {
  it('every command name the CLI router actually dispatches has a COMMANDS row', () => {
    const routed = routedCommandNames(INDEX_SOURCE)
    expect(routed.length).toBeGreaterThan(0)
    for (const name of routed) {
      const found = COMMANDS.some((c) => c.name === name)
      expect(found, `router dispatches "${name}" but no COMMANDS entry names it`).toBe(true)
    }
  })

  it('the parser extracts the known routed command set exactly — a regression guard on the parser itself', () => {
    const routed = new Set(routedCommandNames(INDEX_SOURCE))
    expect(routed).toEqual(
      new Set([
        'help',
        'version',
        'init',
        'init product',
        'eject',
        'doctor',
        'doctrine',
        'upgrade',
        'new check',
        'new noop-check',
        'new role',
        'pr rule',
        'task run',
        'task status',
        'task switch',
        'quickstart',
        'studio'
      ])
    )
  })
})

describe('COMMANDS -> needs declaration', () => {
  const NEEDS = ['forge', 'default-branch', 'operator-seat']

  it('every command declares what it needs beyond the sandbox, from the known set', () => {
    for (const command of COMMANDS) {
      expect(Array.isArray(command.needs), `\`${command.name}\` declares no \`needs\``).toBe(true)
      for (const need of command.needs) expect(NEEDS, `\`${command.name}\``).toContain(need)
    }
  })

  it('declares the reference examples the Test plan gate depends on', () => {
    const needs = (name: string) => COMMANDS.find((c) => c.name === name)?.needs
    expect(needs('task status')).toEqual(['forge'])
    expect(needs('doctrine')).toEqual([])
  })
})

describe('retired role operations', () => {
  it('refuses old command words and subcommands with role-tool directions', () => {
    const home = mkdtempSync(join(tmpdir(), 'vinaya-retired-commands-'))
    const replacements: Record<string, string[]> = {
      issue: [
        'task_issue_create',
        'task_issue_edit',
        'task_issue_surface',
        'task_objectives_edit',
        'task_issue_validate'
      ],
      brief: ['brief_render'],
      milestone: ['milestone_create', 'milestone_edit', 'milestone_adopt', 'milestone_close', 'milestone_status']
    }
    try {
      for (const [word, tools] of Object.entries(replacements)) {
        expect(COMMANDS.some((c) => c.name === word || c.name.startsWith(`${word} `))).toBe(false)
        for (const args of [[word], [word, '--help'], [word, 'create'], [word, 'objectives', 'edit']]) {
          const result = spawnSyncBudgeted('bun', [INDEX_PATH, ...args], {
            cwd: home,
            encoding: 'utf8',
            env: { ...stripVinayaEnv(), HOME: home }
          })
          expect(result.status).toBe(2)
          expect(result.stdout).toBe('')
          expect(result.stderr.trim().split('\n')).toHaveLength(1)
          expect(result.stderr).toContain('is a role tool now')
          for (const tool of tools) expect(result.stderr).toContain(tool)
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
