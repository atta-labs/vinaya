/**
 * Brief→Developer brief-validation grammar (aeg-governance-hardening
 * task 2). Pure — no `fs`, no `fetch`, no `process.env`. The CLI shim
 * (`bin/verify-brief.ts`) reads `PR_BODY`, then
 * calls `checkBriefSections`.
 *
 * Scope is presence-only (per the Planner's trap): this gate cannot judge
 * whether a Test Plan item is truly scriptable, whether `unit-tests-only` is
 * justified by the surface map, or whether a doc-update entry is factually
 * correct — those remain Reviewer + Verification judgment. It only confirms each
 * required brief section exists in the PR body, in the shape the
 * `brief-authoring` skill and `brief-developer` contract define.
 */

import { type AnchorField, anchoredRegion, stripCode } from './anchored-region'
import { type Objective, objectivesVersion, objectivesOf } from './objectives'
import { parsePremiseBlock, premiseBlockText } from './premise-check'
import { locateTestPlanSection } from './test-plan-section'

export type BriefSectionResult = { status: 'pass' | 'fail'; errors: string[] }

/**
 * The PR body's header block: everything before the first h2+ heading. The
 * canonical PR-body form (`roles/developer.md`) puts the metadata fields
 * (Tier, For, Project, Closes) at the top, before `## Summary`.
 * Anchoring field extraction here — shared with `archive-task.ts` — is what
 * stops prose in later sections that merely *mentions* a field name (e.g. a
 * "Decisions made" paragraph discussing the `Ticket:` field) from being
 * parsed as the field itself. Regression from #311's first live archivist
 * run, where exactly that happened.
 */
export function headerRegion(prBody: string): string {
  const m = prBody.match(/^##\s/m)
  return m?.index !== undefined ? prBody.slice(0, m.index) : prBody
}

/**
 * Tolerant header-field reader: accepts `Field: value` and `**Field:** value`,
 * line-anchored, searched only in the header region. Stops at line end or a
 * `·` metadata separator.
 *
 * When `anchor` is given and the body carries that anchor pair
 * (`anchored-region.ts`, task 30), the pair replaces the header region as the
 * one place the field is read from — a field-shaped line anywhere else in the
 * body is ignored. Bodies without the pair parse exactly as before.
 */
function headerField(prBody: string, labelPattern: string, anchor?: AnchorField): string | null {
  const anchored = anchor !== undefined ? anchoredRegion(prBody, anchor) : null
  const region = anchored ?? headerRegion(prBody)
  const re = new RegExp(`^(?:\\*\\*)?\\s*${labelPattern}\\s*(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*([^\\n·]+)`, 'im')
  const m = region.match(re)
  if (!m) return null
  const value = (m[1] as string).trim()
  return value.length > 0 ? value : null
}

/** Strips markdown emphasis markers and collapses whitespace, for tolerant phrase matching. */
function normalize(text: string): string {
  return text.replace(/[*_]/g, '').replace(/\s+/g, ' ')
}

function headingCheck(prBody: string, keywordPattern: string, sectionName: string): BriefSectionResult {
  const re = new RegExp(`^#{1,4}\\s*(?:\\*\\*)?(?:\\d+[a-z]?\\.\\s*)?[^\\n]*${keywordPattern}`, 'im')
  if (re.test(prBody)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [`brief-validation ${sectionName}: no "${sectionName}" section found in the PR body.`]
  }
}

/** Tier field — reuses the canonical `@attalabs/aeg-core` parser (do not re-implement). */
export function checkTierField(prBody: string, readTier: (body: string) => 0 | 1 | 3 | null): BriefSectionResult {
  if (readTier(prBody) !== null) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation tier: no `Tier:` field found in the PR body (expected `Tier: 0|1|3` or `**Tier:** 0|1|3`).'
    ]
  }
}

/**
 * The `unit-tests-only` sentinel, tolerating the markdown emphasis every other
 * brief field carries (`**Tier:**`, `**Project:**`, …). All three of
 * `Test Plan: unit-tests-only`, `**Test Plan:** unit-tests-only` and
 * `**Test Plan**: unit-tests-only` match.
 *
 * The bold forms used to fail: the pattern was `/Test Plan\s*:\s*unit-tests-only/i`,
 * and `\s*` cannot cross the `**` sitting between the colon and the value — so
 * `brief-authoring/SKILL.md` §9's own canonical example (`**Test Plan:** unit-tests-only`)
 * was rejected by the gate that documents it, and any brief copying the skill
 * verbatim bounced. Two checks read this sentinel and both were wrong in
 * different directions: `checkTestPlan` false-FAILED a well-formed brief, while
 * `checkTestPlanExclusivity` silently false-PASSED a self-contradictory one (a
 * bolded `unit-tests-only` **plus** tagged checkboxes never tripped it, because
 * its own guard clause never matched either) — the exact combination that guard
 * was built for in #340. Fixing the doc instead of the pattern was rejected:
 * bold is the house convention for brief fields, so an unbolded Test Plan is the
 * odd one out and drifts back the moment someone tidies it.
 */
const TEST_PLAN_UNIT_TESTS_ONLY_RE = /(?:\*\*)?Test Plan(?:\*\*)?\s*:\s*(?:\*\*)?\s*unit-tests-only/i

/**
 * The Test Plan section text these three checks scan — never the raw body.
 * Delegates to `locateTestPlanSection` (the same locator `test-plan.ts`'s
 * merge-gate check uses) so an `AEG:TEST-PLAN` anchor pair is authoritative
 * here exactly as it already is there. Without this, a body that anchors its
 * real Test Plan AND carries a pasted verbatim reference copy of the brief
 * (the template's own instruction) has its checkbox lines double-counted:
 * `checkTestPlanExclusivity`/`checkPrincipalPlaceholder` scanned the whole
 * body and fired on checkboxes living only in the quoted reference copy,
 * disagreeing with `test-plan.ts` about which bytes are the real field
 * (found live: a well-formed anchored brief failed `brief-shape` while
 * `test-plan` passed the same body). Falls back to the full body when no
 * section is locatable, matching every other anchor consumer's "anchors are
 * additive, never required" contract.
 */
function testPlanRegion(prBody: string): string {
  const located = locateTestPlanSection(prBody)
  return located.found ? located.section : prBody
}

