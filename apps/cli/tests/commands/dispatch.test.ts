/**
 * `vinaya dispatch` command-level stories (task 3, `vinaya-log-v1`, Issue
 * #406): `--task` attribution vs. `issue: null`. The command's own trailing
 * flush call is gone entirely ([task-files-v1] 5, O3) — telemetry now
 * reaches its destination live, as `dispatchRole` emits it, so this file no
 * longer asserts anything about a flush firing or being skipped, only that
 * no `gh` call happens at all. Spawn/timeout/refusal fidelity itself is
 * `apps/cli/tests/lib/dispatch.test.ts`'s job — this file is the argv/
 * attribution layer. Same fresh-subprocess discipline as that file (a
 * scratch `HOME`, a scratch non-git `cwd`) and the same fake-binary-on-PATH
 * pattern as `apps/cli/tests/commands/issue.test.ts`'s fake `gh`.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * Issue #660, O3 round 3 (security review, HIGH) — unlike the sibling
 * `apps/cli/tests/lib/dispatch.test.ts` (fixed with a `stripVinayaEnv`
 * helper and an explicit budget), this file spread `...process.env`
 * straight into its own real `vinaya dispatch` subprocess: a leaked
 * `VINAYA_RUNTIME_DIR` from a dispatched session's own environment survives
 * past this fixture's `HOME` override (`resolveRuntimeDirUncached` checks it
 * first), redirecting this fixture's writes into the real, shared runtime
 * directory; and with no `spawnSync` timeout, a stuck child was only ever
 * caught by bun:test's bare default, with no captured output.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  return out
}

const SUBPROCESS_BUDGET_MS = 18_000

// `spawnSync`, not `execFileSync` — `execFileSync` discards stderr entirely
// on a zero exit code (it only ever surfaces it via a caught error's
// `.stderr`), so a passing run's own non-fatal stderr warnings (e.g. a
// skipped trailing flush) were unobservable here before this fix.
function runDispatch(
  args: string[],
  cwd: string,
  home: string,
  path: string,
  extraEnv: Record<string, string> = {}
): CliResult {
  const result = spawnSync('bun', [INDEX, 'dispatch', ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...stripVinayaEnv(process.env), HOME: home, PATH: path, ...extraEnv },
    timeout: SUBPROCESS_BUDGET_MS,
    killSignal: 'SIGKILL'
  })
  if (result.signal) {
    throw new Error(
      `vinaya dispatch subprocess killed by ${result.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget ` +
        `(args: ${args.join(' ')})\n--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`
    )
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function writeFakeVendor(dir: string): void {
  const p = join(dir, 'claude')
  writeFileSync(p, `#!/bin/sh\ncat > /dev/null\necho '{"usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`)
  chmodSync(p, 0o755)
}

/**
 * A `gh` stub logging every invocation, so a test can assert whether the
 * flush fired at all. `trustAnchorConfig`, when given, answers the
 * `gh api repos/.../contents/vinaya.config.json --jq .content` read Issue
 * #636's trust-anchor webhook gate makes — base64-encoded, exactly the shape
 * `loadTrustAnchorConfig` decodes; omitted, that read 404s, matching a repo
 * whose default branch carries no `vinaya.config.json` at all.
 */
function writeFakeGh(dir: string, callsLog: string, trustAnchorConfig?: Record<string, unknown>): void {
  const gh = join(dir, 'gh')
  const trustAnchorCase =
    trustAnchorConfig === undefined
      ? `*"contents/vinaya.config.json"*)\n  echo "gh: 404 Not Found" >&2\n  exit 1\n  ;;`
      : `*"contents/vinaya.config.json"*)\n  echo "${Buffer.from(JSON.stringify(trustAnchorConfig), 'utf-8').toString('base64')}"\n  exit 0\n  ;;`
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${callsLog}"
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  echo "https://github.com/test-owner/test-repo/issues/$3#issuecomment-9001"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "https://github.com/test-owner/test-repo/pull/$3#issuecomment-9001"
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$*" in
    ${trustAnchorCase}
    *)
      echo "unhandled gh api: $*" >&2
      exit 1
      ;;
  esac
fi
echo "unhandled gh: $*" >&2
exit 1
`
  )
  chmodSync(gh, 0o755)
}

function outboxLines(home: string, issue: number | 'none'): Array<Record<string, unknown>> {
  // [task-files-v1] 5, O1: the default `logs` destination is now a folder
  // under this repository's own `runtimeDir` — never the machine-global
  // `~/.vinaya/outbox/` these fixtures resolve to `unresolved` (no git
  // origin in the scratch `cwd`).
  const p = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', `${issue}.ndjson`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('vinaya dispatch — --task attribution', () => {
  it('carries subject.issue when --task is given', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const binDir = tempDir('vinaya-dispatch-cmd-bin-')
    writeFakeVendor(binDir)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    // No `gh` stub here, deliberately: a SUCCEEDING flush would truncate the
    // very `dispatch` lines this test reads — `cwd` is not a git repo, so
    // whatever `gh` the ambient PATH carries refuses on repo resolution
    // alone, before any network call (confirmed live), leaving the lines in
    // place. Filtering to `kind === 'dispatch'` below is the other half of
    // the same guard, in case the flush's own `forge_write` line also lands.
    runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '555'],
      cwd,
      home,
      `${binDir}:${process.env.PATH}`
    )

    const lines = outboxLines(home, 555).filter((l) => (l as { kind: string }).kind === 'dispatch')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      const subject = l.subject as { issue: number | null; role: string }
      expect(subject.issue).toBe(555)
      expect(subject.role).toBe('developer')
    }
  })

  it('carries issue: null and the role from the argument — never unattributed — when --task is absent', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const binDir = tempDir('vinaya-dispatch-cmd-bin-')
    writeFakeVendor(binDir)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${process.env.PATH}`
    )

    const lines = outboxLines(home, 'none')
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      const subject = l.subject as { issue: number | null; role: string }
      expect(subject.issue).toBeNull()
      expect(subject.role).toBe('developer')
      expect(subject.role).not.toBe('unattributed')
    }
  })
})

