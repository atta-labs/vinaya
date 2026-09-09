/**
 * Task-brief renderer (review-convergence-v1 task 12, #387). Pure — no `fs`,
 * no `gh`/`git`, no `process.env`. Reads `aeg-root/templates/brief-template.md`
 * (passed in as `template`, read at run time by the CLI shim
 * `apps/cli/src/commands/brief.ts`) and every derivable fact (`BriefFacts`,
 * assembled by that same shim from the forge and the tree) and emits the
 * twelve-section brief skeleton with every mechanically-derivable section
 * filled. A section this module cannot derive from a stated fact is never
 * defaulted — `renderBrief` refuses, naming the missing fact, per Issue #387's
 * rule: "no section is written by hand; the rationale is the one hand-written
 * artefact and the Issue creation gate is its review."
 *
 * Every judgment section (Technical dependencies' free-form detail beyond the
 * Dependency-rationale field, the Pre-flight task-specific checks, the
 * Verification command list beyond the fixed full run) is out of this task's
 * scope — Issue #387: "NOT this task: rendering any judgment section." Those
 * sections are rendered with the mechanical content this module CAN derive;
 * anything genuinely judgment-only is left for the Planner to add by
 * hand after render.
 */

import { deriveSection7 } from './derive-section7'
import {
  BRIEF_SECTIONS_SINCE_ISSUE,
  globCoversPath,
  type IssuePart,
  type IssueSurface,
  type IssueTestPlan,
  OBJECTIVES_SINCE_ISSUE
} from './issue-validation'
import { type Objective, renderObjectives } from './objectives'
import { applyTierFloor, deriveTierFromDiff, readTierFromPrBody } from './pr-tier'

export type RationaleFieldKey =
  | 'boundary'
  | 'dependencyRationale'
  | 'trapsToAvoid'
  | 'suggestedAgentClass'
  | 'stopAndEscalate'

/**
 * Tolerant label patterns for the five rationale fields this renderer
 * consumes — the same patterns `issue-validation.ts`'s `checkIssueRationale`
 * uses for presence, so a field this renderer can read is exactly a field
 * that gate already required present. Not imported directly:
 * `issue-validation.ts` keeps its own copy private (`RATIONALE_FIELDS`), and
 * duplicating the five patterns here is cheaper than exporting a new surface
 * from a file outside this task's boundary.
 */
const RATIONALE_FIELD_PATTERNS: Record<RationaleFieldKey, string> = {
  boundary: 'Boundary',
  dependencyRationale: 'Dependency rationale|Depends[- ]on',
  trapsToAvoid: 'Traps',
  suggestedAgentClass: '(?:Suggested\\s+)?agent-class',
  stopAndEscalate: 'Stop-and-escalate'
}

const RATIONALE_FIELD_NAMES: Record<RationaleFieldKey, string> = {
  boundary: 'Boundary',
  dependencyRationale: 'Dependency rationale',
  trapsToAvoid: 'Traps to avoid',
  suggestedAgentClass: 'Suggested agent-class',
  stopAndEscalate: 'Stop-and-escalate'
}

/**
 * Slices one rationale field's prose out of an Issue body: from its label to
 * the next bold/heading field, or the end. Adapted from `issue-validation.ts`'s
 * private `rationaleFieldText` (see that function's doc comment for why the
 * terminator is `(?![\s\S])`, not `$`, and why the label pattern must stay
 * grouped) — duplicated rather than imported because that helper is not
 * exported and `issue-validation.ts` is out of this task's surface.
 *
 * Anchors the label's own `**`/heading marker to the START of a line
 * (`^\s*`), unlike the copied original — a presence-only check can tolerate
 * matching a field name mentioned in passing mid-paragraph (the field is
 * still present somewhere), but an EXTRACTION cannot: found live, self-
 * rendering this very task's own Issue (#387), whose "Boundary" field
 * prose contains the inline aside "`For:`/`Reason:` from
 * **Suggested agent-class**" — the unanchored original matched that inline
 * mention first (it is merely preceded by literal `**` characters
 * somewhere in the text, never required to start a line) and returned the
 * Boundary field's own tail as the "Suggested agent-class" field's content.
 */
