import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundaryPinnedFiles, DEFAULT_COLLISION_THRESHOLD, NO_GATE_CUTOVERS } from '@attalabs/aeg-core'
import type { CheckError } from '../../src/checks/contract'
import { resolveDoctrineRoot } from '../../src/commands/doctrine'
import type { BriefSection } from '../../src/lib/config'
import { validateForgeWrite, validateIssueContent } from '../../src/lib/forge-write'

/**
 * The Issue-rationale template is the body every planner copies, and the Issue
 * gate is what refuses a body. The two used to drift: the template asked for a
 * sentence the gate refuses and lacked a section the gate requires, and
 * nothing noticed until a real Issue was refused. This fills every template
 * placeholder with one minimal task and runs the result through the same two
 * in-process validators `vinaya issue create` runs, with injected readers, so
 * it never reaches the forge. A new placeholder with no filler, or a filler no
 * placeholder uses, fails here too, so the fill below tracks the template.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const root = resolveDoctrineRoot()
if (root === null) throw new Error('no doctrine root resolves from this checkout')
const template = readFileSync(join(root, 'templates', 'issue-rationale-template.md'), 'utf8')

const PINNED_FILE = 'apps/demo/src/greeting.ts'
const DOC_SOURCE = 'apps/demo/README.md'

/** One minimal task: the value each `[KEY — guidance]` placeholder becomes. */
const FILL: Record<string, string> = {
  TITLE: 'demo-v1 1 — The greeting names its caller',
  TIER: '1',
  PROJECT: 'demo',
  TYPE: 'feat',
  OBJECTIVE: 'The greeting names the caller it was asked to greet.',
  'SECOND OBJECTIVE': 'An empty caller name is answered with the generic greeting.',
  SOURCE: DOC_SOURCE,
  MECHANISM: 'the greeting wording the demo promises',
  'CITED OBJECTIVES': 'O1',
  'DOCUMENTATION NOTE': '',
  BOUNDARY: 'The greeting function learns the caller name; the command-line wrapper around it is a separate task.',
  'PINNED FILES': `\`${PINNED_FILE}\``,
  OUT: 'the command-line wrapper.',
  SIZING:
    'Passes all four tests: one verification story (the greeting unit test), one function, one file, one failure mode.',
  'BLAST RADIUS': 'demo only; no shared package changes.',
  'DEPENDENCY RATIONALE': 'No Depends-on; no Conflicts-with — no other open task touches the demo greeting.',
  TRAPS: 'do NOT trim the caller name inside the greeting; the caller trims it.',
  'AGENT CLASS': 'fast — one pure function and its test.',
  'STOP-AND-ESCALATE': 'if the greeting needs a locale, escalate severity:strategy.',
  DOCS: 'no-doc-surface — the greeting carries no documentation of its own.',
  'SURFACE IN': 'apps/demo/src, apps/demo/tests',
  'SURFACE OUT': 'apps/demo/cli',
  'PART OUTCOME': 'The greeting returns a sentence naming the caller.',
  'SECOND PART OUTCOME': 'An empty caller name yields the generic greeting.',
  'TEST PLAN NOTE': '',
  COMMAND: 'bun test apps/demo/tests/greeting.test.ts',
  EXPECTED: '0 fail',
  'STOP CONDITION': 'The greeting cannot name the caller without changing its signature.',
  ORIGIN: 'Principal-directed, as the smallest task this template can carry.'
}

const PLACEHOLDER_RE = /\[([A-Z][A-Z -]*[A-Z])(?: — [^\]]*)?\]/g

/** The block a planner copies — everything below the divider that follows the template's own heading. */
function copiedBlock(text: string): string {
  const withoutFrontmatter = text.replace(/^---\n[\s\S]*?\n---\n/, '')
  const divider = withoutFrontmatter.indexOf('\n---\n')
  if (divider === -1) throw new Error('the template carries no divider above the block to copy')
  return withoutFrontmatter.slice(divider + '\n---\n'.length)
}

const block = copiedBlock(template)
const placeholderKeys = [...block.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string)
const filled = block.replace(PLACEHOLDER_RE, (_whole, key: string) => FILL[key] ?? `[UNFILLED ${key}]`)