describe('vinaya dispatch — no trailing flush ([task-files-v1] 5, O3)', () => {
  // The trailing flush this command used to run after every `--task`/`--pr`
  // dispatch is gone entirely — telemetry reaches its destination live, as
  // `dispatchRole` emits it (`logs`, `apps/cli/src/lib/log-sink.ts`), so
  // there is nothing left to ship in a trailing step. `gh` is never called
  // by this command at all any more, `logPublish` configured or not.
  it('never calls gh, regardless of a configured logPublish target', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const toolsDir = tempDir('vinaya-dispatch-cmd-tools-')
    writeFakeVendor(toolsDir)
    const callsLog = join(cwd, 'gh-calls.log')
    writeFileSync(callsLog, '')
    writeFakeGh(toolsDir, callsLog)
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ logPublish: { issue: 999 } }))
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '777'],
      cwd,
      home,
      `${toolsDir}:${process.env.PATH}`
    )
    expect(r.status).toBe(0)
    expect(readFileSync(callsLog, 'utf8')).toBe('')
  })

  it('never calls gh when neither --task nor --pr is given either', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const toolsDir = tempDir('vinaya-dispatch-cmd-tools-')
    writeFakeVendor(toolsDir)
    const callsLog = join(cwd, 'gh-calls.log')
    writeFileSync(callsLog, '')
    writeFakeGh(toolsDir, callsLog)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile],
      cwd,
      home,
      `${toolsDir}:${process.env.PATH}`
    )
    expect(r.status).toBe(0)
    expect(readFileSync(callsLog, 'utf8')).toBe('')
  })

  it('accepts --task and --pr both given — no longer an ambiguous flush target, both are attribution only', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const binDir = tempDir('vinaya-dispatch-cmd-bin-')
    writeFakeVendor(binDir)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--task', '1', '--pr', '2'],
      cwd,
      home,
      `${binDir}:${process.env.PATH}`
    )
    expect(r.status).toBe(0)
  })
})

describe('vinaya dispatch — invalid role/vendor', () => {
  it('exits 1 and names the invalid role', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const r = runDispatch(
      ['nonexistent-role', '--agent', 'claude', '--prompt-file', '/dev/null'],
      cwd,
      home,
      process.env.PATH ?? ''
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/nonexistent-role/)
  })

  it('exits 1 and names the invalid vendor', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const r = runDispatch(
      ['developer', '--agent', 'nonexistent-vendor', '--prompt-file', '/dev/null'],
      cwd,
      home,
      process.env.PATH ?? ''
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/nonexistent-vendor/)
  })
})

describe('vinaya dispatch — unknown flags', () => {
  it('refuses `--tranche` (not a real flag this command accepts) and never spawns the vendor — the manual-recovery probe this replaces used to silently drop it and start a real developer', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const binDir = tempDir('vinaya-dispatch-cmd-bin-')
    writeFakeVendor(binDir)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'p')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--tranche', 'task-run-v1', '--task', '8', '--prompt-file', promptFile],
      cwd,
      home,
      `${binDir}:${process.env.PATH}`
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unrecognized flag.*--tranche/)
    // Nothing was dispatched — no outbox lines at all for this issue.
    expect(outboxLines(home, 8).length).toBe(0)
  })

  it('names every unrecognized token when more than one is given', () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', '/dev/null', '--bogus', 'stray-positional'],
      cwd,
      home,
      process.env.PATH ?? ''
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/--bogus/)
    expect(r.stderr).toMatch(/stray-positional/)
  })
})

describe('vinaya dispatch --resume', () => {
  it("reaches the child argv and resumeId appears in --json output — per-vendor argv shape is lib/dispatch.test.ts's job", () => {
    const home = tempDir('vinaya-dispatch-cmd-home-')
    const cwd = tempDir('vinaya-dispatch-cmd-cwd-')
    const binDir = tempDir('vinaya-dispatch-cmd-bin-')
    const argvOut = join(cwd, 'argv.out')
    writeFileSync(
      join(binDir, 'claude'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${argvOut}"\ncat > /dev/null\necho '{"session_id":"resume-id-123","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
    )
    chmodSync(join(binDir, 'claude'), 0o755)
    const promptFile = join(cwd, 'prompt.txt')
    writeFileSync(promptFile, 'do the thing')

    const r = runDispatch(
      ['developer', '--agent', 'claude', '--prompt-file', promptFile, '--resume', 'resume-id-123', '--json'],
      cwd,
      home,
      `${binDir}:${process.env.PATH ?? ''}`
    )
    expect(r.status).toBe(0)
    expect((JSON.parse(r.stdout) as { data: { resumeId: string | null } }).data.resumeId).toBe('resume-id-123')
    const argv = readFileSync(argvOut, 'utf8').replace(/\n$/, '').split('\n')
    // `stream-json` with the `--verbose` the CLI requires alongside `-p`
    // (Issue #447, O5): the resume path streams for the same reason the
    // first turn does — the operator watches the work either way.
    // O1 (#543): claude alone gets a trailing `--settings <path>` pair
    // (dedicated coverage in `apps/cli/tests/lib/dispatch.test.ts`) —
    // stripped here so this test keeps asserting only the resume shape.
    expect(argv.slice(-2, -1)).toEqual(['--settings'])
    expect(argv.slice(0, -2)).toEqual(['-p', '-r', 'resume-id-123', '--verbose', '--output-format', 'stream-json'])
  })
})