function sliceRationaleField(text: string, labelPattern: string): string {
  const re = new RegExp(
    `^\\s*(?:\\*\\*|#{1,4}\\s+)\\s*(?:${labelPattern})[^\\n]*\\n?([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*[A-Z]|#{1,4}\\s)|(?![\\s\\S]))`,
    'im'
  )
  const m = re.exec(text)
  return m ? m[0].trim() : ''
}

/**
 * `parseRationaleFields`' result — the five rationale fields plus the
 * Issue's own declared `Tier:` field (task 12, Issue #469, O1), read from
 * the same `body` this function already receives. Piggybacked on this
 * existing call rather than added as a new `BriefFacts` property threaded in
 * by the caller: `rationale: parseRationaleFields(issueBody)` is already the
 * one call site (in `apps/cli` and in this file's own tests) that has the
 * raw Issue body in hand, so extending its return shape reaches
 * `renderBrief` without a second, caller-side wire to keep in sync.
 */
export type ParsedRationale = Partial<Record<RationaleFieldKey, string>> & {
  /** `readTierFromPrBody(body)` — `null` when the Issue declares no `Tier:` field, or an invalid one. */
  declaredTier?: 0 | 1 | 3 | null
}

/**
 * Reads the five rationale fields this renderer needs out of a task Issue's
 * body, tolerant of both live serializations `checkIssueRationale` accepts
 * (`**Field** — …` bold-inline, `### Field` heading). A field absent from the
 * body is simply absent from the returned record — never an empty string —
 * so `renderBrief`'s missing-fact check can tell "absent" from "present but
 * empty".
 */
export function parseRationaleFields(body: string): ParsedRationale {
  const out: Partial<Record<RationaleFieldKey, string>> = {}
  for (const key of Object.keys(RATIONALE_FIELD_PATTERNS) as RationaleFieldKey[]) {
    const text = sliceRationaleField(body, RATIONALE_FIELD_PATTERNS[key])
    if (text) out[key] = text
  }
  return { ...out, declaredTier: readTierFromPrBody(body) }
}

/**
 * The backtick-wrapped, path-shaped tokens named in the Boundary field's own
 * prose — the ONLY mechanical source §4 (`renderSection4`, below) draws its
 * Create/Modify file list and premise pins from (task 5, Issue #447, O3).
 *
 * `## Surface` is directory-level globs only, by design (its own grammar
 * refuses file paths) — expanding those globs wholesale into §4 is the exact
 * defect this replaces: live evidence, an Issue declaring `apps/cli/**`
 * rendered a brief instructing the developer to modify roughly four hundred
 * files, each with its own sha256 pin. The Planner's Boundary prose is where
 * task authors already name the real files in scope (to justify why each is
 * touched) — extracting from there, instead of from Surface, also reaches
 * files a directory glob cannot express at all: this very task's own
 * Boundary names `packages/aeg-core/src/brief-render.ts`, which sits outside
 * every one of its Surface `in:` globs.
 *
 * A token counts as path-shaped when it is backtick-delimited, contains no
 * space (excludes multi-word command examples like `git push -u origin
 * HEAD`) or `*` (excludes glob examples like `apps/cli/**`), and ends in a
 * short alphanumeric extension. Resolving a token to a real repo path (exact
 * match, or a unique `git ls-files` suffix match for a bare filename elided
 * from a shared directory prefix in the Boundary prose, e.g. "aeg-root/
 * aeg-manual-flow.md, process.md, roles/developer.md") is the caller's job —
 * this function is pure text extraction, no `fs`/`git`.
 */