/**
 * Test Plan — pass iff the body contains the `Test Plan: unit-tests-only`
 * sentinel (bolded or not — see `TEST_PLAN_UNIT_TESTS_ONLY_RE`), OR at least one
 * `**[agent]**`/`**[principal]**`-tagged checklist line. Presence-only: does not
 * judge whether tags are correctly assigned or whether `unit-tests-only` is
 * justified by the surface map.
 */
/**
 * Presence-only Test Plan detector — three acceptable shapes since task 12
 * (#387) rendered the `[agent]` half of a Test Plan as a fenced command list
 * rather than a checkbox: the `unit-tests-only` sentinel; a
 * `**[agent]**`/`**[principal]**`-tagged checkbox line (the pre-#387 shape,
 * still valid on a PR below `AGENT_BOXES_REFUSED_SINCE_PR` and for
 * `[principal]` items on every PR); or a fenced code block anywhere in the
 * Test Plan region (the fenced-command-list shape). This gate does not judge
 * WHICH shape a given PR number must use — `checkNoAgentBoxes`, below, is the
 * rule that refuses a checkbox `[agent]` item on a PR at or above the rollout
 * constant; this one only asks "is there a Test Plan at all."
 */
export function checkTestPlan(prBody: string): BriefSectionResult {
  const located = locateTestPlanSection(prBody)
  const region = located.found ? located.section : prBody
  if (TEST_PLAN_UNIT_TESTS_ONLY_RE.test(region)) return { status: 'pass', errors: [] }
  if (/\*\*\[(?:agent|principal)\]\*\*/.test(region)) return { status: 'pass', errors: [] }
  // Fenced-block detection only counts when the section was genuinely
  // LOCATED, never on the whole-body fallback: `testPlanRegion`'s fallback
  // exists so the sentinel/tag checks above still work on a body with no
  // recognizable heading, but a fence can appear anywhere in a brief (Step
  // 0's own worktree command, a Part's own command block) — trusting ANY
  // fence in the whole body would pass a brief whose Test Plan section was
  // deleted outright, as long as it kept some unrelated fence elsewhere
  // (found live, fixing this same rule: `checkBriefSections`'s own "missing
  // Test Plan" regression fixture stopped failing until this guard landed).
  if (located.found && extractFencedBlocks(region).length > 0) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation Test Plan: no Test Plan section found — expected `Test Plan: unit-tests-only`, a fenced `[agent]` command list, or at least one `**[agent]**`/`**[principal]**`-tagged checklist item.'
    ]
  }
}

/**
 * Test Plan shape guard (aeg-governance-hardening task 20 follow-up, #340) —
 * `Test Plan: unit-tests-only` and a tagged checkbox item are mutually
 * exclusive per brief-authoring §9 ("The two fields are coupled; Brief
 * Validation cross-checks them"): `unit-tests-only` declares there is no
 * checklist because there is nothing runtime to check off, so a body
 * carrying both is self-contradictory. Regression source: PR #363's own
 * original brief declared `unit-tests-only` while its Test Plan also listed
 * `- [x]`/`- [ ]` `[agent]`/`[principal]` items — a combination this gate
 * previously let through.
 */
export function checkTestPlanExclusivity(prBody: string): BriefSectionResult {
  const region = testPlanRegion(prBody)
  if (!TEST_PLAN_UNIT_TESTS_ONLY_RE.test(region)) return { status: 'pass', errors: [] }
  if (/^-\s*\[[ xX]\]\s*\*{2}\[(?:agent|principal)\]\*{2}/im.test(region)) {
    return {
      status: 'fail',
      errors: [
        'brief-validation Test Plan shape: `Test Plan: unit-tests-only` and a `- [ ]`/`- [x]` tagged checkbox item are mutually exclusive (brief-authoring §9) — declare one form, not both.'
      ]
    }
  }
  return { status: 'pass', errors: [] }
}

/**
 * Principal-placeholder guard (aeg-governance-hardening task 20 follow-up,
 * #340) — a `**[principal]**` checkbox item whose content is a
 * none-placeholder ("None — …") is untickable by construction: nobody can
 * check a box asserting there is nothing to verify, so it blocks the merge
 * gate forever. If a brief genuinely has no principal-runnable surface, the
 * item must be omitted entirely, not declared and left permanently unticked.
 */
export function checkPrincipalPlaceholder(prBody: string): BriefSectionResult {
  const region = testPlanRegion(prBody)
  const lineRe = /^-\s*\[[ xX]\]\s*\*{2}\[principal\]\*{2}(.*)$/gim
  for (const m of region.matchAll(lineRe)) {
    const content = m[1] ?? ''
    if (/^\s*None\b/i.test(content)) {
      return {
        status: 'fail',
        errors: [
          'brief-validation Test Plan shape: a `**[principal]**` checkbox item is a "None" placeholder — if there is no principal-runnable surface, omit the item entirely; an untickable placeholder box blocks the merge gate forever.'
        ]
      }
    }
  }
  return { status: 'pass', errors: [] }
}

/**
 * Premise coverage (this task, aeg-governance-hardening 11, #324) — pass iff
 * either (a) at least one `Premise:` assertion's path matches a file in
 * `surfaceFiles` (the §4 surface map's file list — in practice, the PR's
 * actual changed-file list, the same diff-derived-truth philosophy
 * `deriveTierFromDiff` already uses), or (b) `surfaceFiles` is empty (a
 * Tier 0 brief with zero runtime/code surface has nothing to pin — mirrors
 * `checkTestPlan`'s `unit-tests-only` exemption). Presence-only: does not
 * judge whether the pinned premise is the *right* one to have pinned.
 */
export function checkPremiseCoverage(prBody: string, surfaceFiles: string[]): BriefSectionResult {
  if (surfaceFiles.length === 0) return { status: 'pass', errors: [] }
  const assertions = parsePremiseBlock(prBody)
  if (assertions.some((a) => surfaceFiles.includes(a.path))) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation Premise: no `Premise:` assertion found whose path matches a file in the surface map — a brief with a real code surface must pin at least one premise (aeg-governance-hardening task 11).'
    ]
  }
}

export function checkSurfaceMap(prBody: string): BriefSectionResult {
  return headingCheck(prBody, '(?:technical\\s+)?surface map', 'Technical surface map')
}

