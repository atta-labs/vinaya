#!/usr/bin/env node
/** Writes the default-branch recording workflow. Never imported by the entrypoint. */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORD_ARTIFACT_PREFIX, RECORD_WORKFLOW_FILE } from './record-fetch.js'
import { RECORD_FILE } from './recorder.js'

const LOCKFILES = {
  bun: ['bun.lock', 'bun.lockb'],
  npm: ['package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock']
}
type PackageManager = keyof typeof LOCKFILES

const USAGE = 'usage: test-selection-setup [--branch <name>] [--package-manager <bun|npm|pnpm|yarn>] [--help]'

function usageError(message: string): Error {
  return new Error(`${message}. ${USAGE}`)
}

function git(args: string[], cwd?: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function inferPackageManager(root: string): PackageManager {
  const managers = (Object.keys(LOCKFILES) as PackageManager[]).filter((manager) =>
    LOCKFILES[manager].some((file) => existsSync(join(root, file)))
  )
  const [manager, extra] = managers
  if (!manager) throw new Error('no package manager lockfile found; pass --package-manager')
  if (extra) throw new Error('multiple package manager lockfiles found; pass --package-manager')
  return manager
}

function workflow(root: string, branch: string, manager: PackageManager): string {
  const installs = {
    bun: ['bun install --frozen-lockfile'],
    npm: ['npm ci'],
    pnpm: ['corepack enable', 'pnpm install --frozen-lockfile'],
    yarn: [
      'corepack enable',
      existsSync(join(root, '.yarnrc.yml')) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'
    ]
  }
  const start = { bun: 'npx', npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn run' }
  // Git ref validation excludes other glob metacharacters. Quote the pattern for YAML.
  const pattern = branch.replace(/[+!\]]/g, '\\$&').replaceAll("'", "''")
  return [
    'on:',
    '  push:',
    `    branches: ['${pattern}']`,
    'permissions:',
    '  contents: read',
    'jobs:',
    '  record-reads:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    '      - uses: oven-sh/setup-bun@v2',
    ...installs[manager].map((line) => `      - run: ${line}`),
    '      - run: sudo apt-get update',
    '      - run: sudo apt-get install -y strace',
    `      - run: ${start[manager]} test-selection-record --out "$RUNNER_TEMP/read-record" --summary "$GITHUB_STEP_SUMMARY"`,
    '      - uses: actions/upload-artifact@v4',
    '        with:',
    `          name: ${RECORD_ARTIFACT_PREFIX}\${{ github.sha }}`,
    `          path: \${{ runner.temp }}/read-record/${RECORD_FILE}`,
    '          retention-days: 60',
    ''
  ].join('\n')
}

function setup(args: string[]): void {
  let branch: string | undefined
  let manager: PackageManager | undefined
  let help = false
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    if (flag === '--help' || flag === '-h') {
      help = true
      continue
    }
    if (flag !== '--branch' && flag !== '--package-manager') throw usageError(`unknown flag ${JSON.stringify(flag)}`)
    const value = args[++i]
    if (!value || value.startsWith('-')) throw usageError(`${flag} requires a value`)
    if (flag === '--branch') {
      if (git(['check-ref-format', `refs/heads/${value}`]).status !== 0) {
        throw usageError(`invalid --branch value ${JSON.stringify(value)}`)
      }
      branch = value
    } else {
      if (!Object.hasOwn(LOCKFILES, value)) throw usageError('--package-manager must be bun, npm, pnpm or yarn')
      manager = value as PackageManager
    }
  }

  if (help) {
    process.stdout.write(
      `${USAGE}\n` +
        '  --branch <name>                       Branch to record (default: origin/HEAD).\n' +
        '  --package-manager <bun|npm|pnpm|yarn>  Package manager (default: infer from root lockfiles).\n' +
        '  --help, -h                            Print help.\n'
    )
    return
  }

  const repo = git(['rev-parse', '--show-toplevel'])
  if (repo.status !== 0) throw new Error('start this command inside a git repository')
  const root = repo.stdout.replace(/\r?\n$/, '')
  if (branch === undefined) {
    const prefix = 'refs/remotes/origin/'
    const remote = git(['symbolic-ref', `${prefix}HEAD`], root)
    if (remote.status !== 0 || !remote.stdout.startsWith(prefix)) {
      throw new Error('no default branch from origin/HEAD; pass --branch')
    }
    branch = remote.stdout.replace(/\r?\n$/, '').slice(prefix.length)
    if (git(['check-ref-format', `refs/heads/${branch}`], root).status !== 0) {
      throw new Error(`invalid --branch value ${JSON.stringify(branch)}`)
    }
  }

  const text = workflow(root, branch, manager ?? inferPackageManager(root))
  const relative = `.github/workflows/${RECORD_WORKFLOW_FILE}`
  const file = join(root, relative)
  for (const dir of ['.github', '.github/workflows']) {
    const path = join(root, dir)
    try {
      mkdirSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!lstatSync(path).isDirectory()) throw new Error(`${dir} must be a directory inside the repository`)
    }
  }
  try {
    writeFileSync(file, text, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(file).isFile()) throw new Error(`${relative} already exists and is not a regular file`)
    if (!readFileSync(file).equals(Buffer.from(text))) throw new Error(`${relative} already exists with different text`)
    process.stdout.write(`${relative} is unchanged\n`)
    return
  }
  process.stdout.write(`${relative}\n`)
}

try {
  setup(process.argv.slice(2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`test-selection-setup: ${message.replace(/[\r\n]+/g, ' ')}\n`)
  process.exitCode = 2
}
