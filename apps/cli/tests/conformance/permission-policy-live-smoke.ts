#!/usr/bin/env bun
/**
 * Issue #663, O2 — the bounded, authorized live proof that the permission
 * policy `writeDispatchSettings`/`buildRolePermissions` (`../../src/lib/
 * dispatch.ts`) write actually changes what a REAL, non-interactive `claude`
 * session does — not merely what the generated JSON says. `dispatch.test.ts`'s
 * own fixtures (`buildRolePermissions`/`writeDispatchSettings` describe
 * blocks) prove the JSON shape; this script is the "do not test the policy
 * by reading the file only" half the brief's own Traps name, following the
 * SAME precedent `live-smoke.ts` set for the O1 task in this same directory:
 * a `.ts` file `bun test` never discovers, meant to be re-run by hand, not on
 * every CI push — because unlike that script, THIS one spends real, small
 * amounts of real model tokens (a handful of cheap Haiku calls, a few cents
 * total) to get a real vendor session's own permission engine to answer.
 *
 * Why in-process import was rejected: this repo's own established
 * convention (`apps/cli/tests/conformance/harness.ts`'s own doc comment —
 * "no test mutates `process.env.HOME` in-process anywhere in this
 * codebase") exists because `config.ts`'s `GLOBAL_VINAYA_HOME` is a
 * module-level constant frozen at first import from whatever `HOME` happens
 * to be — importing `writeDispatchSettings` here directly would either
 * pollute this machine's real `~/.vinaya`, or need `process.env.HOME` set
 * before a static import this file has no way to delay. So, exactly like
 * `dispatch.test.ts`'s own `runDispatch` fixtures: the REAL settings file is
 * produced by the REAL `vinaya dispatch developer` CLI command, in a real
 * subprocess with an isolated `HOME`, talking to a FAKE `claude` binary that
 * only echoes its own argv — proving the file dispatch actually writes, not
 * a hand-built stand-in. Only the SECOND half of this script — feeding that
 * real file to the REAL, installed `claude` binary — spends real tokens.
 *
 * What this proves, each against the SAME settings file the first half
 * extracted, under NO `--permission-mode` flag at all (the host's own
 * default — "the machine's interactive classifier" the brief and
 * `dispatch.ts`'s own doc comments name) and non-interactive `-p` (so an
 * "ask" the classifier would otherwise raise resolves to a refusal, never a
 * hang):
 *
 *   1. A worktree-creation command (`git worktree add`) resolves with an
 *      EMPTY `permission_denials` array — allowed by the written policy,
 *      never falling through to an ask.
 *   2. A fetch (`git fetch origin`) resolves the same way.
 *   3. A named test-file run (`bun test <file>`) resolves the same way —
 *      the ONE Bash shape this task's sibling deny rule (`SUITE_RUN_DENY_
 *      REASON`, task #543) would ALSO refuse if the file argument were
 *      dropped; naming a real file here proves this task's OWN allow rule
 *      independent of that older, unrelated hook.
 *   4. A forge read (`gh issue view`, against a fake `gh` on `PATH` that
 *      never reaches the real network) resolves the same way.
 *   5. A forbidden shape doctrine names (`git commit --no-verify`) is
 *      REFUSED — `permission_denials` populated — even though a BROADER
 *      allow rule (`Bash(git commit:*)`) also matches the same command text,
 *      proving the deny rule's own precedence, not mere absence from the
 *      allow list.
 *
 * Manually verified against this exact mechanism, on this authoring host,
 * during this task's own authoring (claude 2.1.258, model
 * `claude-haiku-4-5-20251001`): an unlisted command under NO settings file
 * at all comes back with a populated `permission_denials` array and
 * `result: "Approval needed to run \`git fetch origin\`."`; the SAME command
 * under a settings file naming `Bash(git fetch:*)` in `allow` comes back
 * with an EMPTY `permission_denials` array and a real result; and
 * `git commit --no-verify` under a settings file that allows `Bash(git
 * commit:*)` but denies `Bash(git commit --no-verify*)` comes back with a
 * populated `permission_denials` array and `result: "Permission denied.
 * Need approval to run \`git commit --no-verify …\`. Allow it?"` — proving
 * the narrower deny wins over the broader allow, not chance. This script
 * automates exactly that proof against this task's own shipped policy.
 *
 * Usage: `bun apps/cli/tests/conformance/permission-policy-live-smoke.ts`
 * (needs a real, authenticated `claude` binary on `PATH` — costs a small,
 * real amount of real model spend; never run automatically by CI or by
 * `bun test`.)
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const LIVE_MODEL = 'claude-haiku-4-5-20251001'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFakeBinary(dir: string, name: string, script: string): string {
  const p = join(dir, name)
  writeFileSync(p, script)
  chmodSync(p, 0o755)
  return p
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Found live, running this script for the first time: this script's OWN
 * process is itself a dispatched session (it was authored inside one, for
 * this very Issue), so its ambient environment carries `VINAYA_RUNTIME_DIR`
 * — which `resolveRuntimeDirUncached` checks BEFORE `HOME` — and every other
 * `VINAYA_*` attribution variable. A naive `{ ...process.env, HOME: home }`
 * spread into the settings-extraction subprocess therefore ignored the
 * isolated `HOME` entirely and wrote the real settings/hooks files into
 * THIS MACHINE's real shared `~/.vinaya/runtime/…/tasks-execution/unscoped/
 * hooks/` — the same leak class `dispatch.test.ts`'s own `stripVinayaEnv`
 * helper exists to prevent, reproduced here because this script is new and
 * did not yet reuse it. Applied to BOTH subprocess env constructions below —
 * the extraction call and the live `claude` calls — so neither this
 * script's own dispatched-session ambience nor a stray `VINAYA_RUN_ID`
 * reaching the live sessions' Stop hook can leak state across runs.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  return out
}

/**
 * Step 1: the REAL settings file `writeDispatchSettings` produces for a
 * `developer` dispatch, extracted via the REAL CLI against a FAKE `claude`
 * binary (never a hand-built JSON stand-in) — see this file's own module doc
 * for why this cannot be an in-process import.
 */