export function checkDocUpdateList(prBody: string): BriefSectionResult {
  return headingCheck(prBody, '(?:documentation|doc)[- ]update(?:\\s+list)?', 'Documentation-update list')
}

export function checkWorktreeStep0(prBody: string): BriefSectionResult {
  if (/git worktree add/.test(prBody)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: ['brief-validation worktree Step 0: no `git worktree add` command found in the PR body.']
  }
}

export function checkStopConditions(prBody: string): BriefSectionResult {
  return headingCheck(prBody, 'stop conditions', 'Stop conditions')
}

/**
 * Autonomy clause — matches the standing clause's core phrase, case-insensitively,
 * tolerant of whitespace and emphasis markup (`**Autonomy:**` vs `Autonomy:`).
 * Per the Planner's trap, this is deliberately verbatim-ish rather than a loose
 * "mentions autonomy somewhere" match — the phrase is the actual invariant.
 */
export function checkAutonomyClause(prBody: string): BriefSectionResult {
  const normalized = normalize(prBody).toLowerCase()
  if (/do not stop to ask clarifying questions/.test(normalized)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation autonomy clause: the standing autonomy clause ("Do not stop to ask clarifying questions...") was not found in the PR body.'
    ]
  }
}

/**
 * Project field — required in a multi-project repo (`brief-authoring` skill,
 * `planner-brief` contract: the field routes the Developer to the right specs
 * and tells the Reviewer whose behavior to verify). Must appear in the header
 * block, where the Archivist's provenance assembly also reads it — gate and
 * archivist share `headerRegion`, so a body that passes this gate can never
 * produce a DANGLING Project field in provenance. Added after #311 merged
 * without it: the Developer satisfied exactly the sections this gate checked
 * and dropped everything it didn't — whatever the gate doesn't enforce, agents
 * will eventually omit (contract-gate parity is the fix, not discipline).
 */
export function checkProjectField(prBody: string): BriefSectionResult {
  if (headerField(prBody, 'Project(?:\\(s\\))?', 'PROJECT') !== null) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation Project: no `Project:` field found in the PR body header block (before the first `##` heading). Required per the brief-developer contract — expected `Project: <name>[, <name>]` or `**Project:** …`.'
    ]
  }
}

/**
 * For/model field — the brief's mandatory `For:` header (`brief-authoring`
 * skill: "the `For:` + `Reason:` lines are mandatory"). AEG forbids
 * commit-trailer attribution, so this line is the provenance block's only
 * source for Model/agent — same headerRegion parity rationale as
 * `checkProjectField`.
 */
export function checkForField(prBody: string): BriefSectionResult {
  if (headerField(prBody, 'For') !== null) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation For: no `For:` field found in the PR body header block (before the first `##` heading). Required per the brief-authoring skill — expected `For: <model + environment>` or `**For:** …`.'
    ]
  }
}

/**
 * `Closes #N` gate — the match runs on **code-stripped** body text (fenced
 * blocks + inline spans removed via `stripCode`), so it agrees byte-for-byte
 * with GitHub's own auto-close parser, which also ignores `Closes #N` inside
 * code. Without the strip, a body whose only closing reference is backticked
 * (`` `Closes #600` ``) passed this gate green yet merged **without** closing
 * its Issue — stranding #600 (PR #608) and #601 (PR #611) and reddening every
 * open PR via the A3 `auto-close-misfire` oracle. "verify-docs green" must
 * imply "GitHub will auto-close"; stripping code here is what makes it so.
 *
 * The separator groups are **bounded** (`\s{0,8}`, not `\s*`). Two adjacent
 * unbounded `\s*` around an optional `:` backtrack quadratically on a body of
 * the shape `closes` + long whitespace + no `#` — ~2.65 s at GitHub's
 * 65,536-char body cap, and this function runs the pattern twice on the fail
 * path (PR #617 security pass). A constant bound makes the work per start
 * position constant, so the scan is linear in body length. Eight is far past
 * any real separator; a body needing more is malformed by the brief's own
 * convention (a bare ref inside the `AEG:CLOSES` anchor) and fails with an
 * actionable message rather than silently stranding its Issue.
 */
export function checkClosesN(prBody: string): BriefSectionResult {
  const closesPattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s{0,8}:?\s{0,8}#\d+/i
  if (closesPattern.test(stripCode(prBody))) {
    return { status: 'pass', errors: [] }
  }
  // Distinguish "only inside code" (actionable — move it out) from "absent entirely".
  if (closesPattern.test(prBody)) {
    return {
      status: 'fail',
      errors: [
        "brief-validation Closes #N: `Closes #N` found only inside a code span — GitHub won't auto-close it. Put a bare `Closes #N` on its own line inside the `AEG:CLOSES` anchor."
      ]
    }
  }
  return {
    status: 'fail',
    errors: ['brief-validation Closes #N: no `Closes #<N>` (or Fixes/Resolves) reference found in the PR body.']
  }
}

/**
 * The commit-type vocabulary this repo enforces — the commitlint type set
 * plus `Plan` (plan PRs; deliberately excluded from the separate
 * `vinaya/type:*` label axis, since a commit type and a task type are
 * different things — see `packages/aeg-forge-state/src/labels.ts`). The one
 * list: `COMMIT_TYPE_STYLE` below is derived from it, and the `commit-msg`
 * hook (`apps/cli/src/commands/commit-msg.ts`) reads `COMMIT_TYPES` for its
 * own error text — neither carries a second, independently-typed copy.
 */
export const COMMIT_TYPES = [
  'Build',
  'Chore',
  'Docs',
  'Feat',
  'Fix',
  'Perf',
  'Plan',
  'Refactor',
  'Revert',
  'Style',
  'Test'
] as const

export const COMMIT_TYPE_STYLE = new RegExp(`^(${COMMIT_TYPES.join('|')})(\\([a-z0-9-]+\\))?: \\S`)

/**
 * Forge-title grammar — the two title forms this repo actually uses:
 *   1. Commit-style: `Type: description` or `Type(scope): description`, with
 *      the commitlint type set plus `Plan` (plan PRs).
 *   2. Task-style: `[tranche] id — description` (task Issues and task PRs).
 * Anything else is refused: titles ride into merge commits and the forge's
 * derived views, so they carry the same grammar obligation as commit messages
 * (husky/commitlint parity, applied at the wrapper).
 */
