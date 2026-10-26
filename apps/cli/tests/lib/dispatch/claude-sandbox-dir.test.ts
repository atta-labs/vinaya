import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_SANDBOX_PREFIX, mintClaudeScratchDir, releaseClaudeScratchDir } from '../../../src/lib/dispatch'
import type { StopReport } from '../../../src/lib/process-registry'
import { currentOwner, readOwnerMarker, writeOwnerMarker } from '../../../src/lib/test-temp'
import { fixtureDir } from '../test-temp-fixture'

const noStop = async (): Promise<StopReport> => ({ backend: 'registry', terminated: [], killed: [], alreadyGone: [] })

describe('a Claude dispatch sandbox scratch directory', () => {
  test('is marked with the minting driver as its owner', async () => {
    const parent = fixtureDir('sandbox-parent-')
    const dir = await mintClaudeScratchDir('effect-1', () => {}, parent, { stop: noStop })
    expect(dir.startsWith(join(parent, CLAUDE_SANDBOX_PREFIX))).toBe(true)
    expect(readOwnerMarker(dir)?.owner).toEqual(currentOwner('effect-1'))
  })

  test('is removed after the sandbox made part of it read-only, and a failure is reported', () => {
    const dir = join(fixtureDir('sandbox-parent-'), `${CLAUDE_SANDBOX_PREFIX}x`)
    mkdirSync(join(dir, 'tmp', 'gomod'), { recursive: true })
    writeFileSync(join(dir, 'tmp', 'gomod', 'go.mod'), 'module x')
    chmodSync(join(dir, 'tmp', 'gomod'), 0o500)
    const lines: string[] = []
    releaseClaudeScratchDir(dir, (line) => lines.push(line))
    expect(lines).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })

  test("a dead driver's directory is swept at the next mint; a live one's and an unmarked one are kept", async () => {
    const parent = fixtureDir('sandbox-parent-')
    const dead = join(parent, `${CLAUDE_SANDBOX_PREFIX}dead`)
    mkdirSync(dead)
    writeOwnerMarker(dead, { ...currentOwner('effect-dead'), pid: spawnSync('true').pid as number })
    const live = join(parent, `${CLAUDE_SANDBOX_PREFIX}live`)
    mkdirSync(live)
    writeOwnerMarker(live, currentOwner('effect-live'))
    const unmarked = join(parent, `${CLAUDE_SANDBOX_PREFIX}legacy`)
    mkdirSync(unmarked)
    const unrelated = join(parent, 'something-else')
    mkdirSync(unrelated)
    const stopped: string[] = []
    const lines: string[] = []
    await mintClaudeScratchDir('effect-new', (line) => lines.push(line), parent, {
      stop: async (token) => {
        stopped.push(token)
        return noStop()
      }
    })
    expect(stopped).toEqual(['effect-dead'])
    expect(existsSync(dead)).toBe(false)
    expect([live, unmarked, unrelated].every(existsSync)).toBe(true)
    expect(lines).toEqual([])
  })

  test('a sweep that cannot stop the dead driver keeps its directory and says so', async () => {
    const parent = fixtureDir('sandbox-parent-')
    const dead = join(parent, `${CLAUDE_SANDBOX_PREFIX}dead`)
    mkdirSync(dead)
    writeOwnerMarker(dead, { ...currentOwner('effect-dead'), pid: spawnSync('true').pid as number })
    const lines: string[] = []
    await mintClaudeScratchDir('effect-new', (line) => lines.push(line), parent, {
      stop: async () => {
        throw new Error('registry down')
      }
    })
    expect(existsSync(dead)).toBe(true)
    expect(lines).toEqual([expect.stringContaining('registry down')])
  })
})