export function extractBoundaryFilePaths(boundaryText: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of boundaryText.matchAll(/`([^`\n]+)`/g)) {
    const token = (match[1] as string).trim()
    if (token.length === 0 || token.includes(' ') || token.includes('*')) continue
    if (!/\.[A-Za-z0-9]{1,6}$/.test(token)) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** One §4 surface-map file: its path, a whole-file `sha256` premise pin, and the workspace package that owns it (`null` for a file outside every workspace member, e.g. a doctrine file under `aeg-root/`). */
export type SurfaceFileFact = {
  path: string
  /** `null` for a file that does not exist yet on disk (a "Create" entry) — a not-yet-created file has no current sha256 to pin. */
  sha256: string | null
  /** The owning workspace package's own `name` field (e.g. `@attalabs/aeg-core`) — never a directory path; this is what feeds `bunx turbo test --filter=<packageName>` directly. */
  packageName: string | null
}

export type BriefFacts = {
  trancheSlug: string
  taskId: string
  title: string
  issue: number
  projects: string[]
  dependsOn: string[]
  conflictsWith: string[]
  rationale: ParsedRationale
  /** The Issue's `## Objectives` list (`objectives.ts`'s `objectivesOf`), copied into the brief verbatim between the header and §2. */
  objectives: Objective[]
  /**
   * The Issue's `## Surface` section (`issue-validation.ts`'s
   * `parseIssueSurface`) — feeds §4's Out of surface line and, together with
   * `surfaceFiles`, its Create/Modify split. `{ in: [], out: [] }` (an empty
   * `in:` list) is the absent-section sentinel: a real Surface always
   * parses at least one `in:` glob, so an empty one means the Issue has no
   * `## Surface` section (or it failed to parse) — the same
   * empty-list-means-absent convention `objectives: []` already uses above.
   */
  surface: IssueSurface
  /**
   * The Issue's `## Parts` list (`issue-validation.ts`'s `parseIssueParts`),
   * copied into §6 verbatim — one numbered Part per entry. `[]` is the
   * absent-section sentinel, same convention as `objectives`/`surface`.
   */
  parts: IssuePart[]
  /**
   * The Issue's `## Test plan` section (`issue-validation.ts`'s
   * `parseIssueTestPlan`), copied into §9 verbatim. `{ kind: 'commands',
   * lines: [], principal: [] }` is the absent-section sentinel — a real
   * `commands` plan always carries at least one line or one principal item.
   */
  testPlan: IssueTestPlan
  /**
   * The Issue's `## Stop conditions` bullets (`issue-validation.ts`'s
   * `parseIssueStopConditions`), copied into §10 alongside the rationale's
   * own Stop-and-escalate field. `[]` is the absent-section sentinel, same
   * convention as `objectives`/`parts`.
   */
  stopConditions: string[]
  dispatchReady: boolean
  dispatchBlockers: string[]
  surfaceFiles: SurfaceFileFact[]
  /** Workspace package directories (e.g. `apps/cli`) that depend on `@attalabs/<pkg>` — same shape `checkConsumerTests` consumes, injected rather than derived here (this module reads no `fs`). */
  consumersOf: (pkg: string) => string[]
  /** `.vinaya/doc-owners` file content, or `null` when the file is absent — passed through to `deriveSection7` unchanged. */
  docOwnersContent: string | null
}

export type RenderResult = { ok: true; brief: string } | { ok: false; missing: string[] }

/**
 * §4's surface map lists only what the Issue's own `## Surface` admits (task
 * 12, Issue #469, O2) — a path the Boundary named inside its `Out:` clause
 * was named in order to exclude it, and prose position is not a reliable
 * signal of that, so the `## Surface` globs are the authority. Admitted
 * means covered by at least one `in:` glob and by no `out:` glob;
 * `globCoversPath` (`issue-validation.ts`) is the same glob matcher
 * `checkSurfaceScope` already uses, consumed here rather than reimplemented.
 */
function admittedSurfaceFiles(surfaceFiles: SurfaceFileFact[], surface: IssueSurface): SurfaceFileFact[] {
  return surfaceFiles.filter((f) => {
    const admitted = surface.in.some((g) => globCoversPath(g, f.path))
    const excluded = surface.out.some((g) => globCoversPath(g, f.path))
    return admitted && !excluded
  })
}

function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n')
}

function isTestFile(path: string): boolean {
  return /\.test\.[jt]sx?$/i.test(path)
}

