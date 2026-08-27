/**
 * Planner→Brief Issue-rationale grammar. Pure — no `fs`, no `fetch`,
 * no `process.env`. The tool-layer gate (`bin/open-issue.ts`, invoked because
 * the `check-forge-gates.sh` hook denies raw `gh issue create`) calls
 * `checkIssueRationale` before any task Issue can reach the forge.
 *
 * A task Issue's body must carry every producer field of the
 * `aeg-root/contracts/planner-brief.md` contract — the eight Planner's
 * rationale fields. makes cutting the Issue with its rationale the
 * canonical plan act; an Issue without the full rationale forces the Brief
 * Author to re-derive the Planner's dig cold, the exact loss the contract
 * exists to prevent. Presence-only, like `brief-validation.ts`: content
 * quality stays a judgment call; existence does not.
 *
 * Applies to task Issues only (label `vinaya/tranche:<slug>`) — the caller decides
 * applicability from the labels; this module only checks the body.
 */

import { hasLabel, LABELS, projectFieldFromBody, projectsFromBody, SECTION_HEADER } from '@attalabs/aeg-forge-state'
import { stripCode } from './anchored-region'

export type IssueSectionResult = { status: 'pass' | 'fail'; errors: string[] }

/**
 * Tolerant field detector: accepts the two live rationale styles —
 * `**Field** — …` bold-inline (e.g. Issue #309) and `### Field` headings
 * (e.g. Issue #219). Case-insensitive.
 */
function hasRationaleField(body: string, labelPattern: string): boolean {
  // `labelPattern` is grouped. Ungrouped, its own top-level `|` (present in
  // several RATIONALE_FIELDS entries, e.g. `Dependency rationale|Depends[- ]on`)
  // splits the WHOLE alternation instead of just the label — turning the
  // second half into a bare, unanchored match with no prefix requirement at
  // all. Found live: "Depends on" matching mid-sentence prose with no `**`/
  // heading marker anywhere near it, misreporting old Issues that never had
  // this field as "malformed" instead of "missing".
  const re = new RegExp(`(?:\\*\\*|^#{1,4}\\s+)\\s*(?:${labelPattern})`, 'im')
  return re.test(body)
}

/** The eight producer fields of the planner-brief contract, with tolerant label patterns. */
const RATIONALE_FIELDS: Array<{ name: string; pattern: string }> = [
  { name: 'Boundary', pattern: 'Boundary' },
  { name: 'Sizing', pattern: 'Sizing' },
  { name: 'Project(s) + blast radius', pattern: 'Project\\(s\\)|Project(?:s)?\\s*\\+|blast radius' },
  { name: 'Dependency rationale', pattern: 'Dependency rationale|Depends[- ]on' },
  { name: 'Traps to avoid', pattern: 'Traps' },
  { name: 'Suggested agent-class', pattern: '(?:Suggested\\s+)?agent-class' },
  { name: 'Stop-and-escalate', pattern: 'Stop-and-escalate' },
  { name: 'Docs to keep coherent', pattern: 'Docs to keep coherent|§7' }
]

const DEPENDENCY_RATIONALE_FIELD_NAME = 'Dependency rationale'

/**
 * Every one of the eight Planner's-rationale fields must be present in a task
 * Issue's body. One error line per missing field, mirroring
 * `checkBriefSections`'s error style.
 *
 * `Dependency rationale` carries a second, stricter requirement the other
 * seven fields do not: `amendRationaleDeps` (`@attalabs/aeg-forge-state`, the ONLY
 * sanctioned way to edit `Depends-on`/`Conflicts-with`) locates this section
 * by the exact anchor `SECTION_HEADER` — `**Dependency rationale**` with the
 * bold closing immediately after the label. A body written
 * `**Dependency rationale:** …` (colon inside the bold) satisfies the tolerant
 * detector above but not `SECTION_HEADER`, so it passes here and then throws
 * on the only sanctioned edit path. Importing `SECTION_HEADER` rather than a
 * second hand-written regex keeps this one grammar.
 */
export function checkIssueRationale(body: string): IssueSectionResult {
  const errors: string[] = []
  for (const f of RATIONALE_FIELDS) {
    if (!hasRationaleField(body, f.pattern)) {
      errors.push(
        `issue-validation ${f.name}: rationale field not found in the Issue body — every task Issue carries the full Planner's rationale (aeg-root/contracts/planner-brief.md).`
      )
      continue
    }
    if (f.name === DEPENDENCY_RATIONALE_FIELD_NAME && !SECTION_HEADER.test(body)) {
      errors.push(
        `issue-validation ${f.name}: rationale field found, but not in the form amend-deps requires — ` +
          'write `**Dependency rationale** — …`, not `**Dependency rationale:** …`. ' +
          '`amendRationaleDeps` (the only sanctioned way to edit Depends-on/Conflicts-with) locates this ' +
          'section by the exact anchor `**Dependency rationale**`; a colon inside the bold breaks that match ' +
          'and the Issue becomes unamendable.'
      )
    }
  }
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}

/** true when any label marks this as a task Issue (the rationale contract applies). */
export function isTaskIssueLabelSet(labels: string[]): boolean {
  return hasLabel('tranche', labels)
}

