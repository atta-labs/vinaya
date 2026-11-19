// The package as an npm consumer gets it: `npm pack` builds the tarball, a
// fresh git repository outside this workspace installs it, and a selection
// runs there — this package's README example under Node, a selection over
// that repository's own two commits under both Node (the built `dist/`) and
// Bun (the shipped source), and the `test-selection` command under Node in a
// repository of one Bun package and one Vitest package, then with a read
// record (`--record`) and a consumer config (`--config`) in a second one; and
// the `test-selection-record` command and a direct preload of the shipped probe.
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

function expectHelp(command: string, args: string[], home: string, usage: string, flags: string[]): void {
  const help = spawnSync('node', [command, ...args], { cwd: home, encoding: 'utf8', env: bareEnv(home) })
  expect(help.status).toBe(0)
  expect(help.stderr).toBe('')
  const [firstLine, ...details] = help.stdout.split('\n')
  expect(firstLine).toBe(usage)
  const documented = details.map((line) => line.trimStart().split(/[ ,]/)[0])
  for (const flag of flags) expect(documented).toContain(flag)
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
      const selection = run('node', [command, '--base', 'HEAD~1', '--head', 'HEAD'], join(mono, 'packages/app'), home)
      const printed = JSON.parse(selection.stdout)
      expect(selection.stderr).toBe(
        'test-selection: warning: left out 0 package(s) with unsupported runners and 1 test file(s) under no suite\n'
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

      for (const args of [['--help'], ['--base', 'HEAD~1', '--head', 'HEAD', '--config', '-h']]) {
        expectHelp(
          command,
          args,
          home,
          'usage: test-selection --base <commit> --head <commit> [--record <file> | --fetch-record] [--config <file>] [--help]',
          ['--base', '--head', '--record', '--fetch-record', '--config', '--help']
        )
      }

      writeFileSync(join(mono, 'packages/docs/package.json'), '{ "name": "docs", "scripts": { "test": "jest" } }\n')
      run('git', ['commit', '-q', '-am', 'use Jest for docs'], mono, home)
      const jest = run('node', [command, '--base', 'HEAD~1', '--head', 'HEAD'], mono, home)
      expect(jest.stderr).toBe(
        'test-selection: warning: left out 1 package(s) with unsupported runners and 1 test file(s) under no suite\n'
      )

      // The command with a read record and a consumer config, in a fresh repository whose head commit changes only
      // a data file one test reads without importing it, and whose next commit adds a test with its own data file.
      const cfg = join(home, 'cfg')
      mkdirSync(cfg)
      const cfgFiles: Record<string, string> = {
        'package.json': '{ "name": "cfg", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
        'packages/app/package.json': '{ "name": "app", "scripts": { "test": "bun test" } }\n',
        'packages/app/src/a.ts': 'export const a = 1\n',
        'packages/app/src/b.ts': 'export const b = 1\n',
        'packages/app/tests/a.test.ts': "import { a } from '../src/a'\n",
        'packages/app/tests/b.test.ts': "import { b } from '../src/b'\n",
        'packages/app/data/table.json': '{ "rows": 1 }\n',
        'packages/lib/package.json': '{ "name": "lib", "scripts": { "test": "bun test" } }\n',
        'packages/lib/src/l.ts': 'export const l = 1\n',
        'packages/lib/tests/l.test.ts': "import { l } from '../src/l'\n"
      }
      const writeAll = (root: string, entries: Record<string, string>) => {
        for (const [path, text] of Object.entries(entries)) {
          mkdirSync(dirname(join(root, path)), { recursive: true })
          writeFileSync(join(root, path), text)
        }
      }
      writeAll(cfg, cfgFiles)
      run('git', ['init', '-q', '-b', 'main'], cfg, home)
      run('git', ['add', '-A'], cfg, home)
      run('git', ['commit', '-q', '-m', 'base'], cfg, home)
      const cfgBase = run('git', ['rev-parse', 'HEAD'], cfg, home).stdout.trim()
      writeFileSync(join(cfg, 'packages/app/data/table.json'), '{ "rows": 2 }\n')
      run('git', ['commit', '-q', '-am', 'head'], cfg, home)
      const cfgHead = run('git', ['rev-parse', 'HEAD'], cfg, home).stdout.trim()
      writeAll(cfg, { 'packages/app/tests/c.test.ts': 'export {}\n', 'packages/app/data/c.json': '{}\n' })
      run('git', ['add', '-A'], cfg, home)
      run('git', ['commit', '-q', '-m', 'adds a test and its data'], cfg, home)
      const cfgAdded = run('git', ['rev-parse', 'HEAD'], cfg, home).stdout.trim()

      // The record and the configs live outside the repository, as a CI job's downloaded files do.
      const side = (name: string, value: unknown): string => {
        const path = join(home, name)
        writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
        return path
      }
      const readRecord = side('record.json', {
        schema: 'vinaya.read-record',
        schemaVersion: 1,
        commit: cfgBase,
        platform: 'linux',
        tests: {
          'packages/app/tests/a.test.ts': {
            reads: ['packages/app/tests/a.test.ts', 'packages/app/src/a.ts', 'packages/app/data/table.json'],
            listed: []
          },
          'packages/app/tests/b.test.ts': {
            reads: ['packages/app/tests/b.test.ts', 'packages/app/src/b.ts'],
            listed: []
          },
          'packages/lib/tests/l.test.ts': {
            reads: ['packages/lib/tests/l.test.ts', 'packages/lib/src/l.ts'],
            listed: []
          }
        }
      })
      const inputs = [
        { path: 'packages/app/data/table.json', readers: ['packages/app/tests/a.test.ts'] },
        { path: 'packages/app/data/c.json', readers: ['packages/app/tests/c.test.ts'] }
      ]
      const inputsConfig = side('inputs.json', { inputs })
      const policyConfig = side('policy.json', {
        depth: 'transitive',
        inputs,
        alwaysRun: [
          { id: 'smoke', reason: 'the smoke test runs on every change', tests: ['packages/lib/tests/*.test.ts'] }
        ],
        wholeSuites: [{ suite: 'app', reason: 'app tests read the whole package' }]
      })
      const select = (base: string, head: string, ...flags: string[]) =>
        JSON.parse(run('node', [command, '--base', base, '--head', head, ...flags], cfg, home).stdout)
      const everyTest = ['packages/app/tests/a.test.ts', 'packages/app/tests/b.test.ts', 'packages/lib/tests/l.test.ts']

      // No flag: no import reaches the data file, so a fallback scope runs every test — the plan as before.
      const unflagged = select(cfgBase, cfgHead)
      expect(unflagged.tests).toEqual(everyTest)
      expect(select(cfgBase, cfgHead, '--config', side('empty.json', {}))).toEqual(unflagged)
      // The record: the one test that read the data file, alone.
      const recorded = select(cfgBase, cfgHead, '--record', readRecord)
      expect(recorded.tests).toEqual(['packages/app/tests/a.test.ts'])
      expect(recorded.fallbacks).toEqual([])
      // --fetch-record, with a stand-in `gh` first on the PATH that serves the record from files the test wrote.
      const ghDir = join(home, 'gh-stand-in')
      mkdirSync(ghDir)
      writeFileSync(
        join(ghDir, 'gh'),
        `#!/bin/sh
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
echo "$*" >>"$here/calls"
case "$1 $2" in
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "run list") if [ -f "$here/fail" ]; then echo 'gh: HTTP 401' >&2; exit 1; fi; echo '[{"databaseId":1}]' ;;
  "run download")
    while [ $# -gt 0 ]; do if [ "$1" = "--dir" ]; then dir=$2; fi; shift; done
    cp "$here/record.json" "$dir/read-record.json" ;;
  *) exit 1 ;;
esac
`,
        { mode: 0o755 }
      )
      cpSync(readRecord, join(ghDir, 'record.json'))
      const withGh = { ...bareEnv(home), PATH: `${ghDir}:${process.env.PATH}` }
      const callsOf = () => (existsSync(join(ghDir, 'calls')) ? readFileSync(join(ghDir, 'calls'), 'utf8') : '')
      const fetching = (...flags: string[]) =>
        spawnSync('node', [command, '--base', cfgBase, '--head', cfgHead, ...flags], {
          cwd: cfg,
          encoding: 'utf8',
          env: withGh
        })
      const cfgStatus = () => run('git', ['status', '--porcelain', '--untracked-files=all'], cfg, home).stdout
      const treeBefore = cfgStatus()
      const keptDir = join(cfg, '.git/test-selection/read-records')
      // No flag: no `gh`, no kept file, no record line.
      const plain = fetching()
      expect(plain.status).toBe(0)
      expect(plain.stderr).toBe('')
      expect(JSON.parse(plain.stdout).leftOut).toEqual({
        packages: [{ dir: '.', name: 'cfg', reason: 'no-test-script', script: null }],
        tests: []
      })
      expect(callsOf()).toBe('')
      expect(existsSync(keptDir)).toBe(false)
      // The flag: the plan equals the `--record` plan, the record is kept, the line is on standard error only.
      const fetched = fetching('--fetch-record')
      expect(fetched.status).toBe(0)
      expect(fetched.stderr).toBe(`test-selection: record: ${cfgBase} fetched\n`)
      expect(JSON.parse(fetched.stdout)).toEqual(recorded)
      expect(existsSync(join(keptDir, `${cfgBase}.json`))).toBe(true)
      expect(cfgStatus()).toBe(treeBefore)
      // A second run uses the kept record and starts `gh` no more.
      const callsAfterFirst = callsOf()
      const keptRun = fetching('--fetch-record')
      expect(keptRun.stderr).toBe(`test-selection: record: ${cfgBase} kept\n`)
      expect(JSON.parse(keptRun.stdout)).toEqual(recorded)
      expect(callsOf()).toBe(callsAfterFirst)
      // A failing `gh` with nothing kept: the plan without a record, exit 0, one `no record` line.
      rmSync(keptDir, { recursive: true, force: true })
      writeFileSync(join(ghDir, 'fail'), '')
      const failed = fetching('--fetch-record')
      expect(failed.status).toBe(0)
      expect(failed.stderr).toMatch(/^test-selection: no record: .+\n$/)
      expect(failed.stderr.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(failed.stdout)).toEqual(unflagged)
      // Both record flags: one message, exit 2, nothing printed.
      const both = fetching('--fetch-record', '--record', readRecord)
      expect(both.status).toBe(2)
      expect(both.stdout).toBe('')
      expect(both.stderr.trim().split('\n')).toHaveLength(1)
      expect(both.stderr).toContain('--fetch-record and --record cannot be used together')
      expect(cfgStatus()).toBe(treeBefore)

      // A declared input reaches its reader.
      expect(select(cfgBase, cfgHead, '--config', inputsConfig).tests).toEqual(['packages/app/tests/a.test.ts'])
      // An always-run obligation and a whole-suite policy add their tests, with no fallback scope behind them.
      const policed = select(cfgBase, cfgHead, '--config', policyConfig)
      expect(policed.tests).toEqual(everyTest)
      expect(policed.fallbacks).toEqual([])
      // A head adding a test with its declared input, and a head that deleted a test still named, print a plan.
      expect(select(cfgHead, cfgAdded, '--config', inputsConfig).tests).toEqual(['packages/app/tests/c.test.ts'])
      expect(select(cfgAdded, cfgHead, '--config', inputsConfig).tests).toEqual([])

      // A bad record or a bad config: one message naming what is wrong, exit 2, nothing printed.
      for (const [flags, message] of [
        [['--record', join(home, 'no-such-record.json')], 'cannot be read'],
        [['--record', side('not-a-record.json', { tests: {} })], 'is not a read record'],
        [['--config', side('unknown-key.json', { depht: 'one' })], 'depht is not a known key'],
        [['--config', side('wrong-shape.json', { inputs: [{ path: 'x', readers: 'y' }] })], 'inputs[0].readers'],
        [['--config', side('bad-depth.json', { depth: 'deep' })], 'depth is not'],
        [['--config', side('not-json.json', '{')], 'is not a JSON document']
      ] as [string[], string][]) {
        const refused = spawnSync('node', [command, '--base', cfgBase, '--head', cfgHead, ...flags], {
          cwd: cfg,
          encoding: 'utf8',
          env: bareEnv(home)
        })
        expect(refused.status).toBe(2)
        expect(refused.stdout).toBe('')
        expect(refused.stderr.trim().split('\n')).toHaveLength(1)
        expect(refused.stderr).toContain(message)
      }

      // The root uses Jest, while all test files still belong to member suites.
      const cfgManifestPath = join(cfg, 'package.json')
      const cfgManifest = JSON.parse(readFileSync(cfgManifestPath, 'utf8'))
      cfgManifest.scripts = { test: 'jest' }
      writeFileSync(cfgManifestPath, JSON.stringify(cfgManifest))
      run('git', ['commit', '-q', '-am', 'use Jest at the root'], cfg, home)
      const runnerOnly = run('node', [command, '--base', cfgAdded, '--head', 'HEAD'], cfg, home)
      expect(runnerOnly.stderr).toBe(
        'test-selection: warning: left out 1 package(s) with unsupported runners and 0 test file(s) under no suite\n'
      )

      // The record command, linked by npm, under Node: the built `dist/`, with the probe's source shipped beside it.
      expect(listing).toContain('package/dist/record-command.js')
      expect(listing).toContain('package/src/listing-probe.ts')
      expect(listing).toContain('package/src/listing-probe-paths.ts')
      const recorder = join(mono, 'node_modules/.bin/test-selection-record')
      const usage = spawnSync('node', [recorder], { cwd: mono, encoding: 'utf8', env: bareEnv(home) })
      expect(usage.status).toBe(2)
      expect(usage.stderr.startsWith('usage: test-selection-record --out <dir>')).toBe(true)
      for (const args of [['-h'], ['--shard', 'invalid', '--out', '--help']]) {
        expectHelp(
          recorder,
          args,
          home,
          'usage: test-selection-record --out <dir> [--commit <sha>] [--concurrency <n>] [--shard <i>/<n>] [--only <test,test>] [--expect <test>=<path>] [--summary <file>] [--help]',
          ['--out', '--commit', '--concurrency', '--shard', '--merge', '--only', '--expect', '--summary', '--help']
        )
      }
      const out = join(home, 'record')
      const recording = spawnSync('node', [recorder, '--out', out, '--only', 'packages/app/tests/none.test.ts'], {
        cwd: mono,
        encoding: 'utf8',
        env: bareEnv(home)
      })
      if (process.platform !== 'linux') {
        expect(recording.status).toBe(2)
        expect(recording.stderr).toBe('test-selection-record: the recorder runs on Linux only (strace)\n')
        expect(existsSync(out)).toBe(false)
      } else if (spawnSync('strace', ['-V'], { stdio: 'ignore' }).status !== 0) {
        expect(recording.status).toBe(2)
        expect(recording.stderr).toBe(
          'test-selection-record: strace cannot be started: the recorder traces every test with it\n'
        )
      } else {
        expect(recording.status).toBe(0)
        const record = JSON.parse(readFileSync(join(out, 'read-record.json'), 'utf8'))
        expect(record).toMatchObject({ schema: 'vinaya.read-record', schemaVersion: 2, tests: {} })
      }

      // The shipped probe, copied from the installed package under Node and preloaded directly by Bun, logs a listing.
      const probeDir = join(home, 'probe')
      mkdirSync(probeDir)
      writeFileSync(
        join(mono, 'copy-probe.mjs'),
        "import { copyListingProbe } from '@attalabs/test-selection'\nprocess.stdout.write(copyListingProbe(process.argv[2]))\n"
      )
      const probe = run('node', ['copy-probe.mjs', probeDir], mono, home).stdout
      expect(probe).toBe(join(probeDir, 'listing-probe.ts'))
      writeFileSync(join(mono, 'lists.mjs'), "import { readdirSync } from 'node:fs'\nreaddirSync('packages')\n")
      const log = join(probeDir, 'probe.jsonl')
      const probed = spawnSync('bun', ['--preload', probe, 'lists.mjs'], {
        cwd: mono,
        encoding: 'utf8',
        env: { ...bareEnv(home), VINAYA_LISTING_PROBE_LOG: log }
      })
      expect(probed.status).toBe(0)
      const lines = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(lines[0]).toMatchObject({ start: true })
      expect(lines.some((line) => line.list === join(realpathSync(mono), 'packages') && line.recursive === false)).toBe(
        true
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 600_000)
})