export function checkForgeTitle(title: string): BriefSectionResult {
  const taskStyle = /^\[[a-z0-9._-]+\] \S+ — \S/
  if (COMMIT_TYPE_STYLE.test(title) || taskStyle.test(title)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      `brief-validation title: "${title}" matches neither title grammar — expected \`Type: description\` / \`Type(scope): description\` (commitlint types + Plan) or \`[tranche] id — description\` (task form).`
    ]
  }
}

/**
 * Plan-PR Closes guard — a `plan/*` PR body must never carry a
 * `Closes #N` reference. Three confirmed live incidents (#294→#293,
 * #298→#297, #288→#287) show a plan PR's `Closes #N` prematurely closing
 * the task Issue when the *plan* merged — before the task itself ever ran.
 * `roles/planner.md`'s Plan-PR close-out section already forbids this in
 * prose ("a plan PR creates Issues; it does not resolve one"); this is the
 * mechanical gate. Separate from `checkBriefSections` (it needs the branch,
 * not just the body, and it's a guard against a forbidden shape, not a
 * presence check) — the shim runs it before the non-task-branch bypass, since
 * a `plan/*` branch would otherwise never reach a brief-shape check at all.
 * Plan branches without `Closes` continue to bypass, as today.
 */
export function checkPlanPrNoCloses(branch: string, prBody: string): BriefSectionResult {
  if (!branch.startsWith('plan/')) return { status: 'pass', errors: [] }
  if (!/\bcloses\s+#\d+/i.test(prBody)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation plan-PR guard: a `plan/*` PR must not carry `Closes #N` — a plan PR creates Issues, it does not resolve one (roles/planner.md). Remove the `Closes #N` reference; the task Issue closes from the task PR that does the work.'
    ]
  }
}

/**
 * The four markers that make a body *a brief* rather than an ordinary PR
 * description. Each is an existing section detector, reused unchanged — so a
 * body that trips this detector is, by construction, a body the section checks
 * were written to grade.
 *
 * Test Plan is deliberately **not** a marker even though it is a required brief
 * section: the canonical PR-body template gives every AEG PR a Test plan with
 * `**[agent]**` tags, so it is the one section an ordinary non-brief PR
 * plausibly carries. The four kept here are brief grammar and nothing else — a
 * dependency bump has none of them, and needing *two* means one stray phrase
 * can never force a brief onto a PR that was never meant to carry one.
 */
const BRIEF_SHAPE_MARKERS = [checkSurfaceMap, checkDocUpdateList, checkStopConditions, checkAutonomyClause] as const

/**
 * A task branch, per the topology naming convention (`task/<tranche>/<n>`).
 * The one shared copy — `bin/verify-brief.ts`, `test-plan-gate.ts`, and
 * `archive-task.ts` each still define this pattern locally (out of this
 * export's blast radius; not deduped onto it here), but a new consumer
 * (`check-brief-shape.ts`, #870) reuses this one rather than adding a
 * fourth copy.
 */
const TASK_BRANCH_PATTERN = /^task\/[^/]+\/[^/]+$/

export function isTaskBranch(branch: string): boolean {
  return TASK_BRANCH_PATTERN.test(branch)
}

/**
 * Is this PR body a brief? — the predicate that replaces the branch name as
 * `verify-brief`'s trigger for running `checkBriefSections`.
 *
 * The old rule was "validate iff the branch is `task/<tranche>/<n>`", which meant a
 * standalone `fix/*` brief bypassed **every** section check. Confirmed live: a
 * fix brief on `fix/studio-tranche-href` shipped with no §7
 * documentation-update list, and `checkDocUpdateList` — the checker that exists
 * for exactly that — never ran, because the branch wasn't a task branch. The
 * exemption still has to exist (an ordinary one-line dependency-bump PR has no
 * brief and must not be forced to grow one), so the rule becomes: *if a body is
 * a brief, it must be a complete brief, whatever the branch is called.*
 *
 * Detection runs on `stripCode(prBody)` (the single shared stripper from
 * `anchored-region`, per #617's "one stripper, never a duplicated regex"). A PR
 * that *quotes* a brief inside a fence — "here's a sample brief: ``` …Technical
 * surface map… ```" — is discussing a brief, not carrying one, and must stay
 * exempt; matching on raw text would force-validate it. Note this also rules out
 * the worktree `git worktree add … -b` line as a marker: Step 0 lives inside a
 * fence in every real brief, so it never survives the strip.
 *
 * Threshold is ≥2 of four rather than any-one so that a brief missing one
 * section is still detected as a brief — the failure mode this gate exists to
 * catch. The `fix/studio-tranche-href` body trips three with §7 absent.
 */
export function isBriefShaped(prBody: string): boolean {
  const stripped = stripCode(prBody)
  return BRIEF_SHAPE_MARKERS.filter((check) => check(stripped).status === 'pass').length >= 2
}

/**
 * The branch a brief declares for itself, read from its Step 0 command. At
 * authoring time there is no `BRANCH` env var and no branch yet — but every
 * brief carries `git worktree add <path> -b <branch> origin/main`, so the brief
 * states what it is going to be, and `verify-brief --body-file` can grade it as
 * that. Matched on the RAW body, not `stripCode`'s output: Step 0 lives inside a
 * fence in every real brief, so the stripped text never contains it.
 */
export function inferBranchFromBody(prBody: string): string {
  const m = prBody.match(/git worktree add\s+\S+\s+-b\s+(\S+)/)
  return m?.[1] ?? ''
}

/**
 * The shell-command-word vocabulary this task's two prose-shape rules share
 * (`checkCommandsCarryOutput` and `doctrine-no-procedures.ts`'s sweep) — one
 * list, so the two rules can never silently diverge on what counts as "a
 * command". Exported for that reuse, not for callers to extend at runtime.
 */
export const COMMAND_WORDS = ['export', 'bun', 'gh', 'git', 'grep', 'sed', 'cat', 'diff', 'vinaya'] as const

/**
 * Rollout PR number for the four brief-shape rules this task added
 * (`checkNoUnpinnedCodeClaims`, `checkCommandsCarryOutput`,
 * `checkConsumerTests`, `checkDefeatCases`). A PR numbered below this is
 * grandfathered: the CI shim (`check-brief-shape.ts`) reports a finding from
 * one of these four rules as informational, never a failure. A PR at or
 * above it is held to the rule for real. `verify-brief.ts` (authoring time,
 * pre-dispatch) has no PR number and applies all four unconditionally —
 * grandfathering is a CI-only rollout concern, not a grammar relaxation
 * (round-2 ruling addendum 1).
 */