/** Every `vinaya/type:*` label id, in `labels.ts` order — the source of truth this check reads, never a second list. */
const TYPE_LABEL_IDS = LABELS.filter((l) => l.category === 'type').map((l) => l.id)

/**
 * **The task-type axis.** A task Issue must carry exactly one `vinaya/type:*`
 * label — the same commit-type vocabulary `developer.md`'s commit conventions
 * declare, applied to the Issue instead of the commit. Zero means the task
 * was never classified; two or more means two classifications compete and
 * nothing downstream can pick between them.
 *
 * Non-task Issues (no tranche label) pass trivially, the same way every
 * sibling content check treats them — the rationale contract, and everything
 * built on it, applies to task Issues only.
 *
 * **Caller must invoke this at Issue CREATION only, never on `edit`.** The
 * label is mandatory forward from this axis's own merge, not retroactively —
 * a task Issue cut before the merge legitimately carries none, and
 * `open-issue.ts` is the only sanctioned edit path for ANY Issue body, so
 * calling this on every edit would refuse an unrelated edit (a typo fix, a
 * dependency bump) to any pre-existing Issue for lacking a label nothing
 * ever asked it to carry — a forced backfill through the back door. This
 * function itself is pure and stateless (it cannot see create vs. edit); the
 * gating lives in the caller (`open-issue.ts`'s `isEdit` branch).
 */
export function checkIssueType(_body: string, labels: string[]): IssueSectionResult {
  if (!isTaskIssueLabelSet(labels)) return { status: 'pass', errors: [] }
  const present = TYPE_LABEL_IDS.filter((id) => labels.includes(id))
  if (present.length === 1) return { status: 'pass', errors: [] }
  const found = present.length === 0 ? 'none of them' : `${present.length} of them (${present.join(', ')})`
  return {
    status: 'fail',
    errors: [
      `issue-validation task type: a task Issue must carry exactly one \`vinaya/type:*\` label, and this one carries ${found}. Valid ids: ${TYPE_LABEL_IDS.join(', ')}.`
    ]
  }
}

// ---------------------------------------------------------------------------
// Content checks (A/B/D block, C warns)
//
// `checkIssueRationale` above checks the eight fields are PRESENT and
// well-formed. It never checks what they SAY against the surface the task
// touches — and three task Issues in `vinaya-pages-v2` (#621/#622/#626) passed
// it while being wrong in three distinct ways: a `packages/ui` edit declared
// `Project: vinaya` only (blast radius under-declared, so the review fans out
// through one product's lens instead of every consumer's); a `## References`
// block copied brief-time content into the Issue, where it goes stale before
// work starts; and nothing forced the rationale to name the docs/skills it
// touches, because the skill-check hook fires on file edits and a forge write
// edits no file. The checks below are those three failures turned into
// deterministic functions on the surface they happened on.
//
// EVERY ONE OF THEM READS BLOCK-STRIPPED TEXT, via the single exported
// `stripCode` — never a second regex (PR #617's rule). A rationale that quotes
// `## References`, `Premise:`, or a `packages/ui` path inside a **fence** is
// documenting, not leaking, and must not trip anything; GitHub's own parsers
// ignore code the same way.
//
// They differ on **inline spans**, and the split is not cosmetic:
//
//   - B looks for brief-shaped *headings*, which never live in a span, so it
//     takes the full default strip.
//   - A/C/D look for *paths*, and prose writes paths in backticks by
//     convention — #621 declares its own surface as "edits `packages/ui`". Run
//     span-blind, A matches nothing on the very Issues it was built from and
//     ships as a gate that always passes, which is worse than no gate. So they
//     read `PATH_TEXT`: fences and indented blocks gone, spans intact.
//
// Accepted cost: brief content that leaks *entirely inside* a fence is
// invisible to B. Same trade every code-aware gate here makes; the alternative
// is the fence-blind false-positive machine #617 removed.
// ---------------------------------------------------------------------------

/**
 * Block-stripped, span-preserving body text — the reading every path-shaped
 * check uses. See the note above for why paths cannot be scanned span-blind.
 */
const PATH_TEXT = (body: string): string => stripCode(body, { inlineSpans: 'keep' })

/** A registry row reduced to what the blast-radius check needs — `parseRegistry` output is assignable. */
export type ProjectPath = { name: string; path: string }

/**
 * A C0 or C1 control character — `ESC` (and therefore every ANSI/OSC terminal
 * escape), `BEL`, and the rest.
 *
 * Tested by code point rather than by a character-class regex on purpose: a
 * regex spelling this range is itself a lint violation
 * (`noControlCharactersInRegex`), and the rule is right — the readable way to
 * say "control character" is to name the code points.
 */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

/**
 * Characters that change how the rest of a line *renders* without printing
 * anything themselves — the Trojan-Source class.
 *
 * Stripping C0/C1 closes ANSI and OSC, but it is not the whole of "a hostile
 * value cannot repaint or hide the failure being reported": a bidi override
 * (U+202E) reverses the rendered name in the operator's terminal, and a
 * zero-width character (U+200B) splits a name so it reads as a registered one.
 * Same untrusted sources, same goal, so they are dropped by the same pass.
 *
 *   U+200B–200F  zero width space/joiners, LRM/RLM
 *   U+202A–202E  bidi embedding and override
 *   U+2066–2069  bidi isolates
 *   U+FEFF       byte-order mark used as a zero-width no-break space
 */
function isDisplayControlCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  )
}

/**
 * How many residue values one error message will name before summarising the
 * rest. `field.unparsed` is one entry per comma-separated segment, so a single
 * body of repeated `%,` pairs yields tens of thousands of them; uncapped they
 * render into one enormous string that lands in `CheckFailure.reason` and in a
 * blocking gate's `--json` output. Naming the first few is what an author needs
 * to find the line; the count carries the rest.
 */
const MESSAGE_VALUE_COUNT_MAX = 5

/** Renders a residue list for an error message: the first few values, then a count. */
function residueForMessage(values: string[]): string {
  const shown = values.slice(0, MESSAGE_VALUE_COUNT_MAX).map((v) => `\`${forMessage(v)}\``)
  const rest = values.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/** How much of one untrusted value an error message will carry before eliding. */
const MESSAGE_VALUE_MAX = 64

/**
 * Renders an untrusted string into an error message.
 *
 * **Neither side of this gate's message is validated at its source.** Registered
 * names come from `parseRegistry`, which by design "is forgiving" and applies no
 * shape check at all — a name is whatever text sat in a markdown table cell. The
 * declared side is a task Issue's body. Vinaya ships inside the published
 * `@attalabs/vinaya` tarball and runs against *guest* repos, so both are attacker-
 * reachable: a hostile `.vinaya/projects.md` row (or Issue body) carrying `ESC`
 * renders ANSI/OSC sequences straight through a Vinaya error into the operator's
 * terminal, where they can repaint or hide the very failure being reported.
 *
 * Sanitising here rather than at `parseRegistry` is deliberate: the registry's
 * tolerance is load-bearing (a typo'd row must not crash Studio), and a name that
 * is merely *odd* must still resolve for exact-match purposes. The constraint
 * belongs where the value crosses into a rendered message, which is here.
 *
 * Strips control characters, collapses whitespace to single spaces (so a value
 * cannot span lines and forge a second error line), and elides past
 * `MESSAGE_VALUE_MAX`. Everything a well-formed project name is made of survives
 * untouched — this is sanitation, not redaction.
 */
function forMessage(value: string): string {
  // Whitespace collapses FIRST, so a newline or tab becomes a space rather than
  // vanishing and welding two words together — and a multi-line value cannot
  // forge what looks like a second error line.
  const kept: string[] = []
  for (const ch of value.replace(/\s+/g, ' ')) {
    const codePoint = ch.codePointAt(0) ?? 0
    if (isControlCodePoint(codePoint) || isDisplayControlCodePoint(codePoint)) continue
    kept.push(ch)
  }
  // Elide by CODE POINT, not by UTF-16 index. `slice` on a string counts code
  // units, so a cut landing inside an astral character emits a lone surrogate —
  // a malformed string, from the function whose job is to make this value safe.
  const cleaned = kept.join('').trim()
  if (cleaned.length === 0) return '(unprintable)'
  const points = Array.from(cleaned)
  return points.length > MESSAGE_VALUE_MAX ? `${points.slice(0, MESSAGE_VALUE_MAX).join('')}…` : cleaned
}

/**
 * The projects a task Issue declares — its body's `**Project:**` field, and
 * only that. Project is a **field, not a label** (doctrine): #614 dropped the
 * `project:*` labels outright, and `@attalabs/aeg-forge-state`'s `list-tasks.ts`
 * derives a task's project from the same field, so the two agree by
 * construction. `labels` stays in the signature because callers pass it and
 * the applicability question (`isTaskIssueLabelSet`) is label-shaped.
 */
export function declaredProjects(body: string, _labels: string[]): string[] {
  const field = /(?:\*\*)?Project(?:\(s\))?(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]+)/i.exec(PATH_TEXT(body))
  const fromBody = (field?.[1] ?? '')
    .split(/[,/]/)
    // Trim the markup and sentence punctuation a field value carries in prose —
    // the value is routinely written as "`Project: vinaya`." (backticked, with
    // the sentence's full stop inside the span, which `PATH_TEXT` preserves).
    .map((s) => s.replace(/\*\*/g, '').replace(/[`.;]/g, '').trim())
    // The field's value may trail into prose ("vinaya. **BUT edits …**"); keep
    // the bare-name shapes a registry row can actually carry.
    .filter((s) => /^[a-z0-9][a-z0-9-]*$/i.test(s))
  return [...new Set(fromBody.filter((s) => s.length > 0))]
}

/**
 * **Every declared project resolves against the registry.** `planner.md` states
 * this as a hard gate — *"Unregistered project or a `Project:` that doesn't
 * resolve against `projects.md` → refuse"* — and until this function nothing
 * mechanized it. Found live on 2026-08-12 on a draft plan declaring
 * `Project: aeg-core, aeg-types, vinaya`; `aeg-types` has no registry row and
 * the plan passed every gate.
 *
 * `.vinaya/projects.md` is the sole authority for valid names ("A `Project:`
 * value is valid iff every name in it is a row above"), so this check only asks
 * membership — never whether the *right* projects were chosen, which stays a
 * review judgment like the rest of this module.
 *
 * **It calls `projectsFromBody` — the same function, not a matching regex.**
 * `@attalabs/aeg-forge-state`'s `list-tasks.ts` is the repo's authority for what a
 * task's project *is*: it is what fills `Task.projects`, and therefore what
 * drives the board, dispatch, and doc fan-out. A gate that decides a project is
 * unregistered must be reading the identical name the derivation resolved, or
 * the two can disagree about what the task even declares — so this shares the
 * parser by construction rather than by agreement. That is the same discipline
 * `parseRationaleDeps`/`SECTION_HEADER` already enforce for dependency edges,
 * and the import direction is the existing one (`aeg-core → aeg-forge-state`,
 * as in `archive-task.ts`); nothing new is layered.
 *
 * **Never parse the `Project(s) + blast radius` prose heading here.** That
 * heading is narrative that happens to mention project names alongside file
 * paths; `PROJECT_FIELD` excludes it deliberately ("nothing there puts a `:`
 * straight after the name"). Reading it makes the gate blind to the real
 * declaration and invents projects out of the paths sharing the line. Equally,
 * do not add a second regex that "also handles" the footer field — two parsers
 * that agree today is exactly how the gate and the derivation drift apart.
 *
 * Matching is **exact, case-sensitive**. Every downstream consumer of a
 * project name compares it literally — `verify-dispatch`'s
 * `t.projects.includes(project)`, the board link, the doc fan-out — so
 * case-folding here would pass `Project: Vinaya` while the whole rest of the
 * system resolves it to nothing. Refusing it is the honest answer; the message
 * names the row it differs from only in case, so the fix is obvious.
 *
 * A body with no `**Project:**` line **passes**. Whether the field exists is
 * already `checkIssueRationale`'s job (`Project(s) + blast radius` is one of the
 * eight required fields); duplicating it here would put one failure behind two
 * gates with two different messages. This check answers only "do the declared
 * names resolve".
 *
 * **A declared value that resolves to no name FAILS** — the distinction the
 * parser's old bare `string[]` could not express. Every value used to be filtered
 * through the slug shape and dropped without trace, so `**Project:** notaproject.`
 * (trailing full stop) and a fully backticked or bolded value each arrived here as
 * an empty list, identical to a body that declares nothing. The gate cannot refuse
 * a name it never receives, so it passed **vacuously** on exactly the bodies it
 * exists to catch. `projectFieldFromBody` now separates "no field" (still a pass)
 * from "a field present that resolves to nothing" (a fail, naming the residue when
 * there is one and calling the field empty when there is not) and from "a field
 * this reader could not see" (an unterminated fence — also a fail, see above).
 *
 * **What the corpus does and does not say.** Measured across every task Issue
 * in this repo's forge: zero carry any of those shapes, so this closed a
 * fail-open without turning a single live body red. That is a statement about
 * bodies that exist, not a proof that none can slip past — a constructed body
 * can carry a shape the live corpus happens not to.
 *
 * **A `Project:` line inside CODE — a balanced fence, or a ≥4-column-indented
 * block after a blank line — is an example, not a declaration, and is not
 * read**, by the same rule `stripCode` already applies to every other
 * code-aware gate in this file. This is deliberate, not a gap: it matches how
 * the forge itself renders the line, so refusing to read it is refusing to read
 * what GitHub also treats as code. Only an UNTERMINATED fence differs — it has
 * no natural end, so `stripCode` blanks everything after it including the
 * body's foot, and that swallowed region fails closed rather than reading as
 * absent (see `hasUnterminatedFence` above). An indented block has no
 * equivalent unterminated state — it always ends, either at a dedent or at the
 * body's own end — so it stays a pass like any other example; pinned by test
 * (`list-tasks.test.ts`) so the difference is a recorded decision, not a silent
 * surprise.
 *
 * A known remaining gap of a DIFFERENT class, out of scope here because it is
 * the field's grammar rather than its code-blindness: a `Project:` line inside
 * an HTML comment still outranks the real declaration, since a comment is not
 * code and `stripCode` correctly leaves it.
 *
 * **What reaches the message is constrained** (`forMessage`). Both the declared
 * value and the registered names are untrusted — `parseRegistry` validates
 * nothing, and Vinaya runs against guest repos — so neither is rendered raw.
 *
 * Dormant when `registeredNames` is empty (no `.vinaya/projects.md` on disk) —
 * the same seam-is-dormant-when-absent shape `checkBlastRadiusScope` and
 * `doc-owners` use. A single-project repo has no registry by design, and a
 * check with no source of truth must not invent one. Both bin callers warn when
 * they hand over an empty registry, so the dormancy is never silent.
 */
export function checkProjectsRegistered(
  body: string,
  _labels: string[],
  registeredNames: string[]
): IssueSectionResult {
  if (registeredNames.length === 0) return { status: 'pass', errors: [] }
  const field = projectFieldFromBody(body)
  if (!field.declared) return { status: 'pass', errors: [] }
  const known = new Set(registeredNames.map((n) => n.trim()))
  const registeredList = [...registeredNames].map(forMessage).join(', ')
  const errors: string[] = []

  // An unterminated fence ran to end of body and swallowed the region the field
  // lives in, so the value below is what the RAW body says and cannot be trusted
  // — inside a swallowed region a quoted example and a real declaration are
  // indistinguishable. Fail closed and point at the malformed fence: accusing
  // the name of not being a project would be wrong (it may be a perfectly good
  // registered one) and would send the author to fix the wrong line.
  if (field.unreadable) {
    return {
      status: 'fail',
      errors: [
        `issue-validation project registry: the body has an unterminated code fence, so its \`**Project:**\` field could not be read reliably — the fence runs to end of body (CommonMark, and how the forge renders it), swallowing everything after it including the foot field where the declaration lives by convention. Read from the raw body the field says ${residueForMessage(field.unparsed) || '(nothing)'}, but a line inside a swallowed region may be a quoted example rather than a real declaration, so this gate refuses rather than guessing which. Balance the fences — every opening run of backticks or tildes needs a closing run at least as long — and the field reads normally.`
      ]
    }
  }

  const unregistered = field.names.filter((p) => !known.has(p))
  if (unregistered.length > 0) {
    // A name differing from a real row only in case is the likeliest typo, and the
    // least obvious from the registered list alone — call it out by name.
    const caseHints = unregistered
      .map((p) => {
        const row = [...known].find((k) => k.toLowerCase() === p.toLowerCase())
        return row ? `\`${forMessage(p)}\` differs from the registered \`${forMessage(row)}\` only in case` : null
      })
      .filter((h): h is string => h !== null)
    errors.push(
      `issue-validation project registry: the \`**Project:**\` field declares ${unregistered.map(forMessage).join(', ')} — no such row in \`.vinaya/projects.md\`, which is the authority for valid project names (registered: ${registeredList}). Fix the name, or register the project with \`vinaya init product <name> --path <folder>\` first; an unregistered project has no specs to read and no per-project state to update.${caseHints.length > 0 ? ` Note: ${caseHints.join('; ')} — project names are matched exactly, because every downstream consumer compares them literally.` : ''} This reads the same field \`projectsFromBody\` derives the task's project from, so a name here that is not a row is a task that resolves to a project that does not exist.`
    )
  }

  // The fail-open this check was blind to. A value the parser cannot turn into a
  // name never reached the loop above, so the gate had nothing to refuse and
  // passed — on a body that declares a project as loudly as any other. Silence
  // here is indistinguishable from "this task declares no project", and the two
  // mean opposite things: one is a deliberate omission, the other is a
  // declaration nothing in the system can resolve.
  //
  // Keyed on "declared and resolved to NOTHING", not on the residue: an empty
  // `**Project:**` line yields no name and no residue either, and is the same
  // vacuous pass one shape further along. The residue is named when there is
  // one, because it is the whole of the fix — but its absence is not a pass.
  if (field.names.length === 0) {
    const residue = field.unparsed.length > 0 ? ` — ${residueForMessage(field.unparsed)}` : ' — the field is empty'
    errors.push(
      `issue-validation project registry: the \`**Project:**\` field is present but resolves to no project name${residue} (registered: ${registeredList}). A project name is a slug (\`[a-z0-9][a-z0-9-]*\`, matched exactly); prose, a parenthetical, or a sentence in this field resolves to no project at all, and this gate cannot check a name it never receives — which is how a declaration like this used to pass. Write the registered name on its own, or register the project with \`vinaya init product <name> --path <folder>\` first. If the task genuinely touches no registered project, omit the field rather than explaining its absence inside it — \`checkIssueRationale\` already requires the \`Project(s) + blast radius\` narrative field for that.`
    )
  } else if (field.unparsed.length > 0) {
    errors.push(
      `issue-validation project registry: the \`**Project:**\` field declares a value that is not a project name — ${residueForMessage(field.unparsed)} (registered: ${registeredList}). The rest of the field parsed, so this is a name the gate silently could not check rather than a field it could not read at all. A project name is a slug (\`[a-z0-9][a-z0-9-]*\`, matched exactly); write it on its own, or drop it if it names no project.`
    )
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass', errors: [] }
}

/**
 * Does the text name a path that puts this task **inside** the collision
 * domain `path`? Matches the domain as a whole path token — `packages/ui` hits
 * `packages/ui/topbar/index.tsx` and a bare `packages/ui`, never
 * `packages/ui-next`.
 *
 * **A cited document is not a touched domain.** Every rationale points at docs
 * for provenance — "the registry row in `.vinaya/projects.md`",
 * "per `packages/ui/README.md`" — and counting those as edits fails correct
 * plans wholesale (it fired on all three of #621/#622/#626 for a projects.md
 * citation none of them edits). So an occurrence whose full path token ends in
 * a doc extension does not count; a bare domain reference, or any non-doc path
 * under it, does. Citing `packages/ui/README.md` *and* editing
 * `packages/ui/topbar/index.tsx` still counts — the check looks for any one
 * qualifying occurrence, not the first.
 */
const DOC_EXTENSION_RE = /\.(?:md|mdx|txt)$/i

function namesPath(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const occurrences = new RegExp(`(?:^|[^\\w./-])(${escaped}(?:/[\\w.@-]+)*)(?![\\w-])`, 'gm')
  for (const m of text.matchAll(occurrences)) {
    if (!DOC_EXTENSION_RE.test(m[1] as string)) return true
  }
  return false
}

/** An explicit, deliberate acknowledgment that the task's reach crosses products. */
const BLAST_RADIUS_ACK_RE = /(?:\*\*)?blast-radius-ack(?:\*\*)?\s*[:—–-]/i

/**
 * **A — blast radius under-declared.** If the rationale names a path under a
 * collision domain that none of the declared projects owns, the task reaches
 * further than its `Project:` set admits. `projects.md` makes that set the
 * review fan-out ("more projects = more review lenses = proportionally more
 * rigor"), so a shared-primitive change carrying one product's label is
 * reviewed through one lens and under-governs the regression its own prose
 * usually admits in the same breath (#621: "**BUT edits `packages/ui`** … any
 * topbar change is seen by every product").
 *
 * Two ways to satisfy it, both deliberate: list the other consumers in the
 * project field (the fan-out actually widens), or write a `blast-radius-ack:`
 * line (the reach is acknowledged and the Planner has decided one lens is
 * enough). Silence is the only failure.
 *
 * **The multi-project bypass counts registry-validated names only.** A name
 * with no row in `.vinaya/projects.md` resolves to no specs, no state and no
 * reviewer, so it widens nothing — counting it lets a fictional name buy the
 * benefit of the doubt this bypass exists to give real ones. Found live on a
 * draft plan declaring three projects, one of which had no registry row: it
 * cleared the bypass, and the check never ran on a genuinely shared edit.
 * `checkProjectsRegistered` refuses that name in its own right; this function
 * merely declines to be fooled by it, so the two stay independent.
 *
 * **Ownership, not mere listing.** A domain that IS a declared project's own
 * registered path is owned by it — `Project: aeg-core` editing
 * `packages/aeg-core` declares its blast radius exactly, and must not be
 * failed. Without this, the check would block the legitimately single-project
 * shared edit, which is a gate that blocks valid work.
 *
 * **The declared set is read through `projectsFromBody`** — the same parser
 * `checkProjectsRegistered` and `@attalabs/aeg-forge-state`'s `list-tasks.ts` use,
 * shared by construction rather than by agreement. It reads the line-anchored
 * project field and only that. The previous body-wide read took the first
 * field-shaped token *anywhere* in the body, which is routinely prose in Sizing
 * or Boundary rather than the declaration: prose carries file paths, and a path
 * fragment parses as an invented project name (#870's own blast-radius line
 * yielded a project called `src`). Two parsers for one field is how the gate and
 * the derivation come to disagree about what a task even declares — so do not
 * add a second regex here, nor a pre-clean step that makes one "usually" agree.
 *
 * Dormant when `sharedPackages` is empty. As of `open-issue.ts`'s
 * `readSharedPackages`, that only happens on a repo with no `packages/*`
 * workspace member, none of the built-in cross-cutting defaults present, and
 * no `vinaya.config.json` `blastRadius.extraDomains` — a genuinely edge-case
 * repo, not the common "adopter never wrote the file" case this dormancy
 * used to hide. This function itself stays source-blind —
 * it takes the resolved list, never reads disk — the same
 * seam-is-dormant-when-absent shape `doc-owners` uses. The check cannot be
 * deterministic without its source of truth, and inventing one inline is worse
 * than not running.
 */
export function checkBlastRadiusScope(
  body: string,
  _labels: string[],
  sharedPackages: string[],
  projectPaths: ProjectPath[]
): IssueSectionResult {
  if (sharedPackages.length === 0) return { status: 'pass', errors: [] }
  // Scoped to the two fields that declare the task's OWN surface. Scanning the
  // whole body fails correct plans in bulk: a rationale names packages for many
  // reasons that are not edits — a dependency it imports unchanged (#591/#599
  // name `packages/aeg-core` because Vinaya's CLI imports it), a trap to avoid,
  // an Origin note. A full-body scan flagged 46 of 166 historical task Issues,
  // nearly all of them correctly-scoped work. Boundary and Project(s) + blast
  // radius are where a task states what it touches, so that is where a
  // touch-claim is load-bearing enough to block on.
  const text = [
    rationaleFieldText(PATH_TEXT(body), 'Boundary'),
    rationaleFieldText(PATH_TEXT(body), 'Project\\(s\\)|Project(?:s)?\\s*\\+|blast radius')
  ].join('\n')
  const named = sharedPackages.filter((d) => namesPath(text, d))
  if (named.length === 0) return { status: 'pass', errors: [] }

  // Registry-validated, not merely declared. The bypass below widens the review
  // fan-out on the Planner's word that a second project reviews the change — a
  // name with no row in `.vinaya/projects.md` buys no lens, so it cannot buy the
  // bypass either. Found live on a draft plan declaring three names, one of them
  // fictional: it cleared the bypass and this check never ran.
  const registered = new Set(projectPaths.map((p) => p.name.trim()))
  const declared = projectsFromBody(body)
  const projects = declared.filter((p) => registered.has(p))
  const ownedPaths = projectPaths.filter((p) => projects.includes(p.name)).map((p) => p.path.replace(/\/+$/, ''))
  const unowned = named.filter((d) => !ownedPaths.some((owned) => d === owned || d.startsWith(`${owned}/`)))
  if (unowned.length === 0) return { status: 'pass', errors: [] }
  if (projects.length > 1) return { status: 'pass', errors: [] }
  // The ack is looked for in the WHOLE body, not the scoped surface fields — it
  // is a deliberate statement about the task, and a Planner may reasonably put
  // it under Stop-and-escalate or Traps rather than inside Boundary.
  if (BLAST_RADIUS_ACK_RE.test(PATH_TEXT(body))) return { status: 'pass', errors: [] }

  // Name the dropped names. Without this the message reads "a single project"
  // at an author looking at three, and the real fix (register the name, or use
  // the registered one) is invisible from here.
  const unregistered = declared.filter((p) => !registered.has(p))
  return {
    status: 'fail',
    errors: [
      `issue-validation blast radius: the rationale names ${unowned.join(', ')} — a shared collision domain no declared project (${projects.join(', ') || 'none'}) owns — but declares a single registered project and no \`blast-radius-ack:\` line.${unregistered.length > 0 ? ` Not counted: ${unregistered.join(', ')} — no row in \`.vinaya/projects.md\`, so it adds no review lens.` : ''} Project(s) drives the review fan-out (.vinaya/projects.md); list every consumer in the blast radius, or add \`blast-radius-ack: <why one lens is enough>\`.`
    ]
  }
}

