// A plan over two committed revisions reads only those revisions: a dirty
// checkout, another branch or an advanced HEAD around them changes nothing,
// and the selection runs and records nothing.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitRepository, selectTests } from '../src/index.js'
import { fixture, headFiles, scenarioInput } from './fixture-repos.js'

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A child's environment with no git setting of this process. */
function bareEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, HOME: home }
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...bareEnv(cwd),
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x'
    }
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('a plan for two commits reads only those commits', () => {
  it('is unchanged by a dirty checkout, another branch and an advanced HEAD, and executes and records nothing', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[0] as (typeof fx.scenarios)[number]
    const repo = scratch('verification-git-')
    try {
      const marker = join(repo, 'executed.marker')
      // A test that would leave a mark if anything ran it.
      const tripwire = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`
      const base = { ...fx.files, 'packages/app/tests/tripwire.test.ts': tripwire }
      const head = { ...headFiles(fx, scenario), 'packages/app/tests/tripwire.test.ts': tripwire }
      git(repo, ['init', '-q', '-b', 'main'])
      writeTree(repo, base)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const baseSha = git(repo, ['rev-parse', 'HEAD'])
      writeTree(repo, head)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'head'])
      const headSha = git(repo, ['rev-parse', 'HEAD'])
      const records = join(repo, 'records/passing.json')
      writeTree(repo, { 'records/passing.json': '{ "passed": [] }\n' })

      const input = () => {
        const memory = scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
        return { ...memory, repo: gitRepository(repo) }
      }
      const first = selectTests(input())
      expect(first.required.map((t) => t.test)).toEqual(['packages/app/tests/square.test.ts'])
      // The same plan an in-memory reader of the same two trees gives.
      const inMemory = selectTests(
        scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
      )
      expect(first.identity).toBe(inMemory.identity)

      // Dirty the checkout, move to another branch, advance HEAD.
      writeFileSync(join(repo, 'packages/core/src/add.ts'), 'export function add() { return 0 }\n')
      writeFileSync(join(repo, 'packages/app/tests/untracked.test.ts'), 'export {}\n')
      git(repo, ['checkout', '-q', '-b', 'elsewhere'])
      writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\nAdvanced.\n')
      git(repo, ['commit', '-q', '-am', 'advance'])
      writeFileSync(join(repo, 'packages/core/src/mul.ts'), '// dirty again\n')
      const status = git(repo, ['status', '--porcelain'])
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const recordBefore = digest(records)

      const second = selectTests(input())
      expect(second.identity).toBe(first.identity)
      expect(git(repo, ['status', '--porcelain'])).toBe(status)
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(digest(records)).toBe(recordBefore)
      expect(readdirSync(repo)).not.toContain('executed.marker')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)
})
