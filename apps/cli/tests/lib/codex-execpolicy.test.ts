/**
 * Issue #884, O2 — the live half of the Codex machine-state floor: the
 * `.rules` text `buildCodexExecpolicyRules` generates is run against the
 * INSTALLED `codex` CLI's own dry-run checker (`codex execpolicy check
 * --rules <file> <command…>`), so the mechanism and syntax that refuses a
 * command are established against the real binary, not asserted from the
 * shape of a string. The refusal is proven with a harmless command Codex's
 * checker classifies — never a real `security`/`launchctl` call.
 *
 * `codex execpolicy check` neither authenticates nor sandboxes (it only loads
 * the rule files and classifies the token list), so this runs end to end on
 * any host that has `codex` on PATH. Where `codex` is absent — a CI shard or a
 * contributor box without it — the live cases skip rather than fail, the same
 * vendor-presence posture the rest of this suite takes; the pure-generator
 * contract is covered unconditionally in `dispatch.test.ts`.
 */

import { describe, it, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { buildCodexExecpolicyRules } from '../../src/lib/dispatch.js'

/** The `codex` binary on PATH, or `null` when the host carries none. */
function findCodex(): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'codex')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const CODEX = findCodex()

/** The execpolicy decision Codex reports for `command`, or `'allow'` when no rule forbids it. */
function codexDecision(codex: string, rulesPath: string, command: string[]): string {
  const out = execFileSync(codex, ['execpolicy', 'check', '--rules', rulesPath, ...command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000
  })
  return (JSON.parse(out) as { decision?: string }).decision ?? 'allow'
}

const describeLive = CODEX ? describe : describe.skip

describeLive('buildCodexExecpolicyRules — live against the installed codex CLI (O2)', () => {
  const codex = CODEX as string
  const rulesPath = join(mkdtempSync(join(tmpdir(), 'vinaya-codex-execpolicy-')), 'vinaya-machine-state.rules')
  writeFileSync(rulesPath, buildCodexExecpolicyRules('developer') as string)

  // The machine-state families O1 names — each with a harmless argument, so no
  // real security/launchctl call is ever made; the checker only classifies the
  // tokens.
  const FORBIDDEN: string[][] = [
    ['security', 'default-keychain', '-s', '/tmp/scratch.keychain'],
    ['launchctl', 'list'],
    ['defaults', 'read', 'com.example.plist'],
    ['systemsetup', '-getremotelogin'],
    ['networksetup', '-listallnetworkservices'],
    ['pmset', '-g'],
    ['dscl', '.', '-list', '/Users'],
    ['crontab', '-l'],
    ['chsh', '-s', '/bin/zsh'],
    ['sudo', 'true'],
    ['git', 'config', '--global', 'user.name', 'someone'],
    ['git', 'config', '--system', 'user.name', 'someone']
  ]
  for (const command of FORBIDDEN) {
    it(`refuses \`${command.join(' ')}\``, () => {
      expect(codexDecision(codex, rulesPath, command)).toBe('forbidden')
    })
  }

  // The doctrine commands a Developer actually runs — including the
  // repository-scoped `git config` Step 0 itself runs — must stay runnable.
  const ALLOWED: string[][] = [
    ['git', 'config', 'push.autoSetupRemote', 'true'],
    ['git', 'config', '--get', 'push.autoSetupRemote'],
    ['git', 'commit', '-m', 'msg'],
    ['git', 'push', 'origin', 'HEAD'],
    ['git', 'worktree', 'add', '.worktrees/x'],
    ['gh', 'pr', 'create']
  ]
  for (const command of ALLOWED) {
    it(`leaves \`${command.join(' ')}\` runnable`, () => {
      expect(codexDecision(codex, rulesPath, command)).not.toBe('forbidden')
    })
  }

  it('the generated file loads cleanly (a mistranslation would fail Codex’s own rule-load validation)', () => {
    // A successful `check` on any command already proves the file parsed and its
    // match/not_match examples validated; this asserts it explicitly on a
    // command that matches no rule.
    expect(codexDecision(codex, rulesPath, ['ls', '-la'])).toBe('allow')
  })
})
