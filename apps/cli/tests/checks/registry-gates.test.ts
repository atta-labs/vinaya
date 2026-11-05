import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { checkG7, reachesProducer } from '../../../../harness/processes/vinaya-strict/checks/registry-checks'
import { parseEnforcementRegistry } from '../../../../harness/processes/vinaya-strict/tools/registry-parse'
import { findCrossingFiles, globCandidateFiles } from '../../../../harness/kernel/gates/checks/github-crossing-files.js'
import {
  blockingGateFiles,
  gatherLogProducerGraph,
  readG7Exemptions
} from '../../../../harness/processes/vinaya-strict/checks/log-producer-graph.js'
import { buildInitOps } from '../../../../harness/processes/vinaya-strict/integration/artifacts.js'
import { HOOK_DIRS, initHookPaths } from '../../../../harness/kernel/gates/ring0-hooks/init-hook-paths.js'

// Task `vinaya-adopter-portability-v1` 2 (Issue #232): before this fix, an
// absent `aeg-root/enforcement.md` made `check-registry-gates.ts` exit 0 with
// ZERO findings — a vacuous pass, byte-indistinguishable from a real pass
// that inspected a real doctrine tree. Reproduced on a fresh
// `npm i @attalabs/vinaya@0.19.2 && vinaya init --yes` fixture (this task's
// PR body carries the exact transcript): `registry-gates: pass`, having
// examined zero files. This suite proves the fix: the check now announces
// its own dormancy as a visible warning finding instead of a silent exit.

const BIN_PATH = join(import.meta.dir, '../../../../harness/processes/vinaya-strict/checks/bin/check-registry-gates.ts')