export const BRIEF_RULES_SINCE_PR = 394

/**
 * Rollout PR number for `checkNoAgentBoxes`, below — a second, distinct
 * cutover from `BRIEF_RULES_SINCE_PR` above, per the Principal's ruling
 * (2026-09-03, after PR #395): an agent never ticks a box or edits a PR
 * body, so the `[agent]` half of a Test Plan stops being checkboxes and
 * becomes a fenced command list (task 12, #387). A PR numbered below this
 * is grandfathered — its checkbox `[agent]` items were written before the
 * ruling and are reported informationally, never a failure. `verify-brief.ts`
 * (authoring time, pre-dispatch) has no PR number and applies the rule
 * unconditionally, same grandfathering-is-CI-only posture as
 * `BRIEF_RULES_SINCE_PR`.
 */
export const AGENT_BOXES_REFUSED_SINCE_PR = 396

const AGENT_BOX_LINE_RE = /^-\s*\[[ xX]\]\s*\*{2}\[agent\]\*{2}/im

/**
 * Refuses a Test Plan whose `[agent]` half is still a checkbox item — the
 * shape the fenced-command-list rule (task 12, #387) replaces. Presence-only
 * within the Test Plan region (`testPlanRegion`), like every sibling check
 * in this file: whether the fenced list a body carries instead is any GOOD
 * is a Reviewer/Verification judgment, not this gate's.
 */
export function checkNoAgentBoxes(prBody: string): BriefSectionResult {
  const region = testPlanRegion(prBody)
  if (!AGENT_BOX_LINE_RE.test(region)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'brief-validation no agent boxes: the Test Plan carries a checkbox `[agent]` item — an agent never ticks a box or edits a PR body (Principal ruling, 2026-09-03, after PR #395). Render the `[agent]` half as a fenced command list instead; `vinaya pr report` runs each command from the PR head and writes its actual output into the AEG:EVIDENCE block. `[principal]` checkboxes are unaffected.'
    ]
  }
}

/**
 * True for an error message produced by one of the five grandfatherable
 * rules below (the original four, plus `checkNoAgentBoxes`) — classified by
 * each rule's own distinct message prefix, since `checkBriefSections`
 * aggregates every sub-check's errors into one flat `string[]` and this is
 * the only reader that ever needs to tell them apart from the rest.
 */
export function isGrandfatherableBriefRuleError(message: string): boolean {
  return rolloutThresholdFor(message) !== null
}

/**
 * The rollout constant a given error message is grandfathered against, or
 * `null` for a message this rollout scheme does not cover (always blocking,
 * on every PR). Two thresholds exist today (`BRIEF_RULES_SINCE_PR`,
 * `AGENT_BOXES_REFUSED_SINCE_PR`) — a message is matched to whichever rule
 * produced it, never a single global cutover, so a later third threshold
 * can be added here without touching either existing one's grandfather
 * window.
 */
function rolloutThresholdFor(message: string): number | null {
  if (
    message.startsWith('brief-validation unpinned code claim:') ||
    message.startsWith('brief-validation commands carry output:') ||
    message.startsWith('brief-validation consumer tests:') ||
    message.startsWith('brief-validation defeat cases:')
  ) {
    return BRIEF_RULES_SINCE_PR
  }
  if (message.startsWith('brief-validation no agent boxes:')) return AGENT_BOXES_REFUSED_SINCE_PR
  return null
}

/**
 * Splits `checkBriefSections`'s flat error list into `blocking` (fails the
 * check) and `info` (printed, never a failure) — the CI shim
 * (`check-brief-shape.ts`) is the only caller, but the split is a pure
 * function of `(errors, prNumber)` so it is unit-testable directly.
 *
 * `prNumber === null` (no `PR_NUMBER`, or an unparseable one) is NOT
 * grandfathered — only a real, parsed number below a message's own
 * threshold (`rolloutThresholdFor`) is. Fail-closed: a check that can't tell
 * which PR it's grading must not quietly waive rules it has no number to
 * check against.
 */
export function partitionBriefErrorsByRollout(
  errors: string[],
  prNumber: number | null
): { blocking: string[]; info: string[] } {
  const blocking: string[] = []
  const info: string[] = []
  for (const e of errors) {
    const threshold = rolloutThresholdFor(e)
    const grandfathered = threshold !== null && prNumber !== null && prNumber < threshold
    ;(grandfathered ? info : blocking).push(e)
  }
  return { blocking, info }
}

/**
 * One fenced block's raw span, content, and language tag — `start`/`end` are
 * char offsets into the original text. `lang` is the fence's info-string,
 * lowercased and trimmed to its first word (` ```ts ` → `'ts'`, ` ``` ` →
 * `''`) — `doctrine-no-procedures.ts` uses it to exempt a non-shell block
 * (e.g. a TypeScript illustration whose two `export` lines are not a
 * command sequence, task 10 round-2 ruling item 2).
 */
export type FencedBlock = { start: number; end: number; lang: string; content: string }

/**
 * Every fenced (``` or ~~~) code block in `text`, in document order, with its
 * raw content, language tag, and char-offset span. Tolerant of the 3-space
 * list-item indentation every brief's own numbered steps use (`   \`\`\``) —
 * the fence marker need not sit at column 0. Not a full CommonMark
 * implementation (no nested-fence-length edge cases beyond "the closer
 * repeats the opener's exact run"), which this repo's own doctrine/brief
 * prose never exercises.
 *
 * Shared by `checkCommandsCarryOutput` (below) and `doctrine-no-procedures.ts`
 * — one fence scanner, never a second copy of this pattern.
 */
export function extractFencedBlocks(text: string): FencedBlock[] {
  const re = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm
  const blocks: FencedBlock[] = []
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    const lang = (m[2] as string).trim().toLowerCase().split(/\s+/)[0] ?? ''
    blocks.push({ start: m.index, end: m.index + m[0].length, lang, content: m[3] as string })
    m = re.exec(text)
  }
  return blocks
}

function firstNonBlankLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)
  return line?.trim() ?? ''
}

/**
 * A file-and-line reference — `<path>.<ext>:<digits>` — the shape a brief
 * states a code fact by pointer instead of by an executed command or a
 * `Premise:` pin. Extension list is this repo's own doctrine/code file kinds;
 * deliberately not "any word after a dot" (that would also catch a semver
 * string or a decimal figure with a trailing count).
 */
const FILE_LINE_RE = /\b[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|md|mdx|json|ya?ml|sh|py|toml):\d+\b/g

/**
 * Rule (i) (task 10, Issue #385) — a brief states no code fact as a bare
 * `file:line` prose pointer; it either pins the fact in `Premise:` (re-
 * asserted at dispatch, `verify-dispatch --premise`) or shows the executed
 * command whose output names the line. A pointer that survives outside both
 * homes is a claim nobody re-checks — exactly the class task 9's rule
 * forbids in prose (PR #382's `security-archivist.md:88` mention, backticked
 * but never pinned nor shown as command output).
 *
 * Scans `stripCode(…, { inlineSpans: 'keep' })`: fenced/indented **blocks**
 * are removed (a worked example's own line numbers are not a live claim),
 * but a single-backtick inline span is left as literal text — the PR #382
 * sentence was exactly an inline span, and this rule must still catch it.
 * This is why `maskCode` (which blanks inline spans too) is the wrong tool
 * here, unlike `checkClosesN`/`isBriefShaped` elsewhere in this file.
 */
export function checkNoUnpinnedCodeClaims(prBody: string): BriefSectionResult {
  const premiseText = premiseBlockText(prBody)
  const withoutPremise = premiseText ? prBody.replace(premiseText, '') : prBody
  const scanned = stripCode(withoutPremise, { inlineSpans: 'keep' })
  const matches = scanned.match(FILE_LINE_RE) ?? []
  if (matches.length === 0) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: matches.map(
      (m) =>
        `brief-validation unpinned code claim: "${m}" states a code fact by file-and-line reference outside a \`Premise:\` pin and outside a fenced code block — pin it in \`Premise:\`, or show the executed command and its output instead.`
    )
  }
}

/**
 * Section `num`'s own text (the heading line's content, ending at the next
 * heading of any level 1-4) — `§4`/`§5`/`§6` share this numbered-heading
 * shape with `headingCheck`'s keyword form, so this mirrors that pattern
 * rather than inventing a second heading grammar. `null` when no such
 * section exists (the composer's other checks already judge whether a
 * required section is missing; these two rules apply only when it is
 * present).
 */
function extractNumberedSection(prBody: string, num: number): string | null {
  const startRe = new RegExp(`^#{1,4}\\s*(?:\\*\\*)?${num}[a-z]?\\.\\s`, 'im')
  const start = startRe.exec(prBody)
  if (!start) return null
  const afterStart = start.index + start[0].length
  const rest = prBody.slice(afterStart)
  const next = /^#{1,4}\s/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

function commandWordOf(line: string): string {
  return line.trim().split(/\s+/)[0] ?? ''
}

function isCommandBlock(content: string): boolean {
  return (COMMAND_WORDS as readonly string[]).includes(commandWordOf(firstNonBlankLine(content)))
}

/** The Step 0 exemption — `git worktree add …` is a command with no separate output block by convention. */
function isStep0Block(content: string): boolean {
  return firstNonBlankLine(content).startsWith('git worktree add')
}

/**
 * Rule (ii) (task 10, Issue #385; tightened by the round-2 ruling item 1) —
 * in a brief's `§5` (Pre-flight checks) or `§6` (Numbered parts), a fenced
 * block that opens with a shell command must be immediately followed by
 * another fenced block that does NOT itself open with a shell command — its
 * output. The Step `0` `git worktree add` block is exempt: it is a setup
 * command with no output to show, by the convention every brief's own
 * pre-flight step already follows.
 *
 * **The immediately-following fence, never merely "a later one".** The first
 * cut of this rule accepted `blocks[i + 1]` existing at all, which let three
 * undocumented command blocks in a row pass as long as a single trailing
 * output fence sat after the last of them — each of the first two command
 * blocks' own "next fence" was itself another un-followed command, and the
 * rule never noticed (round-2 ruling, found live reviewing this PR's own
 * diff). A command block's output claim is only satisfied by the very next
 * fence, and only if that fence is not itself a command.
 *
 * Deliberately loose about what sits *between* the two fences (the prose
 * separating them, never counted) — this brief's own pre-flight steps
 * (`§5` items 4-9) interleave a sentence of prose between a command fence
 * and its output fence ("Output the Planner obtained at authoring
 * time…"), and the rule must not fail the brief that documents it.
 */
export function checkCommandsCarryOutput(prBody: string): BriefSectionResult {
  const errors: string[] = []
  for (const [label, num] of [
    ['5', 5],
    ['6', 6]
  ] as const) {
    const section = extractNumberedSection(prBody, num)
    if (!section) continue
    const blocks = extractFencedBlocks(section)
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as FencedBlock
      if (isStep0Block(block.content) || !isCommandBlock(block.content)) continue
      const next = blocks[i + 1]
      if (!next || isCommandBlock(next.content)) {
        errors.push(
          `brief-validation commands carry output: §${label} has a command block ("${firstNonBlankLine(block.content)}") not immediately followed by a non-command output block — the very next fenced block must hold that command's actual output, not another command.`
        )
      }
    }
  }
  return errors.length === 0 ? { status: 'pass', errors: [] } : { status: 'fail', errors }
}

const CONSUMER_TESTS_SENTINEL_RE = /consumer-tests\s*:\s*none\s*[-—–]\s*\S/i

/** Every distinct `packages/<pkg>/` reference in `text` — the packages a §4 surface map names. */
function packagesNamedIn(text: string): string[] {
  const re = /\bpackages\/([A-Za-z0-9_-]+)\//g
  const pkgs = new Set<string>()
  let m: RegExpExecArray | null = re.exec(text)
  while (m !== null) {
    pkgs.add(m[1] as string)
    m = re.exec(text)
  }
  return [...pkgs]
}