function renderHeader(facts: BriefFacts, template: string): string {
  const introMatch = template.match(/^You are the AEG Developer\.[^\n]*$/m)
  const intro = introMatch
    ? (introMatch[0] as string)
        .replace(/\s*\[[^\]]*\]/g, '')
        .replace(/\bBoth mandatory\.$/, 'Mandatory.')
        .trim()
    : 'You are the AEG Developer. Read `aeg-root/roles/developer.md` first. Mandatory.'

  const reason = facts.rationale.suggestedAgentClass ?? ''
  // The declared tier is a floor, not a default: raised to the mechanical
  // derivation only when that derivation is higher, never lowered — a
  // Planner's judgment (including a hand-raised Tier 3, which no derivation
  // can reach) is never silently overridden by a derivation that cannot see
  // it (task 12, Issue #469, O1).
  const derivedFloor = deriveTierFromDiff(facts.surfaceFiles.map((f) => f.path))
  const tier = applyTierFloor(facts.rationale.declaredTier ?? null, derivedFloor)
  const lines = [
    '**For:** [model] (coding-agent CLI on a dev machine, dispatched locally, unattended)',
    `**Reason:** ${reason}`,
    '**Owner:** the Principal',
    `**Goal:** ${facts.title}`,
    `**Project:** ${facts.projects.join(', ')}`,
    `**Tier:** ${tier}`,
    '',
    `Closes #${facts.issue}`,
    '',
    intro
  ]
  return lines.join('\n')
}

function renderSection2(facts: BriefFacts): string {
  const depends = facts.dependsOn.length > 0 ? facts.dependsOn.join(', ') : '—'
  const conflicts = facts.conflictsWith.length > 0 ? facts.conflictsWith.join(', ') : '—'
  const lines = [
    '## 2. Context — read before doing anything',
    '',
    `- **Tranche:** \`${facts.trancheSlug}\`, task ${facts.taskId}, Issue #${facts.issue}. Branch \`task/${facts.trancheSlug}/${facts.taskId}\`. \`Depends-on: ${depends}\`, \`Conflicts-with: ${conflicts}\`. Confirm \`READY TO DISPATCH\` at your own Step 0.`,
    `- **Read Issue #${facts.issue} in full** for the complete rationale — do not re-derive it.`,
    `- ${facts.rationale.boundary}`,
    `- ${facts.rationale.trapsToAvoid}`
  ]
  return lines.join('\n')
}

function renderSection3(facts: BriefFacts): string {
  return ['## 3. Technical dependencies', '', `${facts.rationale.dependencyRationale}`].join('\n')
}

