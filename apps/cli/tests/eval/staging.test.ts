// Trial staging and the contamination test, against real git in a temporary
// directory: a clean staging passes, and each planted contamination is
// refused with its own typed finding.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  admitTrial,
  attributeTrialObjects,
  type ContaminationCode,
  type ContaminationReport,
  type HiddenInputs,
  prepareGradingCopy,
  testContamination
} from '../../src/lib/dev-review-eval/contamination'
import {
  type CloneStaging,
  freezeObjectManifest,
  git,
  gitObjectId,
  type SnapshotStaging,
  StagingError,
  stageTrial
} from '../../src/lib/dev-review-eval/staging'

const AUTHOR = ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid']
const BRANCH = 'task/eval/1'

const HIDDEN: HiddenInputs = {
  failToPassTests: { 'tests/hidden.test.ts': 'expect(parse("x")).toBe("fixed")\n' },
  referenceSolution: { 'src/parse.ts': 'export const parse = () => "fixed"\n' }
}

let work: string
let source: string
let base: string
let later: string
let laterBlob: string
let counter = 0

function commitAll(repo: string, message: string): string {
  git(repo, ['add', '--all'])
  git(repo, [...AUTHOR, 'commit', '--quiet', '-m', message])
  return git(repo, ['rev-parse', 'HEAD']).trim()
}

function freshDir(name: string): string {
  const dir = join(work, `${name}-${++counter}`)
  mkdirSync(dir)
  return dir
}

function stageClone(): CloneStaging {
  const staging = stageTrial({
    trialId: `t${++counter}`,
    sourceRepository: source,
    baseCommit: base,
    parentDirectory: freshDir('trials'),
    mode: 'clone',
    taskBranch: BRANCH
  })
  if (staging.kind !== 'clone') throw new Error('expected a clone')
  return staging
}

function stageSnapshot(): SnapshotStaging {
  const staging = stageTrial({
    trialId: `s${++counter}`,
    sourceRepository: source,
    baseCommit: base,
    parentDirectory: freshDir('trials'),
    mode: 'snapshot'
  })
  if (staging.kind !== 'snapshot') throw new Error('expected a snapshot')
  return staging
}

function codes(report: ContaminationReport): ContaminationCode[] {
  return [...new Set(report.findings.map((f) => f.code))].sort()
}

function expectRefused(report: ContaminationReport, code: ContaminationCode): void {
  expect(report.clean).toBe(false)
  expect(codes(report)).toContain(code)
}

function sourceState(): string {
  return [
    git(source, ['for-each-ref', '--format=%(refname) %(objectname)']),
    git(source, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']),
    readFileSync(join(source, '.git', 'config'), 'utf8')
  ].join('\n')
}

beforeAll(() => {
  work = mkdtempSync(join(realpathSync(process.env.TMPDIR ?? tmpdir()), 'dev-review-eval-staging-'))
  source = join(work, 'source')
  mkdirSync(source)
  git(source, ['init', '--quiet', '--initial-branch=main'])
  mkdirSync(join(source, 'src'))
  writeFileSync(join(source, 'README.md'), '# fixture\n')
  writeFileSync(join(source, 'src', 'parse.ts'), 'export const parse = () => "broken"\n')
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 })
  symlinkSync('README.md', join(source, 'readme-link'))
  commitAll(source, 'first')
  writeFileSync(join(source, 'src', 'util.ts'), 'export const util = 1\n')
  base = commitAll(source, 'base')
  // Later history the trial must never see: a fix and a tag on it.
  writeFileSync(join(source, 'later.txt'), 'the answer lives in later history\n')
  later = commitAll(source, 'later')
  laterBlob = git(source, ['rev-parse', `${later}:later.txt`]).trim()
  git(source, ['tag', 'v1', later])
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('the allowed-object manifest', () => {
  it('is every object reachable from the base commit and nothing later, frozen', () => {
    const manifest = freezeObjectManifest(source, base)
    const expected = git(source, ['rev-list', '--objects', '--no-object-names', base]).trim().split('\n').sort()
    expect([...manifest.objects]).toEqual(expected)
    expect(manifest.objects).not.toContain(later)
    expect(manifest.objects).not.toContain(laterBlob)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.objects)).toBe(true)
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a base commit the source does not hold', () => {
    expect(() => freezeObjectManifest(source, 'f'.repeat(40))).toThrow(StagingError)
  })
})

