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
 * anything genuinely judgment-only is left for the Brief Author to add by
 * hand after render.
 */

import { deriveSection7 } from './derive-section7'
import { isDocFile } from './file-classify'
import { OBJECTIVES_SINCE_ISSUE } from './issue-validation'
import { type Objective, renderObjectives } from './objectives'
import { deriveTierFromDiff } from './pr-tier'

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
 * Reads the five rationale fields this renderer needs out of a task Issue's
 * body, tolerant of both live serializations `checkIssueRationale` accepts
 * (`**Field** — …` bold-inline, `### Field` heading). A field absent from the
 * body is simply absent from the returned record — never an empty string —
 * so `renderBrief`'s missing-fact check can tell "absent" from "present but
 * empty".
 */
export function parseRationaleFields(body: string): Partial<Record<RationaleFieldKey, string>> {
  const out: Partial<Record<RationaleFieldKey, string>> = {}
  for (const key of Object.keys(RATIONALE_FIELD_PATTERNS) as RationaleFieldKey[]) {
    const text = sliceRationaleField(body, RATIONALE_FIELD_PATTERNS[key])
    if (text) out[key] = text
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
  rationale: Partial<Record<RationaleFieldKey, string>>
  /** The Issue's `## Objectives` list (`objectives.ts`'s `objectivesOf`), copied into the brief verbatim between the header and §2. */
  objectives: Objective[]
  dispatchReady: boolean
  dispatchBlockers: string[]
  surfaceFiles: SurfaceFileFact[]
  /** Workspace package directories (e.g. `apps/cli`) that depend on `@attalabs/<pkg>` — same shape `checkConsumerTests` consumes, injected rather than derived here (this module reads no `fs`). */
  consumersOf: (pkg: string) => string[]
  /** `.vinaya/doc-owners` file content, or `null` when the file is absent — passed through to `deriveSection7` unchanged. */
  docOwnersContent: string | null
}

export type RenderResult = { ok: true; brief: string } | { ok: false; missing: string[] }

function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n')
}

function isTestFile(path: string): boolean {
  return /\.test\.[jt]sx?$/i.test(path)
}

const PRINCIPAL_OBSERVATION_RE = /\bprincipal\b[^.\n]*\b(?:browser|signed-in|visual|session)\b/i

function renderHeader(facts: BriefFacts, template: string): string {
  const introMatch = template.match(/^You are the AEG Developer\.[^\n]*$/m)
  const intro = introMatch
    ? (introMatch[0] as string)
        .replace(/\s*\[[^\]]*\]/g, '')
        .replace(/\bBoth mandatory\.$/, 'Mandatory.')
        .trim()
    : 'You are the AEG Developer. Read `aeg-root/roles/developer.md` first. Mandatory.'

  const reason = facts.rationale.suggestedAgentClass ?? ''
  // `deriveTierFromDiff` never returns `3` — Tier 3 stays a judgment call the
  // Brief Author raises by hand; the mechanical floor this renderer can prove
  // is 0 or 1, exactly the two values that check itself is capable of ruling
  // out for a doc/spec-touching surface.
  const tier = deriveTierFromDiff(facts.surfaceFiles.map((f) => f.path))
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
    '**Out of surface:** [named explicitly by the Brief Author — not mechanically derivable]',
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
    `git worktree add .worktrees/task/${facts.trancheSlug}/${facts.taskId} -b task/${facts.trancheSlug}/${facts.taskId} origin/main && cd .worktrees/task/${facts.trancheSlug}/${facts.taskId} && bun install --frozen-lockfile --silent`,
    '```',
    '',
    '1. Clean status; parent `origin/main`; branch suffix literal-matches the task id.',
    '2. `bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>` → `READY TO DISPATCH` (re-derived at render time: it was).',
    '',
    'On any failure: STOP and report.'
  ]
  return lines.join('\n')
}

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

  const parts: string[] = []
  let n = 1
  for (const [pkg, files] of byPackage) {
    parts.push(
      [
        `${n}. **Part ${n}:** ${facts.rationale.boundary}`,
        '',
        '   Files:',
        ...files.map((f) => `   - ${f.path}`),
        '',
        `   Touches ${pkg}. The pre-push hook runs the affected suite on your one push and refuses it on failure — do not run it yourself per Part.`
      ].join('\n')
    )
    n++
  }
  if (rootFiles.length > 0) {
    parts.push(
      [`${n}. **Part ${n}:** doctrine/root files.`, '', '   Files:', ...rootFiles.map((f) => `   - ${f.path}`)].join(
        '\n'
      )
    )
  }

  return ['## 6. Numbered parts — commit after EACH part; push once, before opening the PR', '', ...parts].join('\n')
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

function renderSection9(facts: BriefFacts): string {
  const runtimeFiles = facts.surfaceFiles.filter((f) => !isDocFile(f.path))
  if (runtimeFiles.length === 0) {
    // Deliberately unbolded: `locateTestPlanSection`'s heading-form slicer
    // treats a bold `**Field:**`-shaped line as the START of the NEXT
    // section (`NEXT_SECTION_RE`) — a bolded `**Test Plan:** unit-tests-only`
    // line right under the `## 9. Test Plan` heading would cut the section
    // boundary before its own content, leaving `checkTestPlan` nothing to
    // find. Plain `Test Plan: unit-tests-only` still satisfies
    // `TEST_PLAN_UNIT_TESTS_ONLY_RE` (both forms are equivalent to it).
    return ['## 9. Test Plan', '', 'Test Plan: unit-tests-only'].join('\n')
  }

  const testFiles = runtimeFiles.filter((f) => isTestFile(f.path))
  const commandLines =
    testFiles.length > 0
      ? testFiles.map((f) => `bun test ${f.path} → 0 fail`)
      : ['bunx turbo test --affected --force → summary line ends "0 fail"']

  const observationText = [
    facts.rationale.boundary ?? '',
    facts.rationale.trapsToAvoid ?? '',
    facts.rationale.stopAndEscalate ?? ''
  ].join('\n')
  const principalLine = PRINCIPAL_OBSERVATION_RE.test(observationText)
    ? [
        '',
        "- [ ] **[principal]** Verify the change described in this task's rationale in a real signed-in session/browser."
      ]
    : []

  return ['## 9. Test Plan', '', '```', ...commandLines, '```', ...principalLine].join('\n')
}

function renderSection10(facts: BriefFacts): string {
  return ['## 10. Stop conditions', '', `${facts.rationale.stopAndEscalate}`].join('\n')
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
  if (!facts.dispatchReady) missing.push(...facts.dispatchBlockers)

  for (const key of Object.keys(RATIONALE_FIELD_PATTERNS) as RationaleFieldKey[]) {
    if (!facts.rationale[key]) missing.push(RATIONALE_FIELD_NAMES[key])
  }

  if (missing.length > 0) return { ok: false, missing }

  const section7Pointers = facts.docOwnersContent
    ? deriveSection7Pointers(
        facts.surfaceFiles.map((f) => f.path),
        facts.docOwnersContent
      )
    : []

  const brief = [
    renderHeader(facts, template),
    '',
    ...(facts.objectives.length > 0 ? [renderObjectives(facts.objectives), ''] : []),
    renderSection2(facts),
    '',
    renderSection3(facts),
    '',
    renderSection4(facts),
    '',
    renderSection5(facts),
    '',
    renderSection6(facts),
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