function renderSection4(facts: BriefFacts): string {
  const created = facts.surfaceFiles.filter((f) => f.sha256 === null).map((f) => f.path)
  const modified = facts.surfaceFiles.filter((f) => f.sha256 !== null).map((f) => f.path)

  const byPackage = new Map<string, SurfaceFileFact[]>()
  for (const f of facts.surfaceFiles) {
    if (!f.packageName) continue
    const list = byPackage.get(f.packageName) ?? []
    list.push(f)
    byPackage.set(f.packageName, list)
  }

  // checkConsumerTests (brief-validation.ts) requires, for every workspace
  // package a touched `packages/<pkg>` consumer depends on, either a named
  // test path under that consumer OR the `consumer-tests: none — <reason>`
  // sentinel — ONE sentinel occurrence anywhere in §4 satisfies the whole
  // section, so a single combined line covers every uncovered consumer.
  const uncovered: string[] = []
  for (const pkg of byPackage.keys()) {
    const shortName = pkg.replace(/^@[^/]+\//, '')
    for (const consumer of facts.consumersOf(shortName)) {
      const covered = facts.surfaceFiles.some((f) => f.path.startsWith(`${consumer}/`) && isTestFile(f.path))
      if (!covered) uncovered.push(`${pkg} (${consumer})`)
    }
  }
  const consumerLines =
    uncovered.length > 0
      ? [
          `- consumer-tests: none — no consumer test path named yet for ${uncovered.join(', ')}; name one before dispatch, or confirm no consumer-facing behavior changed.`
        ]
      : []

  const lines = [
    '## 4. Technical surface map',
    '',
    '**Create:**',
    created.length > 0 ? bulletList(created) : '- (none — every surface file already exists)',
    '',
    '**Modify:**',
    modified.length > 0 ? bulletList(modified) : '- (none named)',
    ...(consumerLines.length > 0 ? ['', ...consumerLines] : []),
    '',
    '**Out of surface:** ' +
      (facts.surface.out.length > 0
        ? facts.surface.out.join(', ')
        : "(none named — the Issue's `## Surface` `out:` line is empty)"),
    '',
    '#### Premise pins',
    '',
    '**Premise:**',
    bulletList(
      facts.surfaceFiles
        .filter((f): f is SurfaceFileFact & { sha256: string } => f.sha256 !== null)
        .map((f) => `${f.path} sha256: ${f.sha256}`)
    )
  ]
  return lines.join('\n')
}

function renderSection5(facts: BriefFacts): string {
  const lines = [
    '## 5. Pre-flight checks',
    '',
    '**Step 0 (mandatory, verbatim):**',
    '',
    '```',
    `git worktree add .worktrees/task/${facts.trancheSlug}/${facts.taskId} -b task/${facts.trancheSlug}/${facts.taskId} --no-track origin/main && cd .worktrees/task/${facts.trancheSlug}/${facts.taskId} && git config push.autoSetupRemote true && bun install --frozen-lockfile --silent`,
    '```',
    '',
    '1. Clean status; parent `origin/main`; branch suffix literal-matches the task id.',
    '2. `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>` → `READY TO DISPATCH` (re-derived at render time: it was).',
    '',
    'On any failure: STOP and report.'
  ]
  return lines.join('\n')
}

/** `Part <n> (<refs>)` reconstructed from a parsed `IssuePart` — the same citation grammar `brief-validation.ts`'s `PART_CITATION_RE` reads back out of §6. */
function renderPartCitation(part: IssuePart): string {
  const refs = part.objectiveIds.map((id) => `O${id}`).join(', ')
  return `Part ${part.n} (${refs})`
}

/** Mirrors `brief-validation.ts`'s private `CHECK_NAME_RE` — not exported there, duplicated here for the same §4-triggers-a-§6-Defeat-cases-line rule `checkDefeatCases` enforces on the rendered output. */
const RENDER_CHECK_NAME_RE = /\bcheck-[a-z0-9-]+(?:\.ts)?\b/
/** Mirrors `brief-validation.ts`'s private `FORGE_WRITE_COMMAND_RE`. */
const RENDER_FORGE_WRITE_COMMAND_RE =
  /\bgh\s+(?:pr|issue)\s+(?:create|merge|close|comment|edit|review)\b|\bgit\s+push\b|\bvinaya\s+pr\s+(?:create|report\s+--write)\b/i

/**
 * §6 — one numbered Part per `IssuePart` (facts.parts), citation
 * reconstructed verbatim per `renderPartCitation`. Files stay grouped by
 * package exactly as before this task; a Part is zipped by position to a
 * package group (Part 1 → the first touched package, Part 2 → the second,
 * …) — the Issue's own Parts don't name globs, so position is the one
 * mechanical link between "a Part exists" and "these files belong to it".
 * A Part beyond the package-group count (an administrative Part — a
 * changeset commit, the final push) renders with no Files sub-list; a
 * package group beyond the Part count is appended to the last Part.
 */
function renderSection6(facts: BriefFacts): string {
  const byPackage = new Map<string, SurfaceFileFact[]>()
  const rootFiles: SurfaceFileFact[] = []
  for (const f of facts.surfaceFiles) {
    if (!f.packageName) {
      rootFiles.push(f)
      continue
    }
    const list = byPackage.get(f.packageName) ?? []
    list.push(f)
    byPackage.set(f.packageName, list)
  }
  const groups: Array<{ pkg: string; files: SurfaceFileFact[] }> = [...byPackage].map(([pkg, files]) => ({
    pkg,
    files
  }))
  if (rootFiles.length > 0) groups.push({ pkg: 'the repo root', files: rootFiles })

  const section4Text = renderSection4(facts)
  const needsDefeatCases = RENDER_CHECK_NAME_RE.test(section4Text) || RENDER_FORGE_WRITE_COMMAND_RE.test(section4Text)

  const rendered = facts.parts.map((part, i) => {
    const group = i < groups.length ? groups[i] : undefined
    // Every group beyond the last Part attaches to that last Part, rather
    // than being silently dropped.
    const extraGroups = i === facts.parts.length - 1 ? groups.slice(facts.parts.length) : []
    const allGroups = group ? [group, ...extraGroups] : extraGroups
    const fileLines = allGroups.flatMap((g) => [
      '',
      `   Files (touches ${g.pkg}):`,
      ...g.files.map((f) => `   - ${f.path}`)
    ])
    const lines = [
      `${part.n}. **${renderPartCitation(part)}:** ${part.text}`,
      ...fileLines,
      ...(fileLines.length > 0
        ? [
            '',
            '   The pre-push hook runs the affected suite on your one push and refuses it on failure — do not run it yourself per Part.'
          ]
        : []),
      ...(i === facts.parts.length - 1 && needsDefeatCases
        ? [
            '',
            "   **Defeat cases:** — see this Part's outcome text above, and the Traps to avoid field, for the inputs that would defeat the check(s)/command(s) named in §4."
          ]
        : [])
    ]
    return lines.join('\n')
  })

  return ['## 6. Numbered parts — commit after EACH part; push once, before opening the PR', '', ...rendered].join('\n')
}

function renderSection7(section7Pointers: string[]): string {
  const lines = ['## 7. Documentation-update list', '']
  if (section7Pointers.length > 0) {
    lines.push(bulletList(section7Pointers))
  } else {
    lines.push(
      "`.vinaya/doc-owners` derivation matched zero bindings against this task's surface — no mechanically-derived doc updates. Confirm no additional doc artifact applies before treating this list as final."
    )
  }
  return lines.join('\n')
}

function renderSection8(): string {
  return [
    '## 8. Verification before claiming done',
    '',
    // Never `rm -rf apps/cli/dist &&`-prefixed (Principal ruling, PR
    // `open-1`): that removal is a Developer pre-flight step in doctrine,
    // never a command a check or `pr report` executes — `evidence-fresh`
    // re-running it under the twenty-six sibling checks CI had just built
    // deleted their own `dist` out from under them.
    '- The pre-push hook already ran the affected suite on your one push and refused it on failure — do not additionally run it yourself; `vinaya pr report --write`/`--push` separately re-runs it with `--force` to attest the command and its output in the Evidence block.',
    "- The full `bun run test` suite is CI's to run, on the one push — never run it locally.",
    '- Every blast-radius consumer named in §4, re-verified by name.',
    '- `roles/developer.md`\'s tier checklist genuinely satisfied, and `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.'
  ].join('\n')
}

/**
 * A fence marker guaranteed not to be broken by `lines`' own content — one
 * backtick longer than the longest run of consecutive backticks any line
 * contains, minimum three (CommonMark's own floor for a fenced block).
 *
 * `facts.testPlan.lines` is Issue-body text (`parseIssueTestPlan`), not
 * this renderer's own literal — the Issue's `## Test plan` section can
 * itself be fenced with a LONGER backtick run than three (` ```` ` around a
 * body containing a literal ` ``` `), which `extractFencedBlocks` reads as
 * ordinary content, not a nested fence. Splicing that content between a
 * *fixed* ` ``` ` here would let the embedded run close this section's own
 * fence early, spilling the rest of the Issue's text out as unfenced
 * prose in the rendered brief — found live reviewing this exact task.
 */
function safeFence(lines: string[]): string {
  let longest = 0
  for (const line of lines) {
    const m = line.match(/`+/g)
    if (!m) continue
    for (const run of m) longest = Math.max(longest, run.length)
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * §9 — copied from the Issue's own `## Test plan` section (`facts.testPlan`),
 * never re-derived from the surface file list. `renderBrief`'s missing-fact
 * check refuses before this runs when the Issue carries no parseable Test
 * plan, so by the time this executes `facts.testPlan` is real.
 */
function renderSection9(facts: BriefFacts): string {
  if (facts.testPlan.kind === 'unit-tests-only') {
    // Deliberately unbolded: `locateTestPlanSection`'s heading-form slicer
    // treats a bold `**Field:**`-shaped line as the START of the NEXT
    // section (`NEXT_SECTION_RE`) — a bolded `**Test Plan:** unit-tests-only`
    // line right under the `## 9. Test Plan` heading would cut the section
    // boundary before its own content, leaving `checkTestPlan` nothing to
    // find. Plain `Test Plan: unit-tests-only` still satisfies
    // `TEST_PLAN_UNIT_TESTS_ONLY_RE` (both forms are equivalent to it).
    return ['## 9. Test Plan', '', 'Test Plan: unit-tests-only'].join('\n')
  }

  const principalLines = facts.testPlan.principal.map((p) => `- [ ] **[principal]** ${p}`)
  const fence = safeFence(facts.testPlan.lines)
  return [
    '## 9. Test Plan',
    '',
    fence,
    ...facts.testPlan.lines,
    fence,
    ...(principalLines.length > 0 ? ['', ...principalLines] : [])
  ].join('\n')
}

/** §10 — the Issue's own `## Stop conditions` bullets, followed by the rationale's Stop-and-escalate field, never the field alone. */
function renderSection10(facts: BriefFacts): string {
  return [
    '## 10. Stop conditions',
    '',
    ...facts.stopConditions.map((c) => `- ${c}`),
    '',
    `${facts.rationale.stopAndEscalate}`
  ].join('\n')
}

function renderSection11(template: string, facts: BriefFacts): string {
  const trapsText = facts.rationale.trapsToAvoid ?? ''
  const doNotLines = trapsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\(?\d+\)?[.)]?\s/.test(l) || l.startsWith('-'))
    .map((l) => l.replace(/^\(?\d+\)?[.)]?\s*/, '').replace(/^-\s*/, ''))
    .filter((l) => l.length > 0)
    .map((l) => `- Do NOT ${l.charAt(0).toLowerCase()}${l.slice(1)}`)

  const autonomyMatch = template.match(/> \*\*Autonomy:\*\*[\s\S]*?(?=\n\n## \d+\. Deliverable|\n\n## Deliverable|$)/)
  const autonomy = autonomyMatch ? (autonomyMatch[0] as string).trim() : ''

  return ['## 11. Constraints', '', ...doNotLines, '', autonomy].join('\n')
}

function renderSection12(facts: BriefFacts): string {
  return [
    '## 12. Deliverable',
    '',
    `- PR title (exact): \`[${facts.trancheSlug}] ${facts.taskId} — ${facts.title}\``,
    '- Open the PR only via `bun apps/cli/src/index.ts pr create --body-file <path> --title "<title above>"`.',
    "- PR body = the Developer's PR report (start from `aeg-root/templates/pr-report-template.md`), with this entire brief pasted as the reference copy inside a collapsed `<details>` block, and `Closes #" +
      facts.issue +
      '` at the top of the header block.',
    '- Pre-open gate: tier checklist satisfied, and `PR_BODY="$(cat <body-file>)" bun packages/aeg-core/bin/verify-docs.ts --pr` green.',
    '- Include `git diff main --stat` and a token report (if unavailable, state so).',
    '- Then STOP. Review and Verification are separate invocations.'
  ].join('\n')
}

/**
 * Emits the twelve-section brief skeleton from `facts`, reading `template`
 * (the raw content of `aeg-root/templates/brief-template.md`) only for the
 * one fixed sentence (`renderHeader`'s intro line) and the standing autonomy
 * clause (`renderSection11`) — every other byte is generated from `facts`,
 * never copied from a hardcoded template string in this module.
 *
 * Refuses — `{ ok: false, missing }` — the moment a fact this renderer needs
 * is absent: never a default, per Issue #387's rule that a brief states no
 * fact it did not actually derive.
 */
export function renderBrief(facts: BriefFacts, template: string): RenderResult {
  const missing: string[] = []

  if (facts.projects.length === 0) missing.push('Project (task has no Project(s) declared)')
  // Grandfathered the same as the Issue gate itself (`checkIssueObjectives`):
  // an Issue below `OBJECTIVES_SINCE_ISSUE` legitimately has no `## Objectives`
  // section, and the renderer must not newly refuse a class of Issue every
  // other consumer in this task already exempts.
  if (facts.objectives.length === 0 && facts.issue >= OBJECTIVES_SINCE_ISSUE) {
    missing.push('Objectives (Issue has no `## Objectives` section)')
  }
  // The four judgment sections (plan-brief-v1 task 1, Issue #426) are NOT
  // grandfathered by `BRIEF_SECTIONS_SINCE_ISSUE` here, unlike Objectives
  // above: a brief genuinely needs §4's Out of surface, §6's Parts, §9's
  // Test plan and §10's Stop conditions to render regardless of which Issue
  // number the gate itself would exempt — the cutover governs when the
  // ISSUE CREATION gate starts requiring the section, not whether a brief
  // can be rendered without one. The message names the cutover so a
  // pre-cutover Issue reads this as "add the section", not as a gate bug.
  const cutoverNote = `the Issue predates the \`## Surface\`/\`## Parts\`/\`## Test plan\`/\`## Stop conditions\` gate cutover at #${BRIEF_SECTIONS_SINCE_ISSUE}, but a brief still needs it to render`
  if (facts.surface.in.length === 0) {
    missing.push(`Surface (Issue has no \`## Surface\` section with a non-empty \`in:\` list — ${cutoverNote})`)
  }
  if (facts.parts.length === 0) {
    missing.push(`Parts (Issue has no \`## Parts\` section with well-formed Part lines — ${cutoverNote})`)
  }
  if (
    facts.testPlan.kind === 'commands' &&
    facts.testPlan.lines.length === 0 &&
    facts.testPlan.principal.length === 0
  ) {
    missing.push(`Test plan (Issue has no \`## Test plan\` section — ${cutoverNote})`)
  }
  if (facts.stopConditions.length === 0) {
    missing.push(`Stop conditions (Issue has no \`## Stop conditions\` section with bullet items — ${cutoverNote})`)
  }
  if (!facts.dispatchReady) missing.push(...facts.dispatchBlockers)

  for (const key of Object.keys(RATIONALE_FIELD_PATTERNS) as RationaleFieldKey[]) {
    if (!facts.rationale[key]) missing.push(RATIONALE_FIELD_NAMES[key])
  }

  // O2/O3 (task 12, Issue #469): the surface map lists only what `## Surface`
  // admits. When the Boundary named files but the Issue's own Surface admits
  // none of them, that is the Boundary and Surface genuinely disagreeing —
  // refuse at render (naming it) rather than dispatch a brief whose surface
  // map would be empty, or whose Modify list would argue with its own
  // Out-of-surface line.
  const filteredSurfaceFiles = admittedSurfaceFiles(facts.surfaceFiles, facts.surface)
  if (facts.surface.in.length > 0 && facts.surfaceFiles.length > 0 && filteredSurfaceFiles.length === 0) {
    missing.push(
      "Surface map (every file the Boundary named is excluded by the Issue's own `## Surface` `in:`/`out:` globs — Boundary and Surface disagree; fix the Issue rather than render an empty surface map)"
    )
  }

  if (missing.length > 0) return { ok: false, missing }

  const scopedFacts: BriefFacts = { ...facts, surfaceFiles: filteredSurfaceFiles }

  const section7Pointers = facts.docOwnersContent
    ? deriveSection7Pointers(
        filteredSurfaceFiles.map((f) => f.path),
        facts.docOwnersContent
      )
    : []

  const brief = [
    renderHeader(scopedFacts, template),
    '',
    ...(facts.objectives.length > 0 ? [renderObjectives(facts.objectives), ''] : []),
    renderSection2(facts),
    '',
    renderSection3(facts),
    '',
    renderSection4(scopedFacts),
    '',
    renderSection5(facts),
    '',
    renderSection6(scopedFacts),
    '',
    renderSection7(section7Pointers),
    '',
    renderSection8(),
    '',
    renderSection9(facts),
    '',
    renderSection10(facts),
    '',
    renderSection11(template, facts),
    '',
    renderSection12(facts)
  ].join('\n')

  return { ok: true, brief }
}

/** `deriveSection7`'s `pointers` alone — the only part of its result `renderSection7` needs. */
function deriveSection7Pointers(intendedSurfaces: string[], docOwnersContent: string): string[] {
  return deriveSection7(intendedSurfaces, docOwnersContent).pointers
}