describe('clone staging', () => {
  it('is an isolated clone of its own, sharing no object file with the source', () => {
    const before = sourceState()
    const staging = stageClone()
    const gitDir = staging.gitDir
    expect(lstatSync(gitDir).isDirectory()).toBe(true)
    expect(existsSync(join(gitDir, 'commondir'))).toBe(false)
    const sourceInodes = new Set<number>()
    const walk = (dir: string, visit: (path: string) => void) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, visit)
        else visit(p)
      }
    }
    walk(join(source, '.git', 'objects'), (p) => sourceInodes.add(statSync(p).ino))
    walk(join(gitDir, 'objects'), (p) => {
      expect(statSync(p).nlink).toBe(1)
      expect(sourceInodes.has(statSync(p).ino)).toBe(false)
    })
    expect(git(staging.workspace, ['for-each-ref', '--format=%(refname) %(objectname)']).trim()).toBe(
      `refs/heads/${BRANCH} ${base}`
    )
    expect(git(staging.workspace, ['remote']).trim()).toBe('')
    expect(readFileSync(join(staging.workspace, 'src', 'parse.ts'), 'utf8')).toContain('broken')
    expect(existsSync(join(staging.workspace, 'later.txt'))).toBe(false)
    for (const dir of Object.values(staging.agentState)) expect(readdirSync(dir.path)).toEqual([])
    expect(sourceState()).toBe(before)
  })

  it('passes the contamination test when clean', () => {
    const report = testContamination(stageClone(), HIDDEN)
    expect(report.findings).toEqual([])
    expect(report.clean).toBe(true)
  })

  it('starts the trial only when the contamination test passes', () => {
    let started = 0
    const clean = admitTrial(stageClone(), HIDDEN, () => ++started)
    expect(clean.ok).toBe(true)
    expect(started).toBe(1)

    const dirty = stageClone()
    git(dirty.workspace, ['tag', 'v0'])
    const refused = admitTrial(dirty, HIDDEN, () => ++started)
    expect(refused.ok).toBe(false)
    expect(started).toBe(1)
    if (!refused.ok) expect(codes(refused.refusal)).toContain('foreign_ref')
  })
})

