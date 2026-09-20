// Issue #660, O1 — the monorepo task runner never caches the `test` task, so
// a push that passed the pre-push hook ran every selected test in this
// working tree AT THIS HEAD, never a replayed result from an earlier run
// whose input hash happened to match (the real risk: a `test` task cached by
// content hash alone can replay a PASS recorded on a quiet machine against a
// later run of the exact same files under load, masking a genuine flake).
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const TURBO_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'turbo')

describe('turbo.json — the test task is never cached (O1)', () => {
  it('tasks.test.cache is false, the same as dev/generate/clean', () => {
    const turboConfig = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { cache?: boolean }>
    }
    expect(turboConfig.tasks.test?.cache).toBe(false)
  })

  it('a fixture monorepo with tasks.test.cache=false really does re-execute on a second run with NO input change — never a replayed cache hit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-turbo-uncached-'))
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'fixture-root',
          private: true,
          packageManager: 'bun@1.2.14',
          workspaces: ['packages/*']
        })
      )
      writeFileSync(join(root, 'bun.lock'), '{}')
      writeFileSync(join(root, 'turbo.json'), JSON.stringify({ tasks: { test: { cache: false } } }))
      const pkgDir = join(root, 'packages', 'a')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@fixture/a', scripts: { test: RUN_SCRIPT } }))

      // Issue #660, O3 round 5 (reviewer MINOR F2) — the same budget/
      // diagnostic discipline `apps/cli/tests/commands/dispatch-task.test.ts`'s
      // `runTaskDispatch` already applies to its own `Bun.spawn` call: no
      // built-in `timeout`/`killSignal` option on this async API, so a
      // manual timer kills a genuinely stuck `turbo` run and the diagnostic
      // carries the child's own already-captured output, rather than
      // falling back to bun:test's bare per-test timeout with nothing to
      // diagnose it by.
      const TURBO_BUDGET_MS = 12_000
      const runOnce = async () => {
        const proc = Bun.spawn([TURBO_BIN, 'test', '--cwd', root], { stdout: 'pipe', stderr: 'pipe' })
        const timedOut = { value: false }
        const timer = setTimeout(() => {
          timedOut.value = true
          proc.kill('SIGKILL')
        }, TURBO_BUDGET_MS)
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text()
        ])
        clearTimeout(timer)
        if (timedOut.value) {
          throw new Error(
            `turbo test subprocess killed by SIGKILL after exceeding its ${TURBO_BUDGET_MS}ms budget\n` +
              `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
          )
        }
        return { exitCode, stdout }
      }

      const first = await runOnce()
      expect(first.exitCode).toBe(0)
      expect(first.stdout).toContain('cache bypass, force executing')

      // No edit between the two runs — a cached task would serve a replayed
      // "cache hit" here; `cache: false` forces genuine re-execution instead.
      const second = await runOnce()
      expect(second.exitCode).toBe(0)
      expect(second.stdout).toContain('cache bypass, force executing')
      expect(second.stdout).not.toContain('cache hit')

      const runCount = readFileSync(join(root, 'run-count.txt'), 'utf8')
      expect(runCount).toBe('xx')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Appends one marker per real execution to a file outside the package
// directory — the only way to observe "did the task's own command actually
// run" from outside the subprocess turbo spawns.
const RUN_SCRIPT = "node -e \"require('fs').appendFileSync('../../run-count.txt', 'x')\""