/** Whether `text` names a test-shaped path (`*.test.<ext>`) under workspace directory `consumerDir` (e.g. `apps/cli`, `packages/sources`). */
function hasTestPathForConsumer(text: string, consumerDir: string): boolean {
  const escaped = consumerDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\/[\\w./-]*\\.test\\.[A-Za-z0-9]+`)
  return re.test(text)
}

/**
 * Rule (iii) (task 10, Issue #385) — a brief whose `§4` names a path under a
 * shared `packages/<pkg>/` must also name, for every workspace package that
 * depends on `@attalabs/<pkg>`, a test path proving that consumer still
 * works, or the sentinel `consumer-tests: none — <reason>` opting out with a
 * stated reason. A shared-package edit with no consumer awareness at all is
 * exactly the gap task 9's rule targets alongside the unpinned-claim and
 * missing-output shapes.
 *
 * `consumersOf` is injected (never `fs`/`package.json` reads here) — the CLI
 * shim (`check-brief-shape.ts`) builds it once from the real workspace
 * dependency graph. Both the trigger and its satisfying test path/sentinel
 * are read from `§4` alone, never the whole body — scanning the whole body
 * let a brief's own §2 prose, quoting the sentinel grammar as an example of
 * the rule (exactly this task's own dispatched brief), silently satisfy the
 * rule it was merely describing. `§4` is where a surface map states its
 * blast radius; that is also where this rule's own answer belongs.
 */
export function checkConsumerTests(prBody: string, consumersOf: (pkg: string) => string[]): BriefSectionResult {
  const section4 = extractNumberedSection(prBody, 4)
  if (!section4) return { status: 'pass', errors: [] }
  if (CONSUMER_TESTS_SENTINEL_RE.test(section4)) return { status: 'pass', errors: [] }

  const errors: string[] = []
  for (const pkg of packagesNamedIn(section4)) {
    for (const consumerDir of consumersOf(pkg)) {
      if (hasTestPathForConsumer(section4, consumerDir)) continue
      errors.push(
        `brief-validation consumer tests: §4 names a path under packages/${pkg}/, and ${consumerDir} depends on @attalabs/${pkg}, but no test path under ${consumerDir} is named in §4 — name one, or add \`consumer-tests: none — <reason>\`.`
      )
    }
  }
  return errors.length === 0 ? { status: 'pass', errors: [] } : { status: 'fail', errors }
}

/** A check bin filename (`check-<slug>.ts`) — the shape both a §4 "Create"/"Modify" entry and a registry entry use for a check's own name. */
const CHECK_NAME_RE = /\bcheck-[a-z0-9-]+(?:\.ts)?\b/

/** A command that writes to the forge — as opposed to a read-only query — the class this rule wants a `Defeat cases:` line for. */
const FORGE_WRITE_COMMAND_RE =
  /\bgh\s+(?:pr|issue)\s+(?:create|merge|close|comment|edit|review)\b|\bgit\s+push\b|\bvinaya\s+pr\s+(?:create|report\s+--write)\b/i

const DEFEAT_CASES_RE = /defeat cases\s*:/i

/**
 * Rule (v) — Principal ruling amending Issue #385: a brief whose `§4`
 * names a check (a `check-<slug>.ts` bin, or its registry entry) or a
 * forge-writing command (`gh pr create`, `git push`, `vinaya pr create`, …)
 * must carry a `Defeat cases:` line in `§6` — the inputs that would defeat
 * the check, or the ones a forge-writing command must not accidentally
 * trigger on. A check or a write path shipped with no stated defeat case is
 * exactly the kind of untested edge this task's own sibling rules exist to
 * close for a brief's prose claims; this one closes it for the check/command
 * itself.
 */
export function checkDefeatCases(prBody: string): BriefSectionResult {
  const section4 = extractNumberedSection(prBody, 4)
  if (!section4) return { status: 'pass', errors: [] }
  if (!CHECK_NAME_RE.test(section4) && !FORGE_WRITE_COMMAND_RE.test(section4)) return { status: 'pass', errors: [] }

  const section6 = extractNumberedSection(prBody, 6) ?? ''
  if (DEFEAT_CASES_RE.test(section6)) return { status: 'pass', errors: [] }

  return {
    status: 'fail',
    errors: [
      'brief-validation defeat cases: §4 names a check or a forge-writing command, but §6 carries no `Defeat cases:` line — name the inputs that would defeat this check, or that this command must not accidentally trigger on.'
    ]
  }
}

/**
 * Every `Part <n> (<refs>)` citation's `O<n>` ids, across every match in
 * `section6`. A Part with no parenthetical group after its number cites
 * nothing and is not scrutinized either way by `checkObjectivesCoverage` —
 * an administrative Part (a changeset commit, the final push) legitimately
 * maps to no single objective; this brief's own §6 Part 5 ("changeset. Then
 * the one push.") is exactly that shape.
 */
export const PART_CITATION_RE = /Part\s+\d+\s*\(([^)]*)\)/gi
const OBJECTIVE_REF_RE = /O(\d+)/g

function citedObjectiveIds(section6: string): Set<number> {
  const ids = new Set<number>()
  for (const m of section6.matchAll(PART_CITATION_RE)) {
    for (const r of (m[1] as string).matchAll(OBJECTIVE_REF_RE)) ids.add(Number.parseInt(r[1] as string, 10))
  }
  return ids
}

/**
 * Objectives copy (dev-review-loop-v1 task 1, Issue #411, O3) — the brief's
 * own `## Objectives` section must match the Issue's, compared via
 * `objectivesVersion` (normalised — an editor's whitespace must not fail
 * this gate; one changed word must). `issueObjectives` is injected: the
 * caller resolves it live from the forge (`Closes #N`'s Issue) on a task
 * branch, or from the body's own section on a standalone brief with no
 * Issue to compare against (verify-brief.ts/check-brief-shape.ts).
 */
export function checkObjectivesCopy(prBody: string, issueObjectives: Objective[]): BriefSectionResult {
  const parsed = objectivesOf(prBody)
  if (!parsed.ok) {
    return { status: 'fail', errors: parsed.errors.map((e) => `brief-validation objectives copy: ${e}`) }
  }
  if (objectivesVersion(parsed.objectives) !== objectivesVersion(issueObjectives)) {
    return {
      status: 'fail',
      errors: [
        "brief-validation objectives copy: the brief's `## Objectives` section does not match the Issue's — copy the Issue's `## Objectives` section (aeg-root/roles/developer.md)."
      ]
    }
  }
  return { status: 'pass', errors: [] }
}