describe('the contamination test refuses each planted contamination', () => {
  it("a later commit's object, loose", () => {
    const staging = stageClone()
    const id = git(staging.workspace, ['hash-object', '-w', '--stdin'], 'the answer lives in later history\n').trim()
    expect(id).toBe(laterBlob)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'object_set_mismatch')
    expectRefused(report, 'unreachable_object')
    const extra = report.findings.find((f) => f.code === 'object_set_mismatch')
    expect(extra?.objects).toEqual([laterBlob])
  })

  it("a later commit's objects, packed and unreferenced", () => {
    const staging = stageClone()
    git(staging.workspace, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', source, later])
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'object_set_mismatch')
    const extra = report.findings.find((f) => f.code === 'object_set_mismatch')?.objects ?? []
    expect(extra).toContain(later)
    expect(extra).toContain(laterBlob)
    expectRefused(report, 'unreachable_object')
  })

  it('a missing manifest object', () => {
    const staging = stageClone()
    const pack = readdirSync(join(staging.gitDir, 'objects', 'pack'))
    for (const file of pack) rmSync(join(staging.gitDir, 'objects', 'pack', file))
    expectRefused(testContamination(staging, HIDDEN), 'object_set_mismatch')
  })

  it('a tag', () => {
    const staging = stageClone()
    git(staging.workspace, ['tag', 'v0'])
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'foreign_ref')
    expect(report.findings.find((f) => f.code === 'foreign_ref')?.subject).toBe('refs/tags/v0')
  })

  it('a remote-tracking ref', () => {
    const staging = stageClone()
    writeFileSync(join(staging.gitDir, 'packed-refs'), `${base} refs/remotes/origin/main\n`)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'foreign_ref')
    expect(report.findings.find((f) => f.code === 'foreign_ref')?.subject).toBe('refs/remotes/origin/main')
  })

  it('a replacement ref and a note', () => {
    const staging = stageClone()
    const parent = git(staging.workspace, ['rev-parse', `${base}^`]).trim()
    git(staging.workspace, ['update-ref', `refs/replace/${base}`, parent])
    git(staging.workspace, ['update-ref', 'refs/notes/commits', parent])
    const subjects = testContamination(staging, HIDDEN)
      .findings.filter((f) => f.code === 'foreign_ref')
      .map((f) => f.subject)
    expect(subjects).toEqual(expect.arrayContaining([`refs/replace/${base}`, 'refs/notes/commits']))
  })

  it('a moved task branch and a detached HEAD', () => {
    const staging = stageClone()
    git(staging.workspace, [...AUTHOR, 'commit', '--quiet', '--allow-empty', '-m', 'early'])
    expectRefused(testContamination(staging, HIDDEN), 'task_branch_moved')
    const detached = stageClone()
    writeFileSync(join(detached.gitDir, 'HEAD'), `${base}\n`)
    expectRefused(testContamination(detached, HIDDEN), 'head_not_task_branch')
  })

  it('a pseudo-ref', () => {
    const staging = stageClone()
    writeFileSync(join(staging.gitDir, 'ORIG_HEAD'), `${base}\n`)
    expectRefused(testContamination(staging, HIDDEN), 'pseudo_ref')
  })

  it('a reflog entry', () => {
    const staging = stageClone()
    mkdirSync(join(staging.gitDir, 'logs'))
    appendFileSync(join(staging.gitDir, 'logs', 'HEAD'), `${'0'.repeat(40)} ${base} Eval <e@x> 0 +0000\tclone\n`)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'reflog_not_empty')
    expect(report.findings.map((f) => f.code)).toEqual(['reflog_not_empty'])
  })

  it('an alternates file', () => {
    const staging = stageClone()
    mkdirSync(join(staging.gitDir, 'objects', 'info'), { recursive: true })
    writeFileSync(join(staging.gitDir, 'objects', 'info', 'alternates'), `${join(source, '.git', 'objects')}\n`)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'alternates')
    expect(report.findings.find((f) => f.code === 'object_set_mismatch')?.objects).toContain(laterBlob)
  })

  it('a promisor remote', () => {
    const staging = stageClone()
    git(staging.workspace, ['config', 'extensions.partialClone', 'origin'])
    git(staging.workspace, ['config', 'remote.origin.promisor', 'true'])
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'promisor')
    expect(report.findings.filter((f) => f.code === 'promisor').map((f) => f.subject)).toEqual(
      expect.arrayContaining(['extensions.partialclone', 'remote.origin.promisor'])
    )
  })

  it('a promisor pack', () => {
    const staging = stageClone()
    const pack = readdirSync(join(staging.gitDir, 'objects', 'pack')).find((f) => f.endsWith('.pack')) as string
    writeFileSync(join(staging.gitDir, 'objects', 'pack', pack.replace(/\.pack$/, '.promisor')), '')
    expectRefused(testContamination(staging, HIDDEN), 'promisor')
  })

  it('a graft', () => {
    const staging = stageClone()
    mkdirSync(join(staging.gitDir, 'info'), { recursive: true })
    writeFileSync(join(staging.gitDir, 'info', 'grafts'), `${base}\n`)
    expectRefused(testContamination(staging, HIDDEN), 'graft')
  })

  it('a shallow boundary', () => {
    const staging = stageClone()
    writeFileSync(join(staging.gitDir, 'shallow'), `${base}\n`)
    expectRefused(testContamination(staging, HIDDEN), 'shallow')
  })

  it('a configured remote', () => {
    const staging = stageClone()
    git(staging.workspace, ['remote', 'add', 'origin', source])
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'remote_configured')
    expect(report.findings.find((f) => f.code === 'remote_configured')?.subject).toBe('remote.origin.url')
  })

  it('a configuration include and an unexpected setting', () => {
    const staging = stageClone()
    git(staging.workspace, ['config', 'include.path', '/elsewhere'])
    git(staging.workspace, ['config', 'core.hooksPath', '/elsewhere'])
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'config_include')
    expectRefused(report, 'unexpected_config')
  })

  it('a linked worktree', () => {
    const staging = stageClone()
    writeFileSync(join(staging.gitDir, 'commondir'), '../..\n')
    expectRefused(testContamination(staging, HIDDEN), 'linked_worktree')
  })

  it('a stray file in the object store', () => {
    const staging = stageClone()
    writeFileSync(join(staging.gitDir, 'objects', 'pack', 'tmp_pack_x'), 'x')
    expectRefused(testContamination(staging, HIDDEN), 'stray_object_file')
  })

  it('prior vendor state: a leftover file', () => {
    const staging = stageClone()
    writeFileSync(join(staging.agentState.vendorHome.path, 'settings.json'), '{}')
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'prior_agent_state')
    expect(report.findings.map((f) => f.subject)).toEqual(['vendorHome'])
  })

  it('prior vendor state: a directory staging did not create', () => {
    const staging = stageClone()
    const prior = freshDir('prior-session-store')
    rmSync(staging.agentState.sessionStore.path, { recursive: true })
    renameSync(prior, staging.agentState.sessionStore.path)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'prior_agent_state')
    expect(report.findings.map((f) => f.subject)).toEqual(['sessionStore'])
  })

  it('prior state in each of the transcripts, tool state, cache and temporary directories', () => {
    for (const key of ['transcripts', 'toolState', 'cache', 'tmp'] as const) {
      const staging = stageClone()
      mkdirSync(join(staging.agentState[key].path, 'left-over'))
      expect(testContamination(staging, HIDDEN).findings.map((f) => f.subject)).toEqual([key])
    }
  })

  it('a visible hidden test, in the working tree under another name', () => {
    const staging = stageClone()
    writeFileSync(join(staging.workspace, 'notes.txt'), HIDDEN.failToPassTests['tests/hidden.test.ts'] as string)
    const report = testContamination(staging, HIDDEN)
    expectRefused(report, 'hidden_input_visible')
    expect(report.findings.find((f) => f.code === 'hidden_input_visible')?.detail).toContain('workspace/notes.txt')
  })

  it('a visible hidden test, in the object database', () => {
    const staging = stageClone()
    git(staging.workspace, ['hash-object', '-w', '--stdin'], HIDDEN.failToPassTests['tests/hidden.test.ts'] as string)
    expectRefused(testContamination(staging, HIDDEN), 'hidden_input_visible')
  })

  it('a visible reference solution, in agent state', () => {
    const staging = stageClone()
    writeFileSync(join(staging.agentState.tmp.path, 'x'), HIDDEN.referenceSolution['src/parse.ts'] as string)
    const report = testContamination(staging, HIDDEN)
    expect(report.findings.filter((f) => f.code === 'hidden_input_visible').map((f) => f.subject)).toEqual([
      'reference solution src/parse.ts'
    ])
  })

  it('a hidden input the base history already holds', () => {
    const leaky: HiddenInputs = { failToPassTests: { 'tests/hidden.test.ts': '# fixture\n' }, referenceSolution: {} }
    const report = testContamination(stageClone(), leaky)
    expectRefused(report, 'hidden_input_visible')
    expect(report.findings.map((f) => f.detail)).toContain('its blob is in the allowed-object manifest')
  })
})

