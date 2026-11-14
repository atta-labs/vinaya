import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureDir } from '../../../../../kernel/conformance/unit/test-temp-fixture'
import {
  beginAgentTurn,
  clearingAfterEffects,
  endAgentTurn,
  gitReadKey,
  gitReadMemoServing,
  gitSubcommand,
  observeGitReads,
  runGit,
  servingDeveloperToolCall,
  withGitReadMemo
} from './git-read-memo'

// The round's git read memo on a real repository: each case counts the git processes `runGit` itself starts.

const plainGit = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

function repository(): string {
  const dir = fixtureDir('git-read-memo-')
  plainGit(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  plainGit(dir, 'add', '-A')
  plainGit(dir, 'commit', '-q', '-m', 'base')
  return dir
}

/** `runGit` with a real git behind it and a count of the processes it started. */
function counted(): { read: (cwd: string, ...args: string[]) => string; spawns: () => number } {
  let spawns = 0
  return {
    read: (cwd, ...args) =>
      runGit(cwd, args, () => {
        spawns += 1
        return plainGit(cwd, ...args)
      }),
    spawns: () => spawns
  }
}

const commit = (dir: string, content: string): string => {
  writeFileSync(join(dir, 'a.txt'), content)
  plainGit(dir, 'commit', '-q', '-am', content)
  return plainGit(dir, 'rev-parse', 'HEAD')
}

const stops: Array<() => void> = []
let runningTurns = 0
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  // A failed case must never leave a turn in flight for the next.
  for (; runningTurns > 0; runningTurns--) endAgentTurn()
})

describe('within a driver step', () => {
  test('a repeated read starts one git process', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      const first = git.read(dir, 'rev-parse', 'HEAD')
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(first)
      expect(git.read(dir, 'merge-base', 'HEAD', 'HEAD')).toBe(first)
      expect(git.read(dir, 'merge-base', 'HEAD', 'HEAD')).toBe(first)
    })
    expect(git.spawns()).toBe(2)
  })

  test('a write through it clears the memo, and the next read sees the new head', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      const before = git.read(dir, 'rev-parse', 'HEAD')
      writeFileSync(join(dir, 'a.txt'), 'two\n')
      git.read(
        dir,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-am',
        'two'
      )
      const after = git.read(dir, 'rev-parse', 'HEAD')
      expect(after).not.toBe(before)
      expect(after).toBe(plainGit(dir, 'rev-parse', 'HEAD'))
    })
    expect(git.spawns()).toBe(3)
  })

  test('a different working directory is a different entry', async () => {
    const one = repository()
    const two = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      expect(git.read(one, 'rev-parse', 'HEAD')).toBe(plainGit(one, 'rev-parse', 'HEAD'))
      expect(git.read(two, 'rev-parse', 'HEAD')).toBe(plainGit(two, 'rev-parse', 'HEAD'))
    })
    expect(git.spawns()).toBe(2)
    // The same arguments under another cwd, and `-C` beside the cwd, are other keys.
    expect(gitReadKey(one, ['rev-parse', 'HEAD'])).not.toBe(gitReadKey(two, ['rev-parse', 'HEAD']))
    expect(gitReadKey(one, ['-C', two, 'rev-parse', 'HEAD'])).not.toBe(
      gitReadKey(two, ['-C', two, 'rev-parse', 'HEAD'])
    )
    expect(gitReadKey(undefined, ['rev-parse', 'HEAD'])).toBe(gitReadKey(process.cwd(), ['rev-parse', 'HEAD']))
  })

  test('a remote read, a working-tree read and a failed read are never kept', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      for (let i = 0; i < 2; i++) {
        git.read(dir, 'status', '--porcelain')
        expect(() => git.read(dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/absent')).toThrow()
        expect(() => git.read(dir, 'ls-remote', 'origin', 'HEAD')).toThrow()
      }
    })
    expect(git.spawns()).toBe(6)
    expect(gitSubcommand(['-C', dir, '-c', 'a=b', 'ls-remote', 'origin'])).toBe('ls-remote')
  })

  test('each step starts from an empty memo', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      git.read(dir, 'rev-parse', 'HEAD')
    })
    await withGitReadMemo(async () => {
      git.read(dir, 'rev-parse', 'HEAD')
    })
    expect(git.spawns()).toBe(2)
  })
})

describe('outside a driver step', () => {
  test('every read starts git, as the standalone runner always has', () => {
    const dir = repository()
    const git = counted()
    expect(gitReadMemoServing()).toBe(false)
    git.read(dir, 'rev-parse', 'HEAD')
    git.read(dir, 'rev-parse', 'HEAD')
    expect(git.spawns()).toBe(2)
  })
})

describe('agent turns and Developer tool calls', () => {
  test('a read during an agent turn starts git, and a commit the agent made is seen by the next read', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      const before = git.read(dir, 'rev-parse', 'HEAD')
      beginAgentTurn()
      runningTurns += 1
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(before)
      // The agent commits with its own git, which never passes through the memo.
      const committed = commit(dir, 'by the agent\n')
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(committed)
      endAgentTurn()
      runningTurns -= 1
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(committed)
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(committed)
    })
    // Before the turn, twice in it, and once after it.
    expect(git.spawns()).toBe(4)
  })

  test('a read during a Developer tool call starts git, and the memo is emptied around the call', async () => {
    const dir = repository()
    const git = counted()
    await withGitReadMemo(async () => {
      git.read(dir, 'rev-parse', 'HEAD')
      const inCall = await servingDeveloperToolCall(async () => {
        expect(gitReadMemoServing()).toBe(false)
        git.read(dir, 'rev-parse', 'HEAD')
        return commit(dir, 'during the tool call\n')
      })
      expect(gitReadMemoServing()).toBe(true)
      expect(git.read(dir, 'rev-parse', 'HEAD')).toBe(inCall)
      expect(() =>
        servingDeveloperToolCall(() => {
          throw new Error('refused')
        })
      ).toThrow('refused')
      expect(gitReadMemoServing()).toBe(true)
    })
    expect(git.spawns()).toBe(3)
  })
})

describe('effects a step calls', () => {
  test('a call that is not a named read empties the memo; a named read does not', async () => {
    const dir = repository()
    mkdirSync(join(dir, 'sub'))
    const git = counted()
    const effects = clearingAfterEffects(
      { write: () => 'written', read: () => 'read', later: async () => 'later' },
      new Set(['read'])
    )
    expect(clearingAfterEffects(effects, new Set(['read']))).toBe(effects)
    const cleared: string[] = []
    stops.push(observeGitReads((event) => (event.kind === 'clear' ? cleared.push(event.reason) : undefined)))
    await withGitReadMemo(async () => {
      git.read(dir, 'rev-parse', 'HEAD')
      effects.read()
      git.read(dir, 'rev-parse', 'HEAD')
      expect(git.spawns()).toBe(1)
      effects.write()
      git.read(dir, 'rev-parse', 'HEAD')
      expect(git.spawns()).toBe(2)
      await effects.later()
      git.read(dir, 'rev-parse', 'HEAD')
      expect(git.spawns()).toBe(3)
    })
    expect(cleared).toContain('call write')
    expect(cleared).toContain('call later')
    expect(cleared).not.toContain('call read')
  })
})
