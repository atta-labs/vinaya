import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DOCTRINE_REPO_PATHS, doctrineRepoPath, FRONT_DOOR_KEY } from '../../tools/doctrine/doctrine-map'
import { vinayaDoctrineIdentity } from './doctrine-version'
import { createVinayaLogSink } from './log-sink-factory'

const VERSION = '9.9.9-test'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A git repository holding the front door and one other doctrine page at their map source paths, plus one process code file. */
function repoWithDoctrine(): string {
  const repo = tempDir('vinaya-doctrine-version-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  write(repo, doctrineRepoPath(FRONT_DOOR_KEY), '# front door\n')
  write(repo, doctrineRepoPath('enforcement.md'), '# enforcement\n')
  write(repo, 'harness/processes/vinaya-strict/tools/code.ts', 'export {}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'doctrine')
  return repo
}

function commitChange(repo: string, path: string, content: string): void {
  write(repo, path, content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', `change ${path}`)
}

describe('vinayaDoctrineIdentity — the Log doctrine version rule', () => {
  it('is doctrine@<git hash-object of the ls-tree of every doctrine map source path> in a tree holding the front door', async () => {
    const repo = repoWithDoctrine()
    const listing = execFileSync('git', ['-C', repo, 'ls-tree', 'HEAD', '--', ...DOCTRINE_REPO_PATHS], {
      encoding: 'utf8'
    })
    const id = execFileSync('git', ['-C', repo, 'hash-object', '--stdin'], { input: listing, encoding: 'utf8' }).trim()
    expect(await vinayaDoctrineIdentity(repo, VERSION)).toBe(`doctrine@${id}`)
  })

  it('changes when a doctrine file changes, and never when other process code changes', async () => {
    const repo = repoWithDoctrine()
    const before = await vinayaDoctrineIdentity(repo, VERSION)
    commitChange(repo, 'harness/processes/vinaya-strict/tools/code.ts', 'export const changed = true\n')
    expect(await vinayaDoctrineIdentity(repo, VERSION)).toBe(before)
    commitChange(repo, doctrineRepoPath('enforcement.md'), '# enforcement, edited\n')
    const after = await vinayaDoctrineIdentity(repo, VERSION)
    expect(after).not.toBe(before)
    expect(after.startsWith('doctrine@')).toBe(true)
  })

  it('is the package version in a repository with no front door at its source path', async () => {
    const repo = tempDir('vinaya-doctrine-version-plain-')
    git(repo, 'init', '-q', '-b', 'main')
    expect(await vinayaDoctrineIdentity(repo, VERSION)).toBe(VERSION)
  })

  it('is the package version outside any git repository', async () => {
    expect(await vinayaDoctrineIdentity(tempDir('vinaya-doctrine-version-nogit-'), VERSION)).toBe(VERSION)
  })

  it('is unknown when git itself cannot be reached', async () => {
    const path = process.env.PATH
    process.env.PATH = tempDir('vinaya-doctrine-version-nopath-')
    try {
      expect(await vinayaDoctrineIdentity(repoWithDoctrineUnderOriginalPath(path), VERSION)).toBe('unknown')
    } finally {
      process.env.PATH = path
    }
  })
})

/** Builds the fixture before `PATH` is emptied — the fixture itself needs `git`. */
function repoWithDoctrineUnderOriginalPath(path: string | undefined): string {
  const emptied = process.env.PATH
  process.env.PATH = path
  try {
    return repoWithDoctrine()
  } finally {
    process.env.PATH = emptied
  }
}

function ndjsonUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...ndjsonUnder(full))
    else if (name.endsWith('.ndjson')) out.push(full)
  }
  return out
}

describe('createVinayaLogSink — supplies the Vinaya doctrine rule to the kernel sink', () => {
  it('records doctrine@<id> for a sink whose working directory holds the doctrine tree', async () => {
    const repo = repoWithDoctrine()
    const outbox = tempDir('vinaya-doctrine-version-outbox-')
    const sink = createVinayaLogSink({
      outboxRoot: () => outbox,
      resolveLogDestination: () => ({ kind: 'folder', folder: outbox }),
      home: () => outbox,
      hostname: () => 'test-host',
      cwd: () => repo,
      env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '7' }),
      resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
      vinayaVersion: () => VERSION,
      stderr: () => {}
    })
    sink.log({
      kind: 'dispatch',
      event: 'dispatched',
      payload: {},
      target_role: 'developer',
      model: 'sonnet',
      effect_id: 'e1',
      prompt_hash: 'sha256:abc'
    })
    await sink.drain()
    const [file] = ndjsonUnder(outbox)
    const meta = (
      JSON.parse(
        readFileSync(file as string, 'utf8')
          .trim()
          .split('\n')[0] as string
      ) as {
        meta: { doctrine: string }
      }
    ).meta
    expect(meta.doctrine).toBe(await vinayaDoctrineIdentity(repo, VERSION))
    expect(meta.doctrine.startsWith('doctrine@')).toBe(true)
  })
})