describe('snapshot staging', () => {
  it('holds the base tree exactly and no git metadata, and passes when clean', () => {
    const staging = stageSnapshot()
    expect(existsSync(join(staging.workspace, '.git'))).toBe(false)
    expect(readFileSync(join(staging.workspace, 'src', 'util.ts'), 'utf8')).toBe('export const util = 1\n')
    expect(statSync(join(staging.workspace, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(lstatSync(join(staging.workspace, 'readme-link')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(staging.workspace, 'later.txt'))).toBe(false)
    expect(testContamination(staging, HIDDEN)).toEqual({ trialId: staging.trialId, clean: true, findings: [] })
  })

  it('refuses git metadata, a changed or extra file, a visible hidden test and prior state', () => {
    const withGit = stageSnapshot()
    mkdirSync(join(withGit.workspace, 'src', '.git'))
    expectRefused(testContamination(withGit, HIDDEN), 'git_metadata_present')

    const changed = stageSnapshot()
    writeFileSync(join(changed.workspace, 'later.txt'), 'the answer lives in later history\n')
    writeFileSync(join(changed.workspace, 'README.md'), 'changed\n')
    const report = testContamination(changed, HIDDEN)
    expect(report.findings.filter((f) => f.code === 'snapshot_mismatch').map((f) => f.subject)).toEqual([
      'README.md',
      'later.txt'
    ])

    const hidden = stageSnapshot()
    writeFileSync(join(hidden.workspace, 'tests.txt'), HIDDEN.failToPassTests['tests/hidden.test.ts'] as string)
    expectRefused(testContamination(hidden, HIDDEN), 'hidden_input_visible')

    const prior = stageSnapshot()
    writeFileSync(join(prior.agentState.transcripts.path, 'old.jsonl'), '{}\n')
    expectRefused(testContamination(prior, HIDDEN), 'prior_agent_state')
  })
})

describe('after the trial', () => {
  it('attributes every object the trial created to it', () => {
    const staging = stageClone()
    writeFileSync(join(staging.workspace, 'src', 'parse.ts'), 'export const parse = () => "attempt"\n')
    const head = commitAll(staging.workspace, 'attempt')
    // An abandoned write: created by the trial, reachable from nothing.
    const abandoned = git(staging.workspace, ['hash-object', '-w', '--stdin'], 'scratch\n').trim()
    const attribution = attributeTrialObjects(staging, HIDDEN)
    if (attribution.kind !== 'clone') throw new Error('expected a clone attribution')
    expect(attribution.attributable).toBe(true)
    expect(attribution.unattributable).toEqual([])
    expect(attribution.reachable).toContain(head)
    expect(attribution.unreachable).toEqual([abandoned])
    expect(attribution.created.length).toBe(attribution.reachable.length + 1)
    expect(attribution.missing).toEqual([])
  })

  it('does not attribute an object that predates the trial, a foreign one, or a hidden input', () => {
    const staging = stageClone()
    const old = git(staging.workspace, ['hash-object', '-w', '--stdin'], 'planted before\n').trim()
    const loose = join(staging.gitDir, 'objects', old.slice(0, 2), old.slice(2))
    utimesSync(loose, new Date(0), new Date(0))
    const hiddenId = git(
      staging.workspace,
      ['hash-object', '-w', '--stdin'],
      HIDDEN.failToPassTests['tests/hidden.test.ts'] as string
    ).trim()
    mkdirSync(join(staging.gitDir, 'objects', 'info'), { recursive: true })
    writeFileSync(join(staging.gitDir, 'objects', 'info', 'alternates'), `${join(source, '.git', 'objects')}\n`)
    const attribution = attributeTrialObjects(staging, HIDDEN)
    if (attribution.kind !== 'clone') throw new Error('expected a clone attribution')
    expect(attribution.attributable).toBe(false)
    const reasons = new Map(attribution.unattributable.map((u) => [u.id, u.reason]))
    expect(reasons.get(old)).toBe('predates_trial')
    expect(reasons.get(hiddenId)).toBe('hidden_input')
    expect(reasons.get(laterBlob)).toBe('foreign_source')
    expect(() =>
      prepareGradingCopy({
        staging,
        attribution,
        hidden: HIDDEN,
        parentDirectory: freshDir('grading'),
        apply: 'fail-to-pass'
      })
    ).toThrow(StagingError)
  })

  it('applies hidden tests only in a separate grading copy', () => {
    const staging = stageClone()
    writeFileSync(join(staging.workspace, 'src', 'parse.ts'), 'export const parse = () => "attempt"\n')
    const head = commitAll(staging.workspace, 'attempt')
    const attribution = attributeTrialObjects(staging, HIDDEN)
    const copy = prepareGradingCopy({
      staging,
      attribution,
      hidden: HIDDEN,
      parentDirectory: freshDir('grading'),
      apply: 'fail-to-pass'
    })
    expect(copy.written).toEqual(['tests/hidden.test.ts'])
    expect(readFileSync(join(copy.path, 'tests', 'hidden.test.ts'), 'utf8')).toBe(
      HIDDEN.failToPassTests['tests/hidden.test.ts'] as string
    )
    expect(readFileSync(join(copy.path, 'src', 'parse.ts'), 'utf8')).toContain('attempt')
    expect(git(copy.path, ['rev-parse', 'HEAD']).trim()).toBe(head)
    expect(git(copy.path, ['remote']).trim()).toBe('')
    // The trial's clone never received a hidden input.
    expect(existsSync(join(staging.workspace, 'tests', 'hidden.test.ts'))).toBe(false)
    const hiddenId = gitObjectId('sha1', 'blob', Buffer.from(HIDDEN.failToPassTests['tests/hidden.test.ts'] as string))
    expect(git(staging.workspace, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])).not.toContain(
      hiddenId
    )
  })

  it('applies the reference solution over the base commit in its own copy', () => {
    const staging = stageClone()
    const copy = prepareGradingCopy({
      staging,
      attribution: attributeTrialObjects(staging, HIDDEN),
      hidden: HIDDEN,
      parentDirectory: freshDir('grading'),
      apply: 'reference-solution'
    })
    expect(copy.written).toEqual(['src/parse.ts', 'tests/hidden.test.ts'])
    expect(git(copy.path, ['rev-parse', 'HEAD']).trim()).toBe(base)
    expect(readFileSync(join(copy.path, 'src', 'parse.ts'), 'utf8')).toContain('fixed')
    expect(testContamination(staging, HIDDEN).clean).toBe(true)

    const snapshot = stageSnapshot()
    const snapshotCopy = prepareGradingCopy({
      staging: snapshot,
      attribution: attributeTrialObjects(snapshot, HIDDEN),
      hidden: HIDDEN,
      parentDirectory: freshDir('grading'),
      apply: 'reference-solution'
    })
    expect(readFileSync(join(snapshotCopy.path, 'src', 'parse.ts'), 'utf8')).toContain('fixed')
    expect(existsSync(join(snapshot.workspace, 'tests'))).toBe(false)
  })

  it('refuses a grading copy inside the trial directory, or a path escaping the copy', () => {
    const staging = stageClone()
    const attribution = attributeTrialObjects(staging, HIDDEN)
    expect(() =>
      prepareGradingCopy({
        staging,
        attribution,
        hidden: HIDDEN,
        parentDirectory: staging.agentState.tmp.path,
        apply: 'fail-to-pass'
      })
    ).toThrow(StagingError)
    const escaping: HiddenInputs = { failToPassTests: { '../outside.ts': 'x' }, referenceSolution: {} }
    expect(() =>
      prepareGradingCopy({
        staging,
        attribution,
        hidden: escaping,
        parentDirectory: freshDir('grading'),
        apply: 'fail-to-pass'
      })
    ).toThrow(StagingError)
  })

  it('attributes a snapshot trial’s changed files, refusing a hidden input among them', () => {
    const staging = stageSnapshot()
    writeFileSync(join(staging.workspace, 'src', 'parse.ts'), 'export const parse = () => "attempt"\n')
    expect(attributeTrialObjects(staging, HIDDEN)).toEqual({
      kind: 'snapshot',
      trialId: staging.trialId,
      created: ['src/parse.ts'],
      unattributable: [],
      attributable: true
    })
    writeFileSync(join(staging.workspace, 'copied.ts'), HIDDEN.referenceSolution['src/parse.ts'] as string)
    expect(attributeTrialObjects(staging, HIDDEN).unattributable).toEqual([
      { path: 'copied.ts', reason: 'hidden_input' }
    ])
  })
})
