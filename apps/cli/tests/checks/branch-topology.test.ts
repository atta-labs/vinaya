import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBranchTopology } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'

// Task `vinaya-adopter-portability-v1` 2 (Issue #232): `check-branch-topology.ts`
// used to construct `topoPath` as the literal `aeg-root/tranches/<tranche>.md`
// — never read from disk by anything (`checkBranchTopology`, above, only
// splices `topoPath` into its own human-readable messages; the real topology
// comes from a live forge read, `createForgeSource(...).getTranche()`). That
// literal is a pre-forge-migration artifact stale even in THIS repo (there is
// no `aeg-root/tranches/` directory here any more), so it sent a reader
// hunting for a markdown file that cannot exist in any repository, adopter or
// author. The fix changes only the STRING the bin passes as `topoPath`; this
// suite proves the resulting message is honest by exercising the real,
// pure `checkBranchTopology` directly with the exact string production code
// now constructs — no network, no `gh`, no forge required, since the
// function itself never touches either.

const BIN_PATH = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-branch-topology.ts')

describe('branch-topology — task vinaya-adopter-portability-v1 2 (Issue #232)', () => {
  it('the fixed topoPath label no longer claims a file must exist on disk', () => {
    const result = checkBranchTopology({
      branch: 'task/fixture-tranche/1',
      tranche: 'fixture-tranche',
      taskId: '1',
      topoPath: 'the forge-registered topology for tranche "fixture-tranche"',
      topology: null
    })
    expect(result.verdict).toBe('refuse')
    expect(result.reason).not.toContain('aeg-root/tranches')
    expect(result.reason).not.toContain('.md')
    expect(result.reason).toContain('the forge-registered topology for tranche "fixture-tranche"')
  })

  it('the same fix applied to the missing-row message', () => {
    const result = checkBranchTopology({
      branch: 'task/fixture-tranche/9',
      tranche: 'fixture-tranche',
      taskId: '9',
      topoPath: 'the forge-registered topology for tranche "fixture-tranche"',
      topology: { name: 'fixture-tranche', lifecycle: 'active', goal: '', tasks: [{ id: '1' } as never], backlog: [] }
    })
    expect(result.verdict).toBe('refuse')
    expect(result.reason).not.toContain('aeg-root/tranches')
  })

  it('the shipped bin file no longer CONSTRUCTS a topoPath from the stale aeg-root/tranches literal (module doc may still name it historically)', () => {
    const source = readFileSync(BIN_PATH, 'utf8')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the OLD literal source expression is absent, not writing a template string
    expect(source).not.toContain('aeg-root/tranches/${fields.tranche}.md')
    expect(source).toContain('function topologyLabel(')
  })

  it('a branch not shaped like task/<tranche>/<n> stays dormant — exit 0, no output, no network/forge call attempted', () => {
    const root = join(tmpdir(), `vinaya-branch-topology-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })

      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
