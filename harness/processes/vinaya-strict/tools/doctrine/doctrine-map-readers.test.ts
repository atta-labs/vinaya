import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkDoctrinePortability } from '../../checks/doctrine-portability'
import { evaluatePublishedProse, SHORT_VERSION_MAX_WORDS } from '../docs/published-prose'
import { isDocFile } from '../file-classify'
import { DEFAULT_PROSE_RULES } from '../prose-rules'
import { normaliseLines } from '../pr-report/pr-verify-evidence-logic'
import { checkRationaleNamesDocs, checkSurfaceScope } from '../task-contract/issue-validation'
import { isProtectedAdminPath } from '../task-contract/protected-paths'
import { isProseLocation } from '../task-contract/review-policy'
import {
  BUNDLED_DOCTRINE_DIR,
  DOCTRINE_MAP,
  DOCTRINE_REPO_PATHS,
  DOCTRINE_TREE,
  doctrineRepoPath,
  doctrineSource,
  FRONT_DOOR_KEY,
  keyForRepoPath,
  ROLE_ENTRIES,
  TEMPLATE_ENTRIES
} from './doctrine-map'
import { ENTRY_SEGMENTS, listTemplateNames, resolveDoctrineRoot, templatePath } from './resolve-doctrine'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')

/** A moved role doctrine path and a process path under `harness/` that is no doctrine at all. */
const MOVED_ROLE = doctrineRepoPath('roles/developer.md')
const NOT_DOCTRINE = `${DOCTRINE_TREE}/tools/actions.ts`
const NOT_DOCTRINE_MD = `${DOCTRINE_TREE}/executing/developer/README.md`

describe('the doctrine map', () => {
  it('names one file per logical key and per source path, and every one exists in this checkout', () => {
    expect(new Set(DOCTRINE_MAP.map((entry) => entry.key)).size).toBe(DOCTRINE_MAP.length)
    expect(new Set(DOCTRINE_MAP.map((entry) => entry.source)).size).toBe(DOCTRINE_MAP.length)
    const missing = DOCTRINE_REPO_PATHS.filter((path) => !existsSync(join(REPO_ROOT, path)))
    expect(missing).toEqual([])
  })

  it('keeps the old layout as logical keys and serves the front door from its process-relative source', () => {
    expect(FRONT_DOOR_KEY).toBe('skills/aeg/SKILL.md')
    expect(ENTRY_SEGMENTS.join('/')).toBe(doctrineSource(FRONT_DOOR_KEY))
    expect(keyForRepoPath(MOVED_ROLE)).toBe('roles/developer.md')
    expect(keyForRepoPath(NOT_DOCTRINE)).toBeUndefined()
  })

  it('names every role id `--role` resolves and every template `--template` lists, and nothing else', () => {
    expect(ROLE_ENTRIES.map((entry) => entry.role).sort()).toEqual([
      'architect',
      'archivist',
      'developer',
      'operator',
      'planner',
      'principal',
      'reviewer',
      'security',
      'tranche-archivist'
    ])
    expect(TEMPLATE_ENTRIES.map((entry) => entry.template)).toEqual([
      'brief',
      'decision-record',
      'issue-rationale',
      'pr-report'
    ])
  })
})

describe('the resolver reads the map', () => {
  it('resolves this checkout to its process folder, the tree taking precedence over any installed bundle', () => {
    const installedPkg = join(REPO_ROOT, 'node_modules', '@attalabs', 'not-installed')
    expect(resolveDoctrineRoot(installedPkg, REPO_ROOT)).toBe(join(REPO_ROOT, DOCTRINE_TREE))
  })

  it('lists the templates the map names and rebuilds each one’s path from it', () => {
    const root = join(REPO_ROOT, DOCTRINE_TREE)
    expect(listTemplateNames(root)).toEqual(['brief', 'decision-record', 'issue-rationale', 'pr-report'])
    expect(templatePath(root, 'pr-report')).toBe(join(root, 'artifacts', 'templates', 'pr-report-template.md'))
    expect(templatePath(root, 'notes')).toBeNull()
  })

  it('bundles under a folder named for the process, so links resolve the same way installed', () => {
    expect(DOCTRINE_TREE.split('/').pop()).toBe(BUNDLED_DOCTRINE_DIR)
  })
})

