// The package as an npm consumer gets it: `npm pack` builds the tarball, a
// fresh git repository outside this workspace installs it, and a selection
// runs there — this package's README example under Node, a selection over
// that repository's own two commits under both Node (the built `dist/`) and
// Bun (the shipped source), and the `test-selection` command under Node in a
// repository of one Bun package and one Vitest package.
import { describe, expect, it } from 'bun:test'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PACKAGE_DIR = resolve(import.meta.dir, '..')

/** A child's environment with no git, npm or Bun setting of this process and its own `HOME`. */
function bareEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv
  for (const [key, value] of Object.entries(process.env))
    if (!/^(GIT_|NPM_|npm_|BUN_|NODE_)/.test(key)) env[key] = value
  return {
    ...env,
    HOME: home,
    npm_config_cache: join(home, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GIT_AUTHOR_NAME: 'f',
    GIT_AUTHOR_EMAIL: 'f@x',
    GIT_COMMITTER_NAME: 'f',
    GIT_COMMITTER_EMAIL: 'f@x'
  }
}

function run(command: string, args: string[], cwd: string, home: string, timeout = 120_000): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: bareEnv(home), timeout })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}:\n${result.stdout}\n${result.stderr}`)
  return result
}

/** The README's one runnable example, verbatim. */
function readmeExample(): string {
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## Example'))
  const match = /```js\n([\s\S]*?)```/.exec(section)
  if (!match) throw new Error('README.md has no ```js example under ## Example')
  return match[1] as string
}

/** A selection over the fresh repository's own last two commits, through the git reader. */
const GIT_SELECTION = `import { execFileSync } from 'node:child_process'
import { gitRepository, inventoryViewOf, plannedTests, selectTests } from '@attalabs/test-selection'

const root = process.cwd()
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const base = git('rev-parse', 'HEAD~1')
const head = git('rev-parse', 'HEAD')
const repo = gitRepository(root)
const tree = (revision) => Object.fromEntries(repo.list(revision).map((path) => [path, repo.read(revision, path) ?? '']))
const declarations = { suites: [{ id: 'app', dir: '.', runner: 'bun', preload: null }], edges: [], unknowns: [], policies: [] }
const plan = selectTests({
  repo,
  base,
  head,
  inventory: { base: inventoryViewOf(base, tree(base), declarations), head: inventoryViewOf(head, tree(head), declarations) },
  policy: { depth: 'transitive' }
})
process.stdout.write(JSON.stringify({ planned: plannedTests(plan), resolver: plan.context.resolver, identity: plan.identity }))
`

/** The installed compiler package, as a real directory. */
const TYPESCRIPT_DIR = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')))

