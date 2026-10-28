import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { policyDigest } from '@attalabs/aeg-core'
import { diagnoseLocalOverride } from '../../src/commands/doctor.js'
import { LOCAL_OVERRIDABLE_KEYS, resolveLocalPacingOverride, type VinayaConfig } from '../../src/lib/config.js'
import { reviewPolicyForLoop } from '../../src/lib/dev-review-loop/developer-dispatch.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

let root: string
let worktree: string
let savedEnv: Record<string, string | undefined>

const writeLocal = (body: unknown) => writeFileSync(join(root, 'vinaya.config.local.json'), JSON.stringify(body))
const defaultBranchConfig = (): VinayaConfig =>
  ({
    reviewPolicy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH', maxRounds: 3, maxTaskMinutes: 180 }
  }) as VinayaConfig

beforeEach(() => {
  savedEnv = { VINAYA_ROLE: process.env.VINAYA_ROLE, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS }
  delete process.env.VINAYA_ROLE
  delete process.env.GITHUB_ACTIONS
  root = realpathSync(mkdtempSync(join(tmpdir(), 'local-override-')))
  git(root, 'init', '-q')
  git(root, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  worktree = join(root, '.worktrees', 'wt')
  git(root, 'worktree', 'add', '-q', '-b', 'wt', worktree)
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

describe('resolveLocalPacingOverride', () => {
  it('allowlist holds exactly the three pacing keys', () => {
    expect([...LOCAL_OVERRIDABLE_KEYS]).toEqual([
      'reviewPolicy.maxRounds',
      'reviewPolicy.maxTaskMinutes',
      'reviewPolicy.readyPushTimeoutMinutes'
    ])
  })

  it('applies an allowlisted override from the primary checkout', () => {
    writeLocal({ reviewPolicy: { maxRounds: 5, maxTaskMinutes: 0, readyPushTimeoutMinutes: 60 } })
    const local = resolveLocalPacingOverride(root)
    expect(local?.maxRounds).toBe(5)
    expect(local?.maxTaskMinutes).toBe(0)
    expect(local?.readyPushTimeoutMinutes).toBe(60)
    expect(local?.ignoredKeys).toEqual([])
  })

  it('a local readyPushTimeoutMinutes is ignored for a role process and in CI', () => {
    writeLocal({ reviewPolicy: { readyPushTimeoutMinutes: 60 } })
    expect(resolveLocalPacingOverride(root)?.readyPushTimeoutMinutes).toBe(60)
    process.env.VINAYA_ROLE = 'developer'
    expect(resolveLocalPacingOverride(root)).toBeNull()
    delete process.env.VINAYA_ROLE
    process.env.GITHUB_ACTIONS = 'true'
    expect(resolveLocalPacingOverride(root)).toBeNull()
  })

  it('ignores unlisted keys with one warning naming them', () => {
    writeLocal({ reviewPolicy: { maxRounds: 4, codeReviewThreshold: 'MINOR' }, principals: ['x'] })
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const local = resolveLocalPacingOverride(root)
      resolveLocalPacingOverride(root)
      expect(local?.maxRounds).toBe(4)
      expect(local?.ignoredKeys).toEqual(['reviewPolicy.codeReviewThreshold', 'principals'])
      expect(err).toHaveBeenCalledTimes(1)
      const message = String(err.mock.calls[0]?.[0])
      expect(message).toContain('reviewPolicy.codeReviewThreshold')
      expect(message).toContain('principals')
    } finally {
      err.mockRestore()
    }
  })

  it('is ignored for a role process', () => {
    writeLocal({ reviewPolicy: { maxRounds: 9 } })
    process.env.VINAYA_ROLE = 'developer'
    expect(resolveLocalPacingOverride(root)).toBeNull()
  })

  it('is ignored in CI', () => {
    writeLocal({ reviewPolicy: { maxRounds: 9 } })
    process.env.GITHUB_ACTIONS = 'true'
    expect(resolveLocalPacingOverride(root)).toBeNull()
  })

  it('is ignored from inside a task worktree, with or without a copy there', () => {
    writeLocal({ reviewPolicy: { maxRounds: 9 } })
    expect(resolveLocalPacingOverride(worktree)).toBeNull()
    writeFileSync(join(worktree, 'vinaya.config.local.json'), JSON.stringify({ reviewPolicy: { maxRounds: 9 } }))
    expect(resolveLocalPacingOverride(worktree)).toBeNull()
  })

  it('is ignored when the file is a symlink', () => {
    const target = join(root, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ reviewPolicy: { maxRounds: 9 } }))
    symlinkSync(target, join(root, 'vinaya.config.local.json'))
    expect(resolveLocalPacingOverride(root)).toBeNull()
  })

  it('is ignored for a repository with no primary working tree', () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'local-override-bare-')))
    try {
      git(bare, 'init', '-q', '--bare')
      writeFileSync(join(bare, 'vinaya.config.local.json'), JSON.stringify({ reviewPolicy: { maxRounds: 9 } }))
      expect(resolveLocalPacingOverride(bare)).toBeNull()
      const sep = join(bare, 'tree')
      mkdirSync(sep)
      git(sep, 'init', '-q', '--separate-git-dir', join(bare, 'gitdir'))
      writeFileSync(join(sep, 'vinaya.config.local.json'), JSON.stringify({ reviewPolicy: { maxRounds: 9 } }))
      expect(resolveLocalPacingOverride(sep)).toBeNull()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('refuses an invalid local value', () => {
    writeLocal({ reviewPolicy: { maxRounds: 0 } })
    expect(() => resolveLocalPacingOverride(root)).toThrow(/maxRounds/)
    writeLocal({ reviewPolicy: { maxTaskMinutes: -1 } })
    expect(() => resolveLocalPacingOverride(root)).toThrow(/maxTaskMinutes/)
    writeLocal({ reviewPolicy: { maxRounds: '5' } })
    expect(() => resolveLocalPacingOverride(root)).toThrow(/maxRounds/)
    for (const bad of [0, -3, 2.5, '30']) {
      writeLocal({ reviewPolicy: { readyPushTimeoutMinutes: bad } })
      expect(() => resolveLocalPacingOverride(root)).toThrow(/reviewPolicy\.readyPushTimeoutMinutes/)
    }
  })
})