describe('each doctrine-path pattern recognizes the map’s source paths and nothing more under harness/', () => {
  it('file classification', () => {
    expect(isDocFile(MOVED_ROLE)).toBe(true)
    expect(isDocFile(NOT_DOCTRINE_MD)).toBe(false)
  })

  it('the prose rules’ internal-path rule', () => {
    const rule = DEFAULT_PROSE_RULES.find(
      (candidate) =>
        candidate.id === 'internal-path' &&
        Object.values(candidate.patterns).some(
          (pattern) => pattern instanceof RegExp && pattern.source.includes('scripts')
        )
    )
    const pattern = Object.values(rule?.patterns ?? {}).find((candidate) => candidate instanceof RegExp) as RegExp
    expect(pattern.test(`See ${MOVED_ROLE} for the rule.`)).toBe(true)
    expect(pattern.test(`See ${DOCTRINE_TREE}/executing/developer for the rule.`)).toBe(false)
  })

  it('the evidence path normalization', () => {
    expect(normaliseLines(`warning: /work/elsewhere/${MOVED_ROLE}:3: term`, '/repo')).toEqual([
      `warning: ${MOVED_ROLE}:3: term`
    ])
    expect(normaliseLines(`warning: /work/elsewhere/${NOT_DOCTRINE}:3: term`, '/repo')).toEqual([
      `warning: /work/elsewhere/${NOT_DOCTRINE}:3: term`
    ])
  })

  it('the Issue validation’s doc-path pattern', () => {
    const body = (docs: string) => `**Docs to keep coherent** — ${docs}\n\n**Traps to avoid** — none.\n`
    expect(checkRationaleNamesDocs(body(`\`${MOVED_ROLE}\``)).status).toBe('pass')
    expect(checkRationaleNamesDocs(body(`\`${DOCTRINE_TREE}/tools/actions.ts\``)).status).toBe('fail')
  })

  it('the review policy’s role-file location', () => {
    expect(isProseLocation(`${MOVED_ROLE}:12`)).toBe(true)
    expect(isProseLocation(`${NOT_DOCTRINE}:12`)).toBe(false)
  })

  it('the protected-path policy: a moved role document needs Surface coverage, a process code file does not', () => {
    expect(isProtectedAdminPath(MOVED_ROLE)).toBe(true)
    expect(isProtectedAdminPath(NOT_DOCTRINE)).toBe(false)
    expect(checkSurfaceScope([MOVED_ROLE], { in: ['apps/cli/src'], out: [] }, [MOVED_ROLE])).toEqual({
      ok: false,
      violation: { path: MOVED_ROLE, reason: 'protected' }
    })
    expect(checkSurfaceScope([MOVED_ROLE], { in: [MOVED_ROLE], out: [] }, []).ok).toBe(true)
  })

  it('doctrine portability: map citations are portable, kernel, command line and process code citations are findings', () => {
    const page = (cited: string) => [{ path: MOVED_ROLE, content: `See \`${cited}\`.` }]
    for (const cited of [
      MOVED_ROLE,
      doctrineSource('enforcement.md'),
      `${BUNDLED_DOCTRINE_DIR}/${doctrineSource('glossary.md')}`,
      'roles/developer.md',
      'doctrine/contracts/'
    ]) {
      expect(checkDoctrinePortability(page(cited)), cited).toEqual([])
    }
    for (const cited of ['harness/kernel/log/log-sink.ts', 'apps/cli/src/index.ts', NOT_DOCTRINE]) {
      expect(checkDoctrinePortability(page(cited)), cited).toHaveLength(1)
    }
  })
})

describe('the short-version word cap reads the role doctrine at its new path', () => {
  it('refuses an over-cap role doctrine keyed by the logical key its moved path maps to', () => {
    const real = readFileSync(join(REPO_ROOT, MOVED_ROLE), 'utf8')
    const padding = ` ${'word '.repeat(SHORT_VERSION_MAX_WORDS + 10)}`
    const overCap = real.replace('**You own**', `**You own**${padding}`)
    const relPath = keyForRepoPath(MOVED_ROLE) as string
    const result = evaluatePublishedProse(
      [{ relPath, frontmatter: {}, body: overCap.replace(/^---[\s\S]*?\n---\n/, '') }],
      new Set([relPath])
    )
    expect(result.errors.some((error) => error.includes(`"${relPath}"`) && error.includes('word ceiling'))).toBe(true)
  })
})