describe('a fresh repository installs the packed package and selects with it', () => {
  it('packs, installs the tarball, and runs the README example, a git selection and the command under Node and Bun', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'test-selection-consumer-')))
    try {
      // The tarball, exactly as `npm publish` would upload it.
      const packs = join(home, 'packs')
      mkdirSync(packs)
      run('npm', ['pack', '--pack-destination', packs], PACKAGE_DIR, home, 300_000)
      const tarballs = readdirSync(packs).filter((name) => name.endsWith('.tgz'))
      expect(tarballs).toHaveLength(1)
      const tarball = join(packs, tarballs[0] as string)
      const listing = run('tar', ['-tzf', tarball], home, home).stdout.split('\n').filter(Boolean)
      expect(listing).toContain('package/dist/index.js')
      expect(listing).toContain('package/dist/index.d.ts')
      expect(listing).toContain('package/src/index.ts')
      expect(listing).toContain('package/README.md')
      expect(listing.some((path) => path.startsWith('package/tests/'))).toBe(false)

      // A fresh repository, outside this workspace, with nothing but the installed tarball.
      const repo = join(home, 'consumer')
      mkdirSync(repo)
      writeFileSync(join(repo, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n')
      run('git', ['init', '-q', '-b', 'main'], repo, home)
      run('npm', ['install', '--offline', '--no-package-lock', tarball], repo, home, 300_000)
      const installed = join(repo, 'node_modules/@attalabs/test-selection')
      expect(existsSync(join(installed, 'dist/index.js'))).toBe(true)
      expect(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).dependencies).toHaveProperty(
        '@attalabs/test-selection'
      )

      // The README example, verbatim, under Node: the built `dist/`, no compiler installed.
      writeFileSync(join(repo, 'example.mjs'), readmeExample())
      expect(run('node', ['example.mjs'], repo, home).stdout.trim()).toBe('["tests/greet.test.ts"]')

      // The optional compiler peer, then a change committed in the repository itself.
      cpSync(TYPESCRIPT_DIR, join(repo, 'node_modules/typescript'), { recursive: true, dereference: true })
      const files: Record<string, string> = {
        '.gitignore': 'node_modules/\n',
        'src/greet.ts': 'export const greet = () => "hi"\n',
        'src/other.ts': 'export const other = 1\n',
        'tests/greet.test.ts': "import { greet } from '../src/greet'\n",
        'tests/other.test.ts': "import { other } from '../src/other'\n",
        'select.mjs': GIT_SELECTION
      }
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true })
        writeFileSync(join(repo, path), text)
      }
      run('git', ['add', '-A'], repo, home)
      run('git', ['commit', '-q', '-m', 'base'], repo, home)
      writeFileSync(join(repo, 'src/greet.ts'), 'export const greet = () => "hello"\n')
      run('git', ['commit', '-q', '-am', 'head'], repo, home)

      const underNode = JSON.parse(run('node', ['select.mjs'], repo, home).stdout)
      expect(underNode.planned).toEqual(['tests/greet.test.ts'])
      expect(underNode.resolver).toBe('compiler')
      // Bun loads the shipped source instead of `dist/`, and reaches the same plan.
      const underBun = JSON.parse(run('bun', ['select.mjs'], repo, home).stdout)
      expect(underBun).toEqual(underNode)

      // The command, in a fresh repository of one Bun package and one Vitest package, with no inventory written.
      expect(listing).toContain('package/dist/cli.js')
      const mono = join(home, 'mono')
      mkdirSync(mono)
      const monoFiles: Record<string, string> = {
        '.gitignore': 'node_modules/\n',
        'package.json': '{ "name": "mono", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
        'packages/app/package.json': '{ "name": "app", "scripts": { "test": "bun test" } }\n',
        'packages/app/src/greet.ts': 'export const greet = () => "hi"\n',
        'packages/app/src/other.ts': 'export const other = 1\n',
        'packages/app/tests/greet.test.ts': "import { greet } from '../src/greet'\n",
        'packages/app/tests/other.test.ts': "import { other } from '../src/other'\n",
        'packages/web/package.json': '{ "name": "web", "scripts": { "test": "vitest run" } }\n',
        'packages/web/src/view.ts': 'export const view = 1\n',
        'packages/web/src/list.ts': 'export const list = 1\n',
        'packages/web/tests/view.spec.ts': "import { view } from '../src/view'\n",
        'packages/web/tests/list.spec.ts': "import { list } from '../src/list'\n",
        'packages/docs/package.json': '{ "name": "docs" }\n',
        'packages/docs/check.test.ts': 'export {}\n'
      }
      for (const [path, text] of Object.entries(monoFiles)) {
        mkdirSync(dirname(join(mono, path)), { recursive: true })
        writeFileSync(join(mono, path), text)
      }
      run('git', ['init', '-q', '-b', 'main'], mono, home)
      run('npm', ['install', '--offline', '--no-package-lock', tarball], mono, home, 300_000)
      run('git', ['add', '-A'], mono, home)
      run('git', ['commit', '-q', '-m', 'base'], mono, home)
      writeFileSync(join(mono, 'packages/app/src/greet.ts'), 'export const greet = () => "hello"\n')
      writeFileSync(join(mono, 'packages/web/src/view.ts'), 'export const view = 2\n')
      run('git', ['commit', '-q', '-am', 'head'], mono, home)

      // Started in a member's folder, under Node, through the command npm linked.
      const command = join(mono, 'node_modules/.bin/test-selection')
      const status = run('git', ['status', '--porcelain', '--untracked-files=all'], mono, home).stdout
      const printed = JSON.parse(
        run('node', [command, '--base', 'HEAD~1', '--head', 'HEAD'], join(mono, 'packages/app'), home).stdout
      )
      expect(run('git', ['status', '--porcelain', '--untracked-files=all'], mono, home).stdout).toBe(status)
      expect(printed.tests).toEqual(['packages/app/tests/greet.test.ts', 'packages/web/tests/view.spec.ts'])
      expect(
        printed.groups.map((g: { runner: string; cwd: string; args: string[]; tests: string[] }) => ({
          runner: g.runner,
          cwd: g.cwd,
          args: g.args,
          tests: g.tests
        }))
      ).toEqual([
        {
          runner: 'bun',
          cwd: 'packages/app',
          args: ['./tests/greet.test.ts'],
          tests: ['packages/app/tests/greet.test.ts']
        },
        {
          runner: 'vitest',
          cwd: 'packages/web',
          args: ['tests/view.spec.ts'],
          tests: ['packages/web/tests/view.spec.ts']
        }
      ])
      expect(printed.fallbacks).toEqual([])
      expect(printed.leftOut).toEqual({
        packages: [
          { dir: '.', name: 'mono', reason: 'no-test-script', script: null },
          { dir: 'packages/docs', name: 'docs', reason: 'no-test-script', script: null }
        ],
        tests: ['packages/docs/check.test.ts']
      })

      // A missing argument or an unknown commit: one message on standard error, a non-zero exit, nothing printed.
      for (const args of [
        ['--base', 'HEAD~1'],
        ['--base', 'HEAD~1', '--head', 'no-such-commit']
      ]) {
        const refused = spawnSync('node', [command, ...args], { cwd: mono, encoding: 'utf8', env: bareEnv(home) })
        expect(refused.status).not.toBe(0)
        expect(refused.stdout).toBe('')
        expect(refused.stderr.trim().split('\n')).toHaveLength(1)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 600_000)
})
