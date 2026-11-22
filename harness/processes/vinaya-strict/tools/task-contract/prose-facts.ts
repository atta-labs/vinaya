import { stripCode } from '../../../../kernel/adapters/code-host/github/strip-code'
import { topLevelSectionText } from '@attalabs/harness/issue-documentation'
import { parseRationaleFields } from './brief-render'
import { type IssueSectionResult, parseIssueParts, parseIssuePremises } from './issue-validation'

/**
 * Two rules about what a task Issue's prose says of the code. Both read the
 * body the way the Boundary's existing-condition rule does: fenced and
 * indented blocks are dropped (a worked example is not a claim) and inline
 * code spans are kept (a claim is written inside a span).
 */

/** The words that state the code's present condition. Whole words only. */
const CONDITION_WORD_RE = /\b(already|currently|wired)\b/i

/** A named place in the Issue's prose and the text sitting in it. */
type ProseField = { name: string; text: string }

/** The body with fenced and indented code removed and inline spans kept. */
function readable(body: string): string {
  return stripCode(body, { inlineSpans: 'keep' })
}

/** The four rationale fields the brief carries besides the Boundary, then each Part. */
function conditionFields(body: string): ProseField[] {
  const text = readable(body)
  const rationale = parseRationaleFields(text)
  const fields: ProseField[] = []
  const named: Array<[string, string | undefined]> = [
    ['Dependency rationale', rationale.dependencyRationale],
    ['Traps to avoid', rationale.trapsToAvoid],
    ['Suggested agent-class', rationale.suggestedAgentClass],
    ['Stop-and-escalate', rationale.stopAndEscalate]
  ]
  for (const [name, fieldText] of named) if (fieldText) fields.push({ name, text: fieldText })
  const parts = parseIssueParts(text)
  if (parts.ok) for (const part of parts.value) fields.push({ name: `Part ${part.n}`, text: part.text })
  return fields
}

/**
 * A Dependency rationale, Traps, agent-class or Stop-and-escalate field, or a
 * Part, that states the code's present condition while the Issue declares no
 * premise. The Boundary is left to `checkBoundaryClaimsNeedPremise`. A
 * malformed `## Premises` section is that section's own finding, not this one's.
 */
export function checkConditionWordsNeedPremise(body: string): IssueSectionResult {
  const premises = parseIssuePremises(body)
  if (!premises.ok || premises.value.length > 0) return { status: 'pass', errors: [] }

  const errors: string[] = []
  for (const field of conditionFields(body)) {
    const word = CONDITION_WORD_RE.exec(field.text)
    if (!word) continue
    errors.push(
      `issue-validation Premises: the ${field.name} says "${word[1]?.toLowerCase()}" — it states something about the code as it stands — but the Issue carries no \`## Premises\` section.`
    )
  }
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}

/** The file kinds a directory-less backticked name may carry and still be read as a file. */
const ROOT_FILE_EXTENSION_RE =
  /^(md|mdx|txt|json|jsonc|ts|tsx|js|jsx|mjs|cjs|mts|cts|yml|yaml|toml|lock|html|css|scss|sh|py|rb|go|rs|xml|ini|cfg|conf)$/i

/** A backticked token that reads as a repository file path: no whitespace or placeholder characters, and a real extension. */
function filePathOf(token: string): string | null {
  if (/[\s*<>{}$|;,()=]/.test(token) || /^[a-z][a-z0-9+.-]*:/i.test(token)) return null
  const path = token.replace(/^\.\//, '')
  if (path === '' || path.endsWith('/') || path.startsWith('/') || path.split('/').includes('..')) return null
  const last = path.split('/').pop() as string
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(last)
  // A name that only begins with a dot has no extension, and a version-like
  // tail (`v1.5`) is not a file kind.
  if (!ext || ext.index === 0 || !/[A-Za-z]/.test(ext[1] as string)) return null
  // A directory-less token is read only when its extension is one a file
  // carries, so a dotted identifier (`process.env`) is never taken for a file.
  if (!path.includes('/') && !ROOT_FILE_EXTENSION_RE.test(ext[1] as string)) return null
  return path
}

function backtickedPaths(text: string): string[] {
  const found = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => filePathOf((m[1] as string).trim()))
  return [...new Set(found.filter((p): p is string => p !== null))]
}

const PINNED_MARKER_RE = /\bPinned files\s*:/i
const OUT_MARKER_RE = /\bOut\s*:/i

/** The Boundary split into its prose and the `Pinned files:` and `Out:` clauses; only the prose is read. */
function boundaryProse(boundary: string): { prose: string; clauses: string } {
  const starts = [boundary.search(PINNED_MARKER_RE), boundary.search(OUT_MARKER_RE)].filter((i) => i !== -1)
  if (starts.length === 0) return { prose: boundary, clauses: '' }
  const cut = Math.min(...starts)
  return { prose: boundary.slice(0, cut), clauses: boundary.slice(cut) }
}

/** The places whose backticked paths are read: the Boundary's prose, four other fields, the Parts and the Stop conditions. */
function pathFields(body: string): ProseField[] {
  const text = readable(body)
  const rationale = parseRationaleFields(text)
  const fields: ProseField[] = []
  const named: Array<[string, string | undefined]> = [
    ['Boundary', rationale.boundary ? boundaryProse(rationale.boundary).prose : undefined],
    ['Dependency rationale', rationale.dependencyRationale],
    ['Traps to avoid', rationale.trapsToAvoid],
    ['Suggested agent-class', rationale.suggestedAgentClass],
    ['Stop-and-escalate', rationale.stopAndEscalate],
    ['Stop conditions', topLevelSectionText(text, 'Stop conditions') ?? undefined]
  ]
  for (const [name, fieldText] of named) if (fieldText) fields.push({ name, text: fieldText })
  const parts = parseIssueParts(text)
  if (parts.ok) for (const part of parts.value) fields.push({ name: `Part ${part.n}`, text: part.text })
  return fields
}

/**
 * Every backticked repository file path the prose names that the tree does
 * not hold and the Issue does not account for. A path is accounted for when it
 * is a tracked file, the tail of exactly one tracked path, named inside the
 * Boundary's `Pinned files:` or `Out:` clause (a file to create, or one left
 * out), or named by a declared premise, deferred ones included. With no
 * tracked-file list there is no tree to compare with, so nothing is reported.
 */
export function checkProsePathsExist(body: string, trackedFiles: string[]): IssueSectionResult {
  if (trackedFiles.length === 0) return { status: 'pass', errors: [] }

  const tracked = new Set(trackedFiles)
  const exempt = new Set<string>()
  const boundary = parseRationaleFields(readable(body)).boundary
  if (boundary) for (const path of backtickedPaths(boundaryProse(boundary).clauses)) exempt.add(path)
  const premises = parseIssuePremises(body)
  if (premises.ok) for (const premise of premises.value) exempt.add(premise.path.replace(/^\.\//, ''))

  const holds = (path: string): boolean =>
    tracked.has(path) || trackedFiles.filter((file) => file.endsWith(`/${path}`)).length === 1

  const errors: string[] = []
  for (const field of pathFields(body)) {
    for (const path of backtickedPaths(field.text)) {
      if (exempt.has(path) || holds(path)) continue
      errors.push(
        `issue-validation Prose files: the ${field.name} names \`${path}\`, which is not in the tracked tree and is neither pinned to create nor stated as a premise.`
      )
    }
  }
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}