describe('reviewPolicyForLoop with a local file', () => {
  it('moves only the two pacing fields; thresholds and policyDigest stay on the default branch', () => {
    const base = reviewPolicyForLoop(() => defaultBranchConfig())
    const cwd = process.cwd()
    writeLocal({ reviewPolicy: { maxRounds: 5, codeReviewThreshold: 'MINOR', securityThreshold: 'LOW' } })
    process.chdir(root)
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const policy = reviewPolicyForLoop(() => defaultBranchConfig())
      expect(policy.maxRounds).toBe(5)
      expect(policy.maxTaskMinutes).toBe(180)
      expect(policy.codeReviewThreshold).toBe('MAJOR')
      expect(policy.securityThreshold).toBe('HIGH')
      expect(policyDigest(policy)).toBe(policyDigest({ ...base }))
    } finally {
      err.mockRestore()
      process.chdir(cwd)
    }
  })

  it('the local readyPushTimeoutMinutes wins over the default branch value for a local run', () => {
    const cwd = process.cwd()
    writeLocal({ reviewPolicy: { readyPushTimeoutMinutes: 75 } })
    process.chdir(root)
    try {
      const withBranchValue = reviewPolicyForLoop(
        () => ({ reviewPolicy: { readyPushTimeoutMinutes: 30 } }) as VinayaConfig
      )
      expect(withBranchValue.readyPushTimeoutMinutes).toBe(75)
      expect(reviewPolicyForLoop(() => defaultBranchConfig()).readyPushTimeoutMinutes).toBe(75)
      process.env.GITHUB_ACTIONS = 'true'
      expect(
        reviewPolicyForLoop(() => ({ reviewPolicy: { readyPushTimeoutMinutes: 30 } }) as VinayaConfig)
          .readyPushTimeoutMinutes
      ).toBe(30)
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('diagnoseLocalOverride', () => {
  it('reports nothing without a file and names the overridden values with one', () => {
    expect(diagnoseLocalOverride(root)).toEqual([])
    writeLocal({ reviewPolicy: { maxRounds: 5 } })
    const findings = diagnoseLocalOverride(root)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toContain('reviewPolicy.maxRounds=5')
    expect(diagnoseLocalOverride(worktree)).toEqual([])
  })

  it('warns on an invalid file', () => {
    writeLocal({ reviewPolicy: { maxRounds: 0 } })
    expect(diagnoseLocalOverride(root)[0]?.severity).toBe('warn')
  })
})
