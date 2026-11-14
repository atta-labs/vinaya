import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOwnerMarker, removeTree } from '../../../kernel/conformance/unit/test-temp'
import type { Observation } from '../integration/conformance/unit/dev-review-current-loop-adapter'
import {
  applyFolderModes,
  copyTree,
  corpusKey,
  defaultStoreOptions,
  obtainEntry,
  peekEntry,
  sourceDigest,
  storedEngineScenario
} from './engine-corpus-store'

// A function, not a path constant: the child imports this module, and the test reads no folder of the repository.
const storeModule = (): string => join(import.meta.dir, 'engine-corpus-store.ts')
const PAYLOAD_BYTES = 1_000_000

function observation(decision: string): Observation {
  return {
    decision,
    refusal: null,
    durable: {
      pauseReason: null,
      pauseRound: null,
      infrastructureRetries: null,
      controlPhase: null,
      driverLockHeld: false,
      escalations: 0,
      resolutions: []
    },
    effects: {
      publishedRounds: [1],
      markers: [],
      developerDispatches: 1,
      codeReviewerDispatches: 1,
      securityDispatches: 1,
      commits: 0,
      pushes: 0,
      prOpens: 0
    },
    events: [],
    roundStartsByRound: {},
    journalResults: []
  }
}

/**
 * A separate test process asking the store for `key`: its computation records that it ran, waits `delayMs`, then
 * writes a large file into the entry, so a reader looking mid-write would see a partial one.
 */