function extractRealDeveloperSettingsFile(): string {
  const home = tempDir('vinaya-live-perm-home-')
  const scratchCwd = tempDir('vinaya-live-perm-scratch-')
  const binDir = tempDir('vinaya-live-perm-bin-')
  const argvOut = join(scratchCwd, 'argv.out')
  writeFakeBinary(
    binDir,
    'claude',
    `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{}'\nexit 0\n`
  )
  const promptFile = join(scratchCwd, 'prompt.txt')
  writeFileSync(promptFile, 'do the thing')
  execFileSync('bun', [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', promptFile], {
    cwd: scratchCwd,
    encoding: 'utf8',
    env: { ...stripVinayaEnv(process.env), HOME: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    timeout: 30_000,
    killSignal: 'SIGKILL'
  })
  const argv = readFileSync(argvOut, 'utf8').trim().split('\n')
  const settingsPath = argv[argv.indexOf('--settings') + 1] as string
  return settingsPath
}

/** An isolated git repo with a real bare `origin` and one fixture test file — real `git fetch`/`git worktree add` targets, never the real repo checkout. */
function buildSandboxRepo(): string {
  const repoDir = tempDir('vinaya-live-perm-repo-')
  const originDir = tempDir('vinaya-live-perm-origin-')
  git(originDir, ['init', '-q', '--bare'])
  git(repoDir, ['init', '-q'])
  git(repoDir, ['config', 'user.email', 'fixture@example.com'])
  git(repoDir, ['config', 'user.name', 'fixture'])
  writeFileSync(join(repoDir, 'f.txt'), 'hi\n')
  writeFileSync(
    join(repoDir, 'fixture.test.ts'),
    "import { test, expect } from 'bun:test'\ntest('fixture', () => expect(1).toBe(1))\n"
  )
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'init'])
  git(repoDir, ['remote', 'add', 'origin', originDir])
  git(repoDir, ['push', '-q', 'origin', 'HEAD:main'])
  return repoDir
}