/**
 * Headings/fields that belong to a **brief**, never to an Issue. Brief-authoring
 * is explicit that a brief is never put in the task's forge Issue — it would go
 * stale before work starts, and then two artifacts disagree about the same task
 * with nothing to arbitrate them.
 */
const BRIEF_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: '## References', pattern: /(?:^#{1,6}\s*|\*\*)\s*References\b/im },
  { name: 'Technical surface map', pattern: /(?:^#{1,6}\s*|\*\*)\s*Technical surface map\b/im },
  { name: 'Premise', pattern: /(?:^#{1,6}\s*|\*\*)\s*Premise(?:\*\*)?\s*[:—–]/im },
  { name: 'Step 0', pattern: /(?:^#{1,6}\s*|\*\*)\s*Step 0\b/im },
  { name: 'Test Plan', pattern: /(?:^#{1,6}\s*|\*\*)\s*Test Plan\b/im }
]

/**
 * **B — brief content in the Issue.** Fails when the code-stripped body carries
 * a brief-shaped heading. The Issue is the Planner's durable rationale; the
 * brief is the Brief Author's just-in-time execution context, authored against
 * the surface as it exists at dispatch. Copying the second into the first
 * creates a stale copy nobody re-reads and nobody updates.
 */
export function checkNoBriefContent(body: string): IssueSectionResult {
  const text = stripCode(body)
  const errors = BRIEF_MARKERS.filter((m) => m.pattern.test(text)).map(
    (m) =>
      `issue-validation brief content: the Issue body carries a brief-shaped "${m.name}" section. Brief-time content (surface pointers, skills-to-read, premise, test plan) belongs in the brief, not the Issue — it goes stale before work starts (aeg-root/skills/brief-authoring/SKILL.md). Move it to the brief.`
  )
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}

/**
 * Slices one rationale field's prose: from its label to the next bold/heading
 * field or the end. Tolerates both live styles, exactly like
 * `hasRationaleField`.
 */
function rationaleFieldText(text: string, labelPattern: string): string {
  // `labelPattern` is grouped. Ungrouped, its own `|` splits the WHOLE regex
  // instead of just the label — `Docs to keep coherent|§7` compiled as
  // "(**|#) Docs to keep coherent" OR "§7[^\n]*…", so the Docs branch matched
  // the bare label and captured nothing, and D silently graded every Issue on
  // its Traps field alone (#622 failed on exactly this).
  // The terminator is `(?![\s\S])` — a real end-of-INPUT assertion — not `$`.
  // The `m` flag is required for the `^#{1,4}` heading form, and under `m` a
  // `$` matches end-of-LINE, so the lazy body satisfied the lookahead
  // immediately and every heading-style field (`### §7`, #219) sliced to its
  // own label with zero content. D then saw an empty field and failed Issues
  // that name their docs perfectly well, one line further down.
  const re = new RegExp(
    `(?:\\*\\*|^#{1,4}\\s+)\\s*(?:${labelPattern})[^\\n]*\\n?([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*[A-Z]|#{1,4}\\s)|(?![\\s\\S]))`,
    'im'
  )
  const m = re.exec(text)
  return m ? m[0] : ''
}

/**
 * Concrete doc surfaces — the artifact of having actually read the surface, not
 * a paraphrase of it.
 *
 * Deliberately generous about *shape*, strict about *concreteness*. A first,
 * narrower version (only `aeg-root/…`, `.claude/skills/…`, `apps/<x>/CLAUDE.md`,
 * `apps/<x>/specs/…`) failed 66 of 166 historical task Issues, and the samples
 * were not agents skipping the read — they were real docs written in shapes the
 * pattern did not enumerate: `.claude/rules/ui-patterns.md` (rules, not
 * skills), a bare `docs-index.md`, `packages/<x>/README.md`. Each omission would
 * have blocked a correct plan. So: any repo-rooted `.md`/`.mdx` path, any
 * `.claude/**` doc, and the handful of bare filenames that are unambiguous
 * repo-level documents. What it still refuses is the actual failure — a field
 * that names no document at all.
 */
const DOC_PATH_RE =
  /(?:(?:aeg-root|apps|packages|specs|docs|tools|\.claude|\.github)\/[\w./@-]*\.(?:md|mdx)|\.claude\/(?:skills|rules)\/[\w./-]+|\b(?:docs-index|decisions|projects|state-machine|enforcement|process|README|CLAUDE)\.md\b|\b[\w-]+-(?:spec|decisions|backlog)\.md\b)/i

/**
 * The doc-less-surface exemption, shaped after `brief-validation`'s
 * `Test Plan: unit-tests-only` sentinel: an explicit, greppable opt-out a human
 * chose, never an empty field that merely looks like one. "Docs to keep
 * coherent: none" is what an agent writes when it did not look; the sentinel is
 * what a Planner writes when it looked and there was nothing.
 */
const NO_DOC_SURFACE_RE = /(?:\*\*)?\s*no-doc-surface/i

/**
 * **D — no read-obligation signal.** The root cause of A and B both: nothing
 * forced the Planner to read the docs and skills governing the surface it was
 * planning, because the skill-check hook fires on file edits and cutting an
 * Issue edits no file. Requiring a concrete doc path in `Docs to keep coherent`
 * / `Traps to avoid` makes the read leave an artifact — you cannot name
 * `.claude/skills/ui-library-system/SKILL.md` as the design anchor without
 * having gone looking for it.
 *
 * Presence-only, like the rest of this module: whether the named doc is the
 * *right* one stays a judgment call for review. That it exists at all does not.
 */
export function checkRationaleNamesDocs(body: string): IssueSectionResult {
  const text = PATH_TEXT(body)
  const scope = [rationaleFieldText(text, 'Docs to keep coherent|§7'), rationaleFieldText(text, 'Traps')].join('\n')
  if (NO_DOC_SURFACE_RE.test(scope)) return { status: 'pass', errors: [] }
  if (DOC_PATH_RE.test(scope)) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      'issue-validation docs read: neither "Docs to keep coherent" nor "Traps to avoid" names a concrete doc path (aeg-root/…, .claude/skills/…, apps/*/CLAUDE.md, apps/*/specs/…). Naming one is the artifact of having read the surface being planned — the forge write triggers no skill-check hook, so this field is the only read-obligation signal. For a genuinely doc-less surface, write the explicit `no-doc-surface` sentinel.'
    ]
  }
}

/** One open task Issue, reduced to what the conflict-completeness warning needs. */
export type TaskIssueFacts = {
  /** How the Issue is referred to in a `Conflicts-with` edge — its number, or its task id. */
  ref: string
  body: string
  /** Already-parsed `Conflicts-with` ids (`parseRationaleDeps`) — never re-parsed here. */
  conflictsWith: string[]
}

/** True when either side's declared edges name the other — `#621`, `621` and `8` all count. */
function edgesNameEachOther(a: TaskIssueFacts, b: TaskIssueFacts): boolean {
  const norm = (s: string) => s.replace(/^#/, '').trim()
  return a.conflictsWith.map(norm).includes(norm(b.ref)) || b.conflictsWith.map(norm).includes(norm(a.ref))
}

/**
 * **C — conflict completeness. WARN-ONLY, by construction.** Two open task
 * Issues naming the same collision domain and declaring no mutual
 * `Conflicts-with` edge are *probably* a missed serialization — but an Issue
 * does not declare a precise file surface, so "names the same domain" is a
 * hint, not a fact. Failing on a hint would make the gate refuse correct plans,
 * so this prints and never blocks. It is also why AEG's conflict rule is
 * declared-and-static in the first place: a real answer needs a live
 * task→changed-files map, the mutable state the model eliminates
 * (`tranche-model.md` §5).
 */
export function checkConflictCompleteness(
  subject: TaskIssueFacts,
  siblings: TaskIssueFacts[],
  sharedPackages: string[]
): string[] {
  if (sharedPackages.length === 0) return []
  const domainsOf = (facts: TaskIssueFacts) => {
    const text = PATH_TEXT(facts.body)
    return sharedPackages.filter((d) => namesPath(text, d))
  }
  const mine = domainsOf(subject)
  if (mine.length === 0) return []
  const warnings: string[] = []
  for (const sibling of siblings) {
    if (sibling.ref === subject.ref) continue
    const shared = domainsOf(sibling).filter((d) => mine.includes(d))
    if (shared.length === 0) continue
    if (edgesNameEachOther(subject, sibling)) continue
    warnings.push(
      `issue-validation conflict completeness: this Issue and ${sibling.ref} both name ${shared.join(', ')} but neither declares the other in Conflicts-with. If they can run in parallel, say so; otherwise declare the edge (aeg-root/tranche-model.md §5).`
    )
  }
  return warnings
}
