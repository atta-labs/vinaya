import { stripCode } from '@harness/kernel/gates/checks/anchored-region'

/**
 * The one list of level-two sections a task Issue may carry. The Issue write
 * gate (`checkKnownIssueSections`) and the brief render read it, so a section
 * the brief cannot carry is refused by name instead of passing the gate and
 * never reaching the Developer.
 *
 * Each entry states what becomes of the section: `carried` — the brief copies
 * or derives content from it, into the brief part named by `briefPart` — or
 * `stays-on-issue` — the Issue keeps it and the brief never mentions it.
 * `Premises` is optional in an Issue and is not a heading of the Issue
 * template, so this list is written out, never derived from the template.
 */
export type IssueSectionDisposition = 'carried' | 'stays-on-issue'

export type IssueSection = {
  /** The level-two heading, matched without regard to letter case. */
  heading: string
  disposition: IssueSectionDisposition
  /** For a carried section: the heading of the brief part that holds its content. */
  briefPart?: string
}

export const ISSUE_SECTIONS: readonly IssueSection[] = [
  { heading: 'Objectives', disposition: 'carried', briefPart: '## Objectives' },
  { heading: 'Documentation', disposition: 'carried', briefPart: '## Documentation' },
  { heading: 'Premises', disposition: 'carried', briefPart: '## Premises' },
  { heading: 'Surface', disposition: 'carried', briefPart: '## 4. Technical surface map' },
  { heading: 'Parts', disposition: 'carried', briefPart: '## 6. Numbered parts' },
  { heading: 'Test plan', disposition: 'carried', briefPart: '## 9. Test Plan' },
  { heading: 'Stop conditions', disposition: 'carried', briefPart: '## 10. Stop conditions' },
  { heading: 'Origin', disposition: 'stays-on-issue' },
  { heading: 'Check decisions', disposition: 'carried', briefPart: '## Check decisions' },
  { heading: 'Covering checks', disposition: 'carried', briefPart: '## Check decisions' }
]

/**
 * The Planner's rationale fields. A level-two section that holds any of them
 * is the rationale section and is known under whatever heading it carries.
 * `readByBrief` marks the fields the brief render reads; the others stay on
 * the Issue. Label patterns are tolerant and case-insensitive; embed them
 * grouped in a regex.
 */
export type RationaleFieldSpec = {
  key: string
  name: string
  pattern: string
  readByBrief: boolean
}

export const RATIONALE_FIELD_SPECS: readonly RationaleFieldSpec[] = [
  { key: 'boundary', name: 'Boundary', pattern: 'Boundary', readByBrief: true },
  { key: 'sizing', name: 'Sizing', pattern: 'Sizing', readByBrief: false },
  {
    key: 'blastRadius',
    name: 'Project(s) + blast radius',
    pattern: 'Project\\(s\\)|Project(?:s)?\\s*\\+|blast radius',
    readByBrief: false
  },
  {
    key: 'dependencyRationale',
    name: 'Dependency rationale',
    pattern: 'Dependency rationale|Depends[- ]on',
    readByBrief: true
  },
  { key: 'trapsToAvoid', name: 'Traps to avoid', pattern: 'Traps', readByBrief: true },
  {
    key: 'suggestedAgentClass',
    name: 'Suggested agent-class',
    pattern: '(?:Suggested\\s+)?agent-class',
    readByBrief: true
  },
  { key: 'stopAndEscalate', name: 'Stop-and-escalate', pattern: 'Stop-and-escalate', readByBrief: true },
  { key: 'docsToKeepCoherent', name: 'Docs to keep coherent', pattern: 'Docs to keep coherent|§7', readByBrief: true }
]

/** The label pattern of one rationale field, by key. */
export function rationaleFieldPattern(key: string): string {
  const spec = RATIONALE_FIELD_SPECS.find((f) => f.key === key)
  if (spec === undefined) throw new Error(`unknown rationale field ${key}`)
  return spec.pattern
}

/** The heading of the carried section with this heading, for the brief render to emit. */
export function carriedSectionHeading(heading: string): string {
  const entry = ISSUE_SECTIONS.find((s) => s.heading === heading && s.disposition === 'carried')
  if (entry === undefined) throw new Error(`no carried Issue section ${heading}`)
  return `## ${entry.heading}`
}

const normalize = (heading: string): string =>
  heading
    .trim()
    .replace(/[:\s]+$/, '')
    .toLowerCase()

const KNOWN_HEADINGS = new Set(ISSUE_SECTIONS.map((s) => normalize(s.heading)))

const FIELD_AS_HEADING_RES = RATIONALE_FIELD_SPECS.map((f) => new RegExp(`^(?:${f.pattern})(?![\\w-])`, 'i'))
const FIELD_IN_SECTION_RES = RATIONALE_FIELD_SPECS.map(
  (f) => new RegExp(`(?:\\*\\*|^#{1,4}\\s+)\\s*(?:${f.pattern})`, 'im')
)

const LEVEL_TWO_HEADING_RE = /^##[ \t]+(\S.*?)[ \t]*#*[ \t]*$/gm

/**
 * Level-two sections of the body with fenced and indented code removed, so a
 * heading inside a code block is never a section.
 */
export function levelTwoSections(body: string): Array<{ heading: string; text: string }> {
  const text = stripCode(body)
  const found = [...text.matchAll(LEVEL_TWO_HEADING_RE)]
  return found.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < found.length ? (found[i + 1]!.index ?? text.length) : text.length
    return { heading: m[1]!, text: text.slice(start, end) }
  })
}

function isKnownSection(section: { heading: string; text: string }): boolean {
  if (KNOWN_HEADINGS.has(normalize(section.heading))) return true
  if (FIELD_AS_HEADING_RES.some((re) => re.test(section.heading.trim()))) return true
  return FIELD_IN_SECTION_RES.some((re) => re.test(section.text))
}

/**
 * Refuses a level-two section whose heading is not on `ISSUE_SECTIONS`, is not
 * itself a rationale field label, and holds no rationale field. The refusal
 * names the heading, prints the known headings and says where content the
 * Developer needs is written instead.
 */
export function checkKnownIssueSections(body: string): { status: 'pass' | 'fail'; errors: string[] } {
  const known = ISSUE_SECTIONS.map((s) => `\`## ${s.heading}\``).join(', ')
  const errors = levelTwoSections(body)
    .filter((s) => !isKnownSection(s))
    .map(
      (s) =>
        `issue-validation unknown section: the Issue carries a \`## ${s.heading}\` section that is not a known Issue section, so the brief cannot carry it and the Developer would work without its content. Known sections: ${known}, and the section that holds the Planner's rationale fields under any heading. Write content the Developer needs in a rationale field, or in an in-repository source listed under \`## Documentation\`.`
    )
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}