/** The repository's own Issue section list — the set `vinaya issue create` validates against. */
function issueSections(): BriefSection[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'vinaya.config.json'), 'utf8')) as {
    briefSchema: { issue: { sections: BriefSection[] } }
  }
  return config.briefSchema.issue.sections
}

const CHECKOUT: Record<string, string> = {
  [DOC_SOURCE]: '# Demo\n',
  [PINNED_FILE]: 'export function greeting(name: string): string {\n  return `Hello, ${name}`\n}\n'
}

/** `singleFix` grades the body as a single-fix Issue: no tranche label, a plain title, the single-fix rationale form. */
function gate(body: string, singleFix = false): CheckError[] {
  const retryCommand = 'vinaya issue create --validate-only …'
  return [
    ...validateForgeWrite({
      body,
      title: singleFix ? 'Feat(demo): The greeting names its caller' : '[demo-v1] 1 — The greeting names its caller',
      sections: issueSections(),
      changedFiles: [],
      retryCommand,
      issueNumber: null,
      gateCutovers: NO_GATE_CUTOVERS,
      singleFix
    }),
    ...validateIssueContent({
      body,
      labels: singleFix ? ['vinaya/type:feat'] : ['vinaya/tranche:demo-v1'],
      sharedPackages: [],
      projectPaths: [{ name: 'demo', path: 'apps/demo' }],
      retryCommand,
      issueNumber: null,
      briefSectionsSinceIssue: null,
      resolvesToFile: () => true,
      readFile: (path) => CHECKOUT[path] ?? null,
      docOwnersContent: null,
      milestoneSiblings: null,
      subjectRef: '',
      collisionPeers: null,
      subjectFiles: [PINNED_FILE],
      collisionThreshold: DEFAULT_COLLISION_THRESHOLD,
      commandReference: { file: null, binary: 'vinaya', commands: [], text: '' },
      configReference: { files: [], keys: [], text: '' },
      pinnedFileImporters: [],
      existsInTree: () => false,
      trackedFiles: Object.keys(CHECKOUT)
    })
  ]
}

describe('the Issue-rationale template, filled as written, passes the Issue gate', () => {
  it('every placeholder has a filler, and every filler a placeholder', () => {
    expect(placeholderKeys.filter((key) => !(key in FILL))).toEqual([])
    expect(Object.keys(FILL).filter((key) => !placeholderKeys.includes(key))).toEqual([])
  })

  it('the filled body passes every Issue gate check', () => {
    expect(gate(filled).map((e) => e.message)).toEqual([])
  })

  it('the filled Boundary pins a real file, as the brief render requires', () => {
    expect(boundaryPinnedFiles(filled)).toEqual([PINNED_FILE])
  })

  it('carries a Documentation section and names the sentinel the gate accepts', () => {
    expect(block).toMatch(/^## Documentation$/m)
    expect(block).toContain('`no-doc-surface`')
  })

  it('the single-fix form — the filled body without Sizing, Project(s) + blast radius and Dependency rationale — passes as a single-fix Issue and is refused as a tranche task', () => {
    const singleFix = filled.replace(
      /\*\*(?:Sizing|Project\(s\) \+ blast radius|Dependency rationale)\*\* — [^\n]*\n\n/g,
      ''
    )
    expect(singleFix).not.toMatch(/\*\*(?:Sizing|Project\(s\) \+ blast radius|Dependency rationale)\*\*/)
    expect(gate(singleFix, true).map((e) => e.message)).toEqual([])
    expect(
      gate(singleFix)
        .map((e) => e.message.split(':')[0])
        .filter((m) => m?.startsWith('issue-validation '))
        .sort()
    ).toEqual([
      'issue-validation Dependency rationale',
      'issue-validation Project(s) + blast radius',
      'issue-validation Sizing'
    ])
  })

  it('the gate refuses the same body with its Documentation section removed, so the pass above is not vacuous', () => {
    const withoutDocumentation = filled.replace(/## Documentation\n[\s\S]*?(?=\n## )/, '')
    expect(gate(withoutDocumentation).some((e) => e.message.includes('Documentation'))).toBe(true)
  })
})
