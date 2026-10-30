/**
 * The root-configuration probe, run as the CI job runs it: a real `bun
 * scripts/ci/config-probe.ts` process outside `bun test`'s preload, against a
 * throwaway git repository whose base and candidate commits carry distinct
 * configurations.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCiTrustAnchorProbeRef } from '../../src/lib/config.js'
import { fixtureDir } from './test-temp-fixture.js'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'config-probe.ts')
const BASE_CONFIG = '{"releaseActor":"base-actor-secret-value"}\n'
const CANDIDATE_CONFIG = '{"releaseActor":"candidate-actor-secret-value"}\n'
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8'
  })
}

/** A repository with a `base` commit and a `candidate` commit (the config on each; null = file absent). */
function repo(base: string | null, candidate: string | null): string {
  const dir = fixtureDir('config-probe-')
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'empty')
  for (const [name, text] of [
    ['base', base],
    ['candidate', candidate]
  ] as const) {
    if (text === null) git(dir, 'rm', '-q', '--ignore-unmatch', 'vinaya.config.json')
    else {
      writeFileSync(join(dir, 'vinaya.config.json'), text)
      git(dir, 'add', 'vinaya.config.json')
    }
    git(dir, 'commit', '-q', '--allow-empty', '-m', name)
    git(dir, 'tag', name)
  }
  return dir
}

const RUNNER_ENV = { GITHUB_ACTIONS: 'true', VINAYA_CI_CONFIG_PROBE_REF: 'candidate' }

type Line = { label: string; ref: string; presence: string; digest: string | null; status: string }

function probe(
  cwd: string,
  env: Record<string, string | undefined> = RUNNER_ENV,
  args = ['--base', 'base', '--candidate', 'candidate']
) {
  const clean = stripVinayaEnv()
  delete clean.GH_TOKEN
  delete clean.GITHUB_TOKEN
  const merged = { ...clean, ...env }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  const run = spawnSyncBudgeted('bun', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: merged as NodeJS.ProcessEnv })
  const lines = run.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Line)
  return {
    ...run,
    lines,
    byLabel: Object.fromEntries(lines.map((l) => [l.label, l])) as Record<string, Line | undefined>
  }
}

describe('the committed-configuration probe process', () => {
  it('loads the distinct base and candidate blobs and reports ref, presence and digest, never values', () => {
    const run = probe(repo(BASE_CONFIG, CANDIDATE_CONFIG))
    expect(run.status).toBe(0)
    expect(run.byLabel.candidate).toEqual({
      label: 'candidate',
      ref: 'candidate',
      presence: 'present',
      digest: sha(CANDIDATE_CONFIG),
      status: 'loaded'
    })
    expect(run.byLabel.base).toEqual({
      label: 'base',
      ref: 'base',
      presence: 'present',
      digest: sha(BASE_CONFIG),
      status: 'loaded'
    })
    expect(run.stdout + run.stderr).not.toContain('actor-secret-value')
  })

  it('reads committed blobs, ignoring a dirty working-tree edit', () => {
    const dir = repo(BASE_CONFIG, CANDIDATE_CONFIG)
    writeFileSync(join(dir, 'vinaya.config.json'), '{"releaseActor":"dirty-edit"}\n')
    const run = probe(dir)
    expect(run.status).toBe(0)
    expect(run.byLabel.candidate?.digest).toBe(sha(CANDIDATE_CONFIG))
  })

  it('records a validly absent base as absent, distinct from a loaded value', () => {
    const run = probe(repo(null, CANDIDATE_CONFIG))
    expect(run.status).toBe(0)
    expect(run.byLabel.base).toEqual({ label: 'base', ref: 'base', presence: 'absent', digest: null, status: 'absent' })
    expect(run.byLabel.candidate?.status).toBe('loaded')
  })

  it('is red for a malformed candidate, never an empty success', () => {
    const run = probe(repo(BASE_CONFIG, '{not json'))
    expect(run.status).toBe(1)
    expect(run.byLabel.candidate).toMatchObject({
      presence: 'present',
      status: 'malformed-json',
      digest: sha('{not json')
    })
  })

  it('is red for a candidate that fails the schema', () => {
    const run = probe(repo(BASE_CONFIG, '{"releaseActor":42}\n'))
    expect(run.status).toBe(1)
    expect(run.byLabel.candidate?.status).toBe('schema-invalid')
  })

  it('is red for a ref git cannot resolve, not absence', () => {
    const run = probe(repo(BASE_CONFIG, CANDIDATE_CONFIG), { ...RUNNER_ENV, VINAYA_CI_CONFIG_PROBE_REF: 'nope' }, [
      '--base',
      'base',
      '--candidate',
      'nope'
    ])
    expect(run.status).toBe(1)
    expect(run.byLabel.candidate?.status).toBe('ref-unreadable')
  })

  describe('refuses before any read', () => {
    const dir = repo(BASE_CONFIG, CANDIDATE_CONFIG)
    const cases: [string, Record<string, string | undefined>][] = [
      ['the runner marker is missing', { ...RUNNER_ENV, GITHUB_ACTIONS: undefined }],
      ['the probe ref is missing', { ...RUNNER_ENV, VINAYA_CI_CONFIG_PROBE_REF: undefined }],
      ['the probe ref names another ref', { ...RUNNER_ENV, VINAYA_CI_CONFIG_PROBE_REF: 'base' }],
      ['GH_TOKEN is present', { ...RUNNER_ENV, GH_TOKEN: 'x' }],
      ['GITHUB_TOKEN is present', { ...RUNNER_ENV, GITHUB_TOKEN: 'x' }]
    ]
    for (const [name, env] of cases)
      it(`when ${name}`, () => {
        const run = probe(dir, env)
        expect(run.status).toBe(1)
        expect(run.lines).toEqual([])
        expect(run.stderr).toContain('refused before any read')
      })
  })

  it('leaves the ordinary test preload isolating the ambient flag', () => {
    // This process runs under the test preload: the runner marker is gone, so the guard is inert here.
    expect(process.env.GITHUB_ACTIONS).toBeUndefined()
    expect(resolveCiTrustAnchorProbeRef({ ...process.env, VINAYA_CI_CONFIG_PROBE_REF: 'HEAD' })).toBeNull()
  })
})