function initFixture(name: string): string {
  const root = join(tmpdir(), `vinaya-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
  return root
}

describe('registry-gates — task vinaya-adopter-portability-v1 2 (Issue #232)', () => {
  it('announces dormancy on stderr as a warning finding, exit 0, instead of a silent zero-finding pass', () => {
    const root = initFixture('registry-gates-dormant')
    try {
      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      expect(result.exitCode).toBe(0)
      const stderr = result.stderr.toString()
      expect(stderr).toContain('"check":"registry-gates.dormant"')
      expect(stderr).toContain('"severity":"warning"')
      expect(stderr).toContain('dormant')
      expect(stderr).toContain('no aeg-root/enforcement.md in this repository')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("the dormancy finding is visible through `vinaya check --all`'s own renderer (findings print under their check regardless of exit code)", () => {
    const root = initFixture('registry-gates-dormant-all')
    try {
      const indexTs = join(import.meta.dir, '..', '..', 'src', 'index.ts')
      // The pull-request variables a report run exports describe another
      // repository's branch, never this fixture's.
      const { PR_BODY: _body, PR_NUMBER: _number, BRANCH: _branch, ...ambient } = process.env
      const result = Bun.spawnSync(['bun', indexTs, 'check', '--all', '--diff-only'], {
        cwd: root,
        env: ambient
      })
      expect(result.exitCode).toBe(0)
      const stdout = result.stdout.toString()
      expect(stdout).toContain('registry-gates: pass')
      expect(stdout).toContain('warning: registry-gates: dormant')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  it('no longer hardcodes packages/aeg-core/bin as a candidate-file location (repo-specific, not portable)', () => {
    const source = readFileSync(BIN_PATH, 'utf8')
    expect(source).not.toContain("existsSync('packages/aeg-core/bin')")
  })

  it("this repository's own run still exercises the real corpus — no dormancy finding when aeg-root/enforcement.md exists", () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
    const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: repoRoot, env: { ...process.env } })
    const stderr = result.stderr.toString()
    expect(stderr).not.toContain('registry-gates.dormant')
  }, 20_000)
})

describe('registry-gates — brief-author retirement (plan-brief-v1 4, Issue #429)', () => {
  // Task 3 (Issue #428) tolerated `brief-developer.md`/`planner-brief.md`
  // naming `brief-author` as producer/consumer until task 4 deleted/renamed
  // them. Task 4 has landed: `roles/brief-author.md` is gone, and no
  // contract names `brief-author` as producer or consumer any more.
  it('no contract names brief-author as producer or consumer', () => {
    const contractsDir = join(import.meta.dir, '..', '..', '..', '..', 'aeg-root', 'contracts')
    const offenders: string[] = []
    for (const file of readdirSync(contractsDir)) {
      if (!file.endsWith('.md')) continue
      const content = readFileSync(join(contractsDir, file), 'utf8')
      if (/^(?:producer|consumer):\s*brief-author\s*$/m.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('registry-gates G1 — hook scripts the doctrine names must be shipped', () => {
  it('fails on a doctrine hook path that is neither tracked nor emitted by init, and passes on an emitted one', () => {
    const root = initFixture('registry-gates-hook-refs')
    try {
      mkdirSync(join(root, 'aeg-root'), { recursive: true })
      writeFileSync(join(root, 'aeg-root', 'enforcement.md'), '# Enforcement\n')
      writeFileSync(
        join(root, 'aeg-root', 'note.md'),
        'Emitted: `.husky/pre-push`. Unshipped: `.claude/hooks/check-gone.sh` and `check-gone.sh`.\n'
      )
      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      const g1 = result.stderr
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { check: string; message: string })
        .filter((f) => f.check === 'registry-gates.G1')
        .map((f) => f.message)
      expect(g1).toHaveLength(2)
      expect(g1.some((m) => m.includes('hook ".claude/hooks/check-gone.sh"'))).toBe(true)
      expect(g1.some((m) => m.includes('hook "check-gone.sh"'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('initHookPaths — parity with buildInitOps', () => {
  it('lists exactly the managed hook blocks buildInitOps emits under each hook directory', () => {
    const emitted = new Set<string>()
    for (const hookDir of HOOK_DIRS) {
      const ops = buildInitOps({ owner: '', repo: '', hookDir, selfHost: null, ciSetup: null, agents: new Set() })
      for (const op of ops) {
        if ('path' in op && op.path.startsWith(`${hookDir}/`)) emitted.add(op.path)
      }
    }
    expect(new Set(initHookPaths())).toEqual(emitted)
    expect(emitted.has('.git/hooks/pre-push')).toBe(true)
    expect(emitted.has('.vinaya/hooks/pre-commit')).toBe(true)
  })
})

describe('registry-gates G7 — anything that can block or write to the forge reaches a log producer', () => {
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..')
  const ring0Rows = () =>
    parseEnforcementRegistry(readFileSync(join(repoRoot, 'aeg-root', 'enforcement.md'), 'utf8')).filter(
      (r) => r.ring === 'ring0'
    )

  it("today's tree passes: the counts are stated and every file reaches a producer or carries a reason", () => {
    const previous = process.cwd()
    process.chdir(repoRoot)
    try {
      const crossingFiles = findCrossingFiles(globCandidateFiles())
      const blockingFiles = blockingGateFiles(ring0Rows(), existsSync)
      const { producers, imports } = gatherLogProducerGraph(repoRoot)
      const reached = blockingFiles.filter((f) => reachesProducer(f, producers, imports))
      expect(crossingFiles).toHaveLength(0)
      expect(blockingFiles).toHaveLength(16)
      expect(reached).toHaveLength(2)
      const exemptions = readG7Exemptions(repoRoot)
      expect(Object.keys(exemptions)).toHaveLength(14)
      const result = checkG7({
        enforcementMapPresent: true,
        crossingFiles,
        blockingFiles,
        producers,
        imports,
        exemptions,
        existsFn: existsSync
      })
      expect(result.findings).toEqual([])
      expect(result.status).toBe('pass')
    } finally {
      process.chdir(previous)
    }
  })

  it('gives every exemption a stated reason', () => {
    for (const [path, reason] of Object.entries(readG7Exemptions(repoRoot))) {
      expect(reason.trim().length, path).toBeGreaterThan(20)
    }
  })

  it("loads exactly today's fourteen path-to-reason pairs from the committed data file", () => {
    const checkBin =
      'a check bin: it runs only as a child of `vinaya check`, whose runner records one gate event per attempt, so no import of the sink is needed'
    const script =
      'a standalone script outside the CLI package: the import resolution cannot follow it and no CLI source imports it; invoked directly, it records nothing of its own'
    expect(readG7Exemptions(repoRoot)).toEqual({
      'harness/processes/vinaya-strict/checks/bin/check-review-gate.ts': checkBin,
      'harness/processes/vinaya-strict/checks/bin/check-doc-coverage.ts': checkBin,
      'harness/processes/vinaya-strict/checks/bin/check-exec-bits.ts': checkBin,
      'harness/processes/vinaya-strict/checks/bin/check-main-branch-refusal.ts': checkBin,
      'harness/processes/vinaya-strict/checks/bin/check-token-collection-wired.ts': checkBin,
      'harness/kernel/gates/checks/resolver.ts':
        'the pure step that decides which checks `vinaya check` runs; the runner it feeds records each run and the invocation records its own operation at exit',
      'harness/processes/vinaya-strict/tools/pull-request/bin/open-pr.ts': script,
      'harness/processes/vinaya-strict/thinking/planner/tools/open-issue.ts': script,
      'harness/processes/vinaya-strict/checks/standalone/verify-dispatch.ts': script,
      'harness/processes/vinaya-strict/checks/standalone/verify-task.ts': script,
      'harness/processes/vinaya-strict/checks/standalone/check-branch-topology.ts': script,
      'harness/processes/vinaya-strict/checks/standalone/check-push-target.ts': script,
      'harness/processes/vinaya-strict/checks/standalone/check-first-push-dispatch.ts': script,
      'harness/processes/vinaya-strict/tools/task-contract/brief-validation.ts':
        'a pure library outside the CLI package: it makes no call of its own, and the import resolution does not follow a workspace package'
    })
  })

  it('judges a planted root with the exemption list that root carries', () => {
    const root = initFixture('registry-gates-g7-exemption-file')
    const blocked = 'harness/processes/vinaya-strict/checks/bin/check-demo.ts'
    const evaluate = () => {
      const { producers, imports } = gatherLogProducerGraph(root)
      return checkG7({
        enforcementMapPresent: true,
        crossingFiles: [],
        blockingFiles: [blocked],
        producers,
        imports,
        exemptions: readG7Exemptions(root),
        existsFn: (p) => existsSync(join(root, p))
      })
    }
    try {
      mkdirSync(join(root, 'harness/processes/vinaya-strict/checks/bin'), { recursive: true })
      writeFileSync(join(root, blocked), 'export const demo = 1\n')
      const without = evaluate()
      expect(without.status).toBe('fail')
      expect(without.findings.map((f) => f.path)).toEqual([blocked])
      mkdirSync(join(root, '.vinaya'), { recursive: true })
      writeFileSync(
        join(root, '.vinaya', 'g7-exemptions.json'),
        JSON.stringify({ [blocked]: 'a demo check bin that reaches no producer on purpose, for this test' })
      )
      const withFile = evaluate()
      expect(withFile.findings).toEqual([])
      expect(withFile.status).toBe('pass')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads no exemptions from a root with no data file', () => {
    const root = initFixture('registry-gates-g7-no-exemption-file')
    try {
      expect(readG7Exemptions(root)).toEqual({})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['invalid JSON', '{ not json'],
    ['a top-level array', '["a", "b"]'],
    ['a non-string value', '{"apps/x.ts": 3}']
  ])('refuses a data file holding %s, naming the file', (_label, text) => {
    const root = initFixture('registry-gates-g7-bad-exemption-file')
    try {
      mkdirSync(join(root, '.vinaya'), { recursive: true })
      writeFileSync(join(root, '.vinaya', 'g7-exemptions.json'), text)
      expect(() => readG7Exemptions(root)).toThrow('.vinaya/g7-exemptions.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports the rule as dormant in a repository with no enforcement map, with no G7 finding', () => {
    const root = initFixture('registry-gates-g7-dormant')
    try {
      const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: root, env: { ...process.env } })
      expect(result.exitCode).toBe(0)
      const stderr = result.stderr.toString()
      expect(stderr).toContain('"check":"registry-gates.dormant"')
      expect(stderr).not.toContain('registry-gates.G7')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it("the check emits no G7 finding on this repository's own tree", () => {
    const result = Bun.spawnSync(['bun', BIN_PATH], { cwd: repoRoot, env: { ...process.env } })
    expect(result.stderr.toString()).not.toContain('registry-gates.G7')
  }, 20_000)

  it('follows a check program through the kernel to the kernel sink', () => {
    const root = initFixture('registry-gates-g7-kernel')
    const checkBin = 'harness/processes/vinaya-strict/checks/bin/check-demo.ts'
    try {
      mkdirSync(join(root, 'harness/processes/vinaya-strict/checks/bin'), { recursive: true })
      mkdirSync(join(root, 'harness/kernel/log'), { recursive: true })
      writeFileSync(join(root, 'harness/kernel/log/log-sink.ts'), 'export function log(): void {}\n')
      writeFileSync(
        join(root, 'harness/kernel/control.ts'),
        "import { log } from './log/log-sink.js'\nexport const runControl = log\n"
      )
      writeFileSync(
        join(root, checkBin),
        "import { runControl } from '../../../../../harness/kernel/control.js'\nrunControl()\n"
      )
      const { producers, imports } = gatherLogProducerGraph(root)
      expect(producers.has('harness/kernel/control.ts')).toBe(true)
      expect(producers.has('apps/cli/src/lib/log-sink.ts')).toBe(false)
      expect(reachesProducer(checkBin, producers, imports)).toBe(true)
      const result = checkG7({
        enforcementMapPresent: true,
        crossingFiles: [],
        blockingFiles: [checkBin],
        producers,
        imports,
        exemptions: {},
        existsFn: (p) => existsSync(join(root, p))
      })
      expect(result.findings).toEqual([])
      expect(result.status).toBe('pass')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves kernel tests and non-TypeScript files out of the graph', () => {
    const root = initFixture('registry-gates-g7-kernel-tests')
    try {
      mkdirSync(join(root, 'harness/kernel/log'), { recursive: true })
      mkdirSync(join(root, 'harness/kernel/tests'), { recursive: true })
      writeFileSync(join(root, 'harness/kernel/log/log-sink.ts'), 'export function log(): void {}\n')
      for (const [path, specifier] of [
        ['tests/helper.ts', '../log/log-sink.js'],
        ['control.test.ts', './log/log-sink.js'],
        ['control.js', './log/log-sink.js']
      ] as const) {
        writeFileSync(join(root, 'harness/kernel', path), `import { log } from '${specifier}'\nlog()\n`)
      }
      const { producers, imports } = gatherLogProducerGraph(root)
      expect([...producers]).toEqual(['harness/kernel/log/log-sink.ts'])
      expect([...imports.keys()]).toEqual(['harness/kernel/log/log-sink.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the CLI sink as the fallback when neither sink exists', () => {
    const root = initFixture('registry-gates-g7-no-sink')
    const checkBin = 'harness/processes/vinaya-strict/checks/bin/check-demo.ts'
    try {
      mkdirSync(join(root, 'harness/processes/vinaya-strict/checks/bin'), { recursive: true })
      writeFileSync(join(root, checkBin), "import { log } from '../../lib/log-sink.js'\nlog()\n")
      const { producers, imports } = gatherLogProducerGraph(root)
      expect([...producers]).toEqual(['apps/cli/src/lib/log-sink.ts'])
      expect(imports.get(checkBin)).toEqual([])
      expect(reachesProducer(checkBin, producers, imports)).toBe(false)
      const result = checkG7({
        enforcementMapPresent: true,
        crossingFiles: [],
        blockingFiles: [checkBin],
        producers,
        imports,
        exemptions: {},
        existsFn: (p) => existsSync(join(root, p))
      })
      expect(result.status).toBe('fail')
      expect(result.findings.map((f) => f.path)).toEqual([checkBin])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("follows a check program's import through a process folder to the sink, and leaves that folder's tests out", () => {
    const root = join(tmpdir(), `vinaya-g7-process-folder-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const checkBin = 'harness/processes/vinaya-strict/checks/bin/check-demo.ts'
    const processModule = join(root, 'harness', 'processes', 'demo', 'run-control.ts')
    const write = (path: string, text: string) => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    const evaluate = () => {
      const { producers, imports } = gatherLogProducerGraph(root)
      const result = checkG7({
        enforcementMapPresent: true,
        crossingFiles: [],
        blockingFiles: [checkBin],
        producers,
        imports,
        exemptions: {},
        existsFn: (p) => existsSync(join(root, p))
      })
      return { producers, result }
    }
    try {
      write(join(root, 'apps', 'cli', 'src', 'lib', 'log-sink.ts'), 'export function log(): void {}\n')
      write(
        join(root, checkBin),
        "import { runControl } from '../../../../../harness/processes/demo/run-control.js'\nrunControl()\n"
      )
      write(
        processModule,
        "import { log } from '../../../apps/cli/src/lib/log-sink.js'\nexport function runControl(): void {\n  log()\n}\n"
      )
      write(
        join(root, 'harness', 'processes', 'demo', 'tests', 'helper.ts'),
        "import { log } from '../../../../harness/kernel/log/log-sink.js'\nexport const helper = log\n"
      )

      const withModule = evaluate()
      expect(withModule.producers.has('harness/processes/demo/run-control.ts')).toBe(true)
      expect(withModule.producers.has('harness/processes/demo/tests/helper.ts')).toBe(false)
      expect(withModule.result.findings).toEqual([])
      expect(withModule.result.status).toBe('pass')

      rmSync(processModule)
      const withoutModule = evaluate()
      expect(withoutModule.result.status).toBe('fail')
      expect(withoutModule.result.findings.map((f) => f.path)).toEqual([checkBin])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