const CHILD = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { obtainEntry } from ${JSON.stringify(storeModule())}
const [dir, key, label, delayMs] = process.argv.slice(2)
const run = await obtainEntry({ dir, ownerMarker: false }, key, async (filesDir) => {
  writeFileSync(join(dir, 'ran-' + label), '')
  await Bun.sleep(Number(delayMs))
  mkdirSync(filesDir)
  writeFileSync(join(filesDir, 'payload.bin'), Buffer.alloc(${PAYLOAD_BYTES}, 7))
  return { observation: { decision: 'computed by ' + label }, folderModes: { '': 0o755 } }
})
console.log(JSON.stringify({ reused: run.reused, decision: run.observation.decision }))
`

let scratch = ''
let childScript = ''
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'engine-corpus-store-test-')))
  childScript = join(scratch, 'child.ts')
  writeFileSync(childScript, CHILD)
})
afterEach(() => {
  removeTree(scratch)
})

function childArgs(dir: string, key: string, label: string, delayMs: number): string[] {
  return [process.execPath, childScript, dir, key, label, String(delayMs)]
}

function runChild(dir: string, key: string, label: string, delayMs = 0): { reused: boolean; decision: string } {
  const [command, ...args] = childArgs(dir, key, label, delayMs)
  const result = spawnSync(command!, args, { encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`child ${label} failed: ${result.stderr}`)
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { reused: boolean; decision: string }
}

describe('a second process reuses an entry without running the scenario', () => {
  it('the first process computes and publishes; a later one reads the entry and runs nothing', () => {
    const dir = join(scratch, 'store')
    const key = 'a'.repeat(64)
    expect(runChild(dir, key, 'first')).toEqual({ reused: false, decision: 'computed by first' })
    expect(runChild(dir, key, 'second')).toEqual({ reused: true, decision: 'computed by first' })
    expect(existsSync(join(dir, 'ran-first'))).toBe(true)
    expect(existsSync(join(dir, 'ran-second'))).toBe(false)
    const entry = peekEntry({ dir, ownerMarker: false }, key)
    expect(statSync(join(entry!.entryDir, 'files', 'payload.bin')).size).toBe(PAYLOAD_BYTES)
  })

  it('a real corpus run is stored once, and each inspection reads its own restored copy of the ended files', async () => {
    const store = { dir: join(scratch, 'store'), ownerMarker: false }
    const seen: { runtimeDir: string; trace: boolean; repo: boolean }[] = []
    const inspect = ({ runtimeDir, task }: { runtimeDir: string; task: number }) => {
      seen.push({
        runtimeDir,
        trace: existsSync(join(runtimeDir, 'engine-runs', String(task), 'trace.json')),
        repo: existsSync(join(runtimeDir, '..', 'repo', '.git'))
      })
    }
    const first = await storedEngineScenario('clean-completion', 'claude', { inspect }, store)
    const entry = readFileSync(
      join(store.dir, readdirSync(store.dir).find((n) => n.startsWith('engine-corpus-'))!, 'entry.json'),
      'utf8'
    )
    const second = await storedEngineScenario('clean-completion', 'claude', { inspect }, store)
    expect(second).toEqual(first)
    expect(first.decision).toBe('publish')
    expect(seen).toHaveLength(2)
    expect(seen.every((s) => s.trace && s.repo)).toBe(true)
    expect(seen[0]!.runtimeDir).not.toBe(seen[1]!.runtimeDir)
    // The restored copies are gone once inspected; the entry is the one the first call wrote.
    expect(seen.some((s) => existsSync(s.runtimeDir))).toBe(false)
    expect(JSON.parse(entry).observation).toEqual(first)
  }, 120_000)
})

describe('a changed source file produces a new key', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8'
    })

  it('a tracked edit, a new untracked file and the lockfile change the digest; ignored and outside files do not', () => {
    const repo = join(scratch, 'repo')
    mkdirSync(join(repo, 'harness', 'kernel'), { recursive: true })
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'harness', 'kernel', 'engine.ts'), 'export const a = 1\n')
    writeFileSync(join(repo, 'bun.lock'), 'lock 1\n')
    writeFileSync(join(repo, 'package.json'), '{}\n')
    writeFileSync(join(repo, '.gitignore'), 'harness/kernel/ignored.ts\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    expect(git(repo, 'commit', '-q', '-m', 'base').status).toBe(0)
    const base = sourceDigest(repo)
    expect(sourceDigest(repo)).toBe(base)

    // An uncommitted edit to a tracked source.
    writeFileSync(join(repo, 'harness', 'kernel', 'engine.ts'), 'export const a = 2\n')
    const edited = sourceDigest(repo)
    expect(edited).not.toBe(base)
    // A new untracked source under a covered folder.
    writeFileSync(join(repo, 'harness', 'kernel', 'added.ts'), 'export const b = 1\n')
    const added = sourceDigest(repo)
    expect(added).not.toBe(edited)
    // The lockfile and a workspace manifest.
    writeFileSync(join(repo, 'bun.lock'), 'lock 2\n')
    const locked = sourceDigest(repo)
    expect(locked).not.toBe(added)
    writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n')
    const manifest = sourceDigest(repo)
    expect(manifest).not.toBe(locked)
    // An ignored file and a file outside the covered folders change nothing.
    writeFileSync(join(repo, 'harness', 'kernel', 'ignored.ts'), 'ignored\n')
    writeFileSync(join(repo, 'docs', 'notes.md'), 'notes\n')
    expect(sourceDigest(repo)).toBe(manifest)

    const key = (sources: string) =>
      corpusKey({ scenario: 'clean-completion', runner: 'engine', agent: 'claude', sink: 'none', sources })
    expect(key(manifest)).not.toBe(key(base))
    expect(key(base)).toBe(key(base))
    // The sink kind, the agent and the runner are part of the key too.
    expect(
      corpusKey({ scenario: 'clean-completion', runner: 'engine', agent: 'claude', sink: 'recording', sources: base })
    ).not.toBe(key(base))
    expect(
      corpusKey({ scenario: 'clean-completion', runner: 'engine', agent: 'codex', sink: 'none', sources: base })
    ).not.toBe(key(base))
    expect(
      corpusKey({ scenario: 'clean-completion', runner: 'standalone', agent: null, sink: 'none', sources: base })
    ).not.toBe(key(base))
  })
})

describe('a torn write is never read', () => {
  it('two processes missing at once both compute; a reader sees no entry or a whole one, never a partial one', async () => {
    const dir = join(scratch, 'store')
    const key = 'b'.repeat(64)
    const children = ['one', 'two'].map((label) => {
      const [command, ...args] = childArgs(dir, key, label, 1500)
      return Bun.spawn([command!, ...args], { env: process.env, stdout: 'pipe', stderr: 'pipe' })
    })
    const final = join(dir, `engine-corpus-${key}`)
    let looks = 0
    let whole = 0
    while (children.some((child) => child.exitCode === null)) {
      if (existsSync(final)) {
        looks += 1
        const entry = peekEntry({ dir, ownerMarker: false }, key)
        expect(entry).not.toBeNull()
        expect(statSync(join(entry!.entryDir, 'files', 'payload.bin')).size).toBe(PAYLOAD_BYTES)
        whole += 1
      }
      await Bun.sleep(2)
    }
    const outputs = await Promise.all(
      children.map(async (child) => JSON.parse((await new Response(child.stdout).text()).trim()))
    )
    expect(children.map((child) => child.exitCode)).toEqual([0, 0])
    expect(existsSync(join(dir, 'ran-one')) && existsSync(join(dir, 'ran-two'))).toBe(true)
    // Both finished; exactly one entry was published, and every look at it found it whole.
    const winner = peekEntry({ dir, ownerMarker: false }, key)!
    expect(outputs.map((o) => o.decision)).toContain(winner.observation.decision)
    expect(whole).toBe(looks)
    // The loser's staging folder is gone.
    expect(readdirSync(dir).filter((n) => n.startsWith('.creating-'))).toEqual([])
  }, 60_000)

  it('a staging folder a writer left half-written, or an unreadable entry, is never read: the run is computed', async () => {
    const store = { dir: join(scratch, 'store'), ownerMarker: false }
    const key = 'c'.repeat(64)
    mkdirSync(join(store.dir, `.creating-engine-corpus-${key}-dead`), { recursive: true })
    writeFileSync(join(store.dir, `.creating-engine-corpus-${key}-dead`, 'entry.json'), '{"version":1,"key":"')
    expect(peekEntry(store, key)).toBeNull()
    let ran = 0
    const compute = async () => {
      ran += 1
      return { observation: observation('fresh'), folderModes: null }
    }
    expect((await obtainEntry(store, key, compute)).reused).toBe(false)
    expect(ran).toBe(1)
    expect((await obtainEntry(store, key, compute)).reused).toBe(true)
    expect(ran).toBe(1)

    // An entry under its final name whose record does not read whole is treated as absent.
    const other = 'd'.repeat(64)
    mkdirSync(join(store.dir, `engine-corpus-${other}`))
    writeFileSync(join(store.dir, `engine-corpus-${other}`, 'entry.json'), '{"version":1,"key":"dd')
    expect(peekEntry(store, other)).toBeNull()
    const served = await obtainEntry(store, other, compute)
    expect(served.reused).toBe(false)
    expect(served.observation.decision).toBe('fresh')
    expect(ran).toBe(2)
  })
})

describe('where entries live', () => {
  it('under a configured test-temp root with no owner marker; under the shared default root with one', async () => {
    expect(defaultStoreOptions({ VINAYA_TEST_TMP: join(scratch, 'run-root') })).toEqual({
      dir: join(scratch, 'run-root', 'vinaya'),
      ownerMarker: false
    })
    expect(defaultStoreOptions({ HOME: join(scratch, 'home') }).ownerMarker).toBe(true)
    const compute = async () => ({ observation: observation('x'), folderModes: null })
    const marked = await obtainEntry({ dir: join(scratch, 'marked'), ownerMarker: true }, 'e'.repeat(64), compute)
    expect(readOwnerMarker(marked.entryDir)?.owner.pid).toBe(process.pid)
    const unmarked = await obtainEntry({ dir: join(scratch, 'unmarked'), ownerMarker: false }, 'e'.repeat(64), compute)
    expect(readOwnerMarker(unmarked.entryDir)).toBeNull()
  })

  it('copies a read-only folder as it is, and restores its mode', () => {
    const from = join(scratch, 'from')
    mkdirSync(join(from, 'locked'), { recursive: true })
    writeFileSync(join(from, 'locked', 'file.txt'), 'kept\n')
    chmodSync(join(from, 'locked'), 0o555)
    const to = join(scratch, 'to')
    const modes = copyTree(from, to)
    expect(modes.locked).toBe(0o555)
    // The copy itself stays writable, so the store can always be removed.
    expect(statSync(join(to, 'locked')).mode & 0o777).toBe(0o700)
    applyFolderModes(to, modes)
    expect(statSync(join(to, 'locked')).mode & 0o777).toBe(0o555)
    expect(readFileSync(join(to, 'locked', 'file.txt'), 'utf8')).toBe('kept\n')
    chmodSync(join(from, 'locked'), 0o755)
  })
})