type ClaudeResult = { permissionDenials: unknown[]; result: string }

function runClaude(cwd: string, settingsPath: string, path: string, prompt: string): ClaudeResult {
  const stdout = execFileSync(
    'claude',
    ['-p', '--model', LIVE_MODEL, '--max-turns', '2', '--output-format', 'json', '--settings', settingsPath, prompt],
    {
      cwd,
      encoding: 'utf8',
      input: '',
      env: { ...stripVinayaEnv(process.env), PATH: path },
      timeout: 60_000,
      killSignal: 'SIGKILL'
    }
  )
  const parsed = JSON.parse(stdout) as { permission_denials: unknown[]; result: string }
  return { permissionDenials: parsed.permission_denials, result: parsed.result }
}

async function main(): Promise<void> {
  console.log('permission-policy-live-smoke: extracting the real settings file...')
  const settingsPath = extractRealDeveloperSettingsFile()
  console.log(`permission-policy-live-smoke: settings file at ${settingsPath}`)
  console.log(readFileSync(settingsPath, 'utf8'))

  const repoDir = buildSandboxRepo()
  const ghBinDir = tempDir('vinaya-live-perm-ghbin-')
  writeFakeBinary(ghBinDir, 'gh', '#!/bin/sh\necho \'{"number":663,"title":"fixture issue"}\'\nexit 0\n')
  const path = `${ghBinDir}:${process.env.PATH ?? ''}`

  const failures: string[] = []
  const expectAllowed = (label: string, r: ClaudeResult): void => {
    console.log(`--- ${label} ---`)
    console.log(JSON.stringify(r))
    if (r.permissionDenials.length !== 0)
      failures.push(`${label}: expected no permission_denials, got ${JSON.stringify(r.permissionDenials)}`)
  }
  const expectDenied = (label: string, r: ClaudeResult): void => {
    console.log(`--- ${label} ---`)
    console.log(JSON.stringify(r))
    if (r.permissionDenials.length === 0) failures.push(`${label}: expected a permission_denials entry, got none`)
  }

  expectAllowed(
    'worktree creation',
    runClaude(
      repoDir,
      settingsPath,
      path,
      'Use the Bash tool to run exactly this command, do not ask for confirmation, do not explain: git worktree add ../fixture-wt -b fixture-wt-branch'
    )
  )
  expectAllowed(
    'fetch',
    runClaude(
      repoDir,
      settingsPath,
      path,
      'Use the Bash tool to run exactly this command, do not ask for confirmation, do not explain: git fetch origin'
    )
  )
  expectAllowed(
    'named test-file run',
    runClaude(
      repoDir,
      settingsPath,
      path,
      'Use the Bash tool to run exactly this command, do not ask for confirmation, do not explain: bun test fixture.test.ts'
    )
  )
  expectAllowed(
    'forge read',
    runClaude(
      repoDir,
      settingsPath,
      path,
      'Use the Bash tool to run exactly this command, do not ask for confirmation, do not explain: gh issue view 663'
    )
  )
  expectDenied(
    'forbidden: --no-verify commit',
    runClaude(
      repoDir,
      settingsPath,
      path,
      'Use the Bash tool to run exactly this command, do not ask for confirmation, do not explain, just call the tool: git commit --no-verify -am test-commit'
    )
  )

  if (failures.length > 0) {
    console.error('permission-policy-live-smoke: FAILED —')
    for (const f of failures) console.error(`  - ${f}`)
    process.exitCode = 1
    return
  }
  console.log('permission-policy-live-smoke: all five checks passed against a real, non-interactive claude session.')
}

main().catch((err) => {
  console.error('permission-policy-live-smoke: FAILED —', err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