/**
 * Objectives coverage (dev-review-loop-v1 task 1, Issue #411, O3) — every
 * `O<n>` the brief's own `## Objectives` section declares must be cited by
 * at least one `Part <n> (O<k>[, O<j>...])` line in §6, and a Part that DOES
 * cite one must cite an objective that actually exists. Self-contained
 * (needs only `prBody`) — unlike `checkObjectivesCopy`, this rule never
 * depends on a live Issue read.
 */
export function checkObjectivesCoverage(prBody: string): BriefSectionResult {
  const parsed = objectivesOf(prBody)
  if (!parsed.ok) {
    return { status: 'fail', errors: parsed.errors.map((e) => `brief-validation objectives coverage: ${e}`) }
  }
  const declaredIds = new Set(parsed.objectives.map((o) => Number.parseInt(o.id.slice(1), 10)))
  const section6 = extractNumberedSection(prBody, 6) ?? ''
  const cited = citedObjectiveIds(section6)
  const maxDeclared = Math.max(...declaredIds, 0)

  const errors: string[] = []
  for (const id of declaredIds) {
    if (!cited.has(id)) {
      errors.push(
        `brief-validation objectives coverage: O${id} is not cited by any Part in §6 — every objective must be cited by at least one Part.`
      )
    }
  }
  for (const id of cited) {
    if (!declaredIds.has(id)) {
      errors.push(
        `brief-validation objectives coverage: a Part in §6 cites O${id}, but the Objectives section ends at O${maxDeclared}.`
      )
    }
  }
  return errors.length === 0 ? { status: 'pass', errors: [] } : { status: 'fail', errors }
}

/** Composition knobs for `checkBriefSections` — see each field. */
export type BriefSectionsOptions = {
  /**
   * Whether a `Closes #N` reference is required. Defaults to `true` (every
   * existing caller keeps today's behavior).
   *
   * A task PR must close its Issue, so `verify-brief` leaves this on for
   * `task/<tranche>/<n>`. A brief-shaped body on a non-task branch must not: a
   * standalone fix brief has no task Issue to close, and a `plan/*` PR is
   * *forbidden* to carry `Closes #N` by `checkPlanPrNoCloses` — so
   * requiring it there would make the two gates jointly unsatisfiable. Issue
   * linkage is a task-branch obligation; brief completeness is not.
   */
  requireClosesN?: boolean
  /**
   * Consumer enumeration for `checkConsumerTests` (task 10) — workspace
   * directories (e.g. `apps/cli`) whose `package.json` depends on
   * `@attalabs/<pkg>`. Defaults to `() => []`, which makes rule (iii) a
   * no-op — the callers that don't wire a real dependency graph (tests,
   * `verify-brief.ts`) keep today's behavior rather than silently failing
   * on an empty consumer list.
   */
  consumersOf?: (pkg: string) => string[]
  /**
   * The Issue's `## Objectives` list, for `checkObjectivesCopy`'s
   * comparison — injected because resolving it is a live forge read
   * (`gh issue view`), which this module stays pure of. `undefined` (the
   * default) skips BOTH objectives checks entirely — the same no-op-when-
   * unwired default `consumersOf` uses, so an existing caller that hasn't
   * been taught to fetch the Issue keeps today's behavior.
   */
  issueObjectives?: Objective[]
}

/**
 * Aggregates every section detector into one combined result — one error
 * line per failing section, mirroring `doc-owners.ts`'s `parseDocOwners`
 * error-message style.
 */
export function checkBriefSections(
  prBody: string,
  readTier: (body: string) => 0 | 1 | 3 | null,
  options: BriefSectionsOptions = {}
): { errors: string[] } {
  const { requireClosesN = true, consumersOf = () => [], issueObjectives } = options
  const results = [
    checkTierField(prBody, readTier),
    checkTestPlan(prBody),
    checkTestPlanExclusivity(prBody),
    checkPrincipalPlaceholder(prBody),
    checkSurfaceMap(prBody),
    checkDocUpdateList(prBody),
    checkWorktreeStep0(prBody),
    checkStopConditions(prBody),
    checkAutonomyClause(prBody),
    checkProjectField(prBody),
    checkForField(prBody),
    checkNoUnpinnedCodeClaims(prBody),
    checkNoAgentBoxes(prBody),
    checkCommandsCarryOutput(prBody),
    checkConsumerTests(prBody, consumersOf),
    checkDefeatCases(prBody),
    ...(issueObjectives !== undefined
      ? [checkObjectivesCopy(prBody, issueObjectives), checkObjectivesCoverage(prBody)]
      : []),
    ...(requireClosesN ? [checkClosesN(prBody)] : [])
  ]
  return { errors: results.flatMap((r) => r.errors) }
}

/**
 * The marker line a dispatched task's frozen `aeg:brief:v1` Issue comment
 * starts with (`dispatch-task.ts`'s `dispatchTask`, `apps/cli`). Promoted
 * here (plan-brief-v1 task 3, #428) so the comment-resolution logic that
 * needs it — `packages/aeg-core/bin/verify-brief.ts` (this package, cannot
 * import `apps/cli`) and `apps/cli`'s own `dispatch-task.ts`/
 * `check-brief-shape.ts` — read the SAME constant rather than four copies of
 * the same string that could quietly drift out of agreement.
 */
export const AEG_BRIEF_V1_MARKER = '<!-- aeg:brief:v1 -->'

/**
 * Everything in a posted `aeg:brief:v1` comment after its marker line and
 * `Brief hash:` line, as a raw substring — never a line-split-then-rejoin,
 * which would silently renormalize whatever separates the two header lines
 * from the brief body beneath them. The one canonical implementation
 * (plan-brief-v1 task 3, #428): `dispatch-task.ts`, `verify-dispatch.ts` and
 * `archive-task.ts` each carried their own copy before this promotion —
 * found live (code review), the exact "N copies of hash-contract-critical
 * logic with nothing proving they agree" failure `edge-resolve.ts`'s own
 * doc comment already warns this codebase about.
 */
export function contentAfterTwoLines(body: string): string {
  const first = body.indexOf('\n')
  if (first === -1) return ''
  const second = body.indexOf('\n', first + 1)
  if (second === -1) return ''
  return body.slice(second + 1)
}
