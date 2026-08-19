import type { Task, TaskIssueRef } from '@attalabs/aeg-types'
import { type GhIssue, ghIssueListByAnyLabel, ghIssueListByAnyLabelAsync } from './gh'
import { findTrancheSlug, trancheLabel } from './labels'
import { parseRationaleDeps } from './parse-rationale-deps'
import { hasUnterminatedFence, stripCode } from './strip-code'

/** Issue title convention: `[<tranche-slug>] <task-id> — <title>`, the same
 * shape every Vinaya Issue is opened with (`open-issue.ts`, brief-authoring). */
export const TITLE_PATTERN = /^\[([^\]]+)]\s*(\S+)\s*—\s*(.+)$/

/** Reads the `**Project:**` field from a task Issue's rationale body (the
 * Planner-rationale grammar). Project is a **field, not a label** (doctrine): `state-machine-v1`
 * task 2 / #614 dropped the `project:*` labels outright, so the field is the
 * only source. It also resolves a forge-native task Issue that carries only the
 * field and never got a label (the `state-machine-v1` dead-board case). Matches
 * the bold field line only; the prose `**Project(s) + blast radius**` heading
 * and a backticked inline `Project: x` never match (no `:**` right after).
 *
 * Values are shape-guarded, not registry-checked: the field is free prose and
 * authors write real sentences in it (#554: `**Project:** (none — tools/admin
 * is unregistered; …)`), which without a guard becomes a "project" that builds
 * a 404 board link — strictly worse than the board-less row it replaces. The
 * guard stays a slug shape rather than a registry lookup on purpose: this
 * package is pure, repo-parameterized forge derivation and must not couple to
 * `.vinaya`. An unregistered-but-slug-shaped value still resolves
 * here; that is the registry's problem to report, not this parser's.
 *
 * The guard **rejects, it no longer discards**: a value failing this shape is
 * reported on `ProjectField.unparsed` rather than dropped, because a drop left
 * the registry gate unable to tell an unparseable declaration from no
 * declaration and passing vacuously on both. It is applied AFTER `unwrapValue`,
 * so the markup and sentence punctuation prose wraps a real name in
 * (`` `vinaya` ``, `**vinaya**`, `notaproject.`) no longer costs that name its
 * shape — those were valid declarations the guard was never aimed at. */
// Exported so a consumer that needs to tell a real project name apart from
// smuggled prose in the SAME comma-separated `Project:` value — `body-bare-digits`,
// which must exempt only a real name's own span, not whatever a claim
// disguised as an extra comma-separated "name" might carry — reuses this
// one validated shape rather than a second regex that could drift from it.
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/i

/**
 * The field line, in either markup the corpus actually uses: the bold
 * `**Project:** x` the templates emit, and the plain `Project: x` header line
 * older Issues were authored with (an entire early cohort, plus the fixtures
 * derived from it). Accepting only the bold form made this
 * parser disagree with `issue-validation.ts`'s `declaredProjects`, which has
 * always been tolerant — and once #614 deleted the `project:*` labels, that
 * disagreement silently dropped the project of every plain-form Issue.
 *
 * The optional `**` are matched independently on each side rather than as a
 * required pair, which is what keeps the prose heading `**Project(s) + blast
 * radius**` out: nothing there puts a `:` straight after the name.
 *
 * Line-anchored, first-match-wins, and deliberately un-global — which is why it
 * must never be run against a raw body. See `projectFieldFromBody`: the first
 * field-shaped line in a raw body is routinely a fenced *example* of the field,
 * and the real declaration sits at the foot by convention.
 *
 * **Every whitespace run in this pattern — the leading one as well as those
 * around the colon and `**` — is `\s*`, and MUST stay `\s*`: this is the
 * field's grammar, not an implementation detail.** A revert that restored
 * only the internal runs left the leading one narrowed, so a field line
 * prefixed by a non-breaking space, form feed or vertical tab still went
 * `declared: false` with the gate passing, while `declaredProjects` read the
 * name — the same silent drop, one character class over.
 * GitHub renders `Project:\nvinaya` as the single paragraph "Project: vinaya",
 * and the tolerant-plain-form cohort the docstring above names is written
 * exactly this way; `\s*` (which matches `\n`) is what lets the value sit on
 * the line after the label. An attempt to narrow these runs to `[ \t]*`
 * removed a ReDoS class (measured: 705 ms → 0.02 ms on a crafted body) and was
 * reverted: it silently dropped the
 * plain next-line form to `declared: false` and made the bold next-line form
 * fail with a false "the field is empty" message — the same silent-drop and
 * vacuous-fail-open classes this whole task exists to close. The `Project:`
 * field's grammar is explicitly NOT in this task's scope; the perf work
 * belongs in its own task, constrained to prove — with a shape corpus
 * (plain/bold × same-line/next-line × leading whitespace), not a timing
 * number — that it does not narrow which shapes the field accepts.
 */
const PROJECT_FIELD = /^\s*(?:\*\*)?Project(?:\(s\))?(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im

/**
 * What the body's `Project:` field says — including when it says something this
 * parser cannot turn into a name.
 *
 * `declared` answers "is there a `Project:` field at all", which is the
 * distinction the bare `string[]` return could never express: an empty
 * `names` was indistinguishable from an absent field, so a consumer could not
 * tell "this task legitimately declares no project" from "this task declared
 * something and the parser dropped it". A registry gate reading only `names`
 * therefore passes **vacuously** on a value it never received — it cannot
 * refuse a name that was filtered away before it arrived. The instance that
 * made this concrete: #104 named its project only in the `Project(s) + blast
 * radius` prose heading, which this parser deliberately does not read, so no
 * gate fired on it and it sat invisible until someone counted the corpus by
 * hand. (#104 has carried a real field since the #112 registry migration; the
 * defect class is what this type exists for, not that one Issue.)
 *
 * `unparsed` carries those dropped values verbatim (comma-split, trimmed) so a
 * caller can report what it could not check. It is deliberately raw and
 * deliberately not acted on here: turning a value into a name is this parser's
 * job, and deciding what an uncheckable declaration means is the gate's.
 */
export type ProjectField = {
  /** A `Project:` field line exists outside code. Says nothing about whether its value parsed. */
  declared: boolean
  /** Slug-shaped names, de-duplicated, in declaration order. What consumers resolve. */
  names: string[]
  /** Declared values that yielded no name — the residue no consumer can check. */
  unparsed: string[]
  /**
   * The body's fences do not balance, so an unterminated fence swallowed the
   * region the field lives in and this read cannot be trusted. Distinct from
   * every other state on purpose: "absent" and "unreadable" are the conflation
   * that let a malformed body pass a gate the readable version of it failed.
   */
  unreadable: boolean
}

/**
 * Trims the markup and sentence punctuation a field value carries in prose —
 * the value is routinely written as "`Project: vinaya`." (backticked, with the
 * sentence's full stop inside the span, which the span-preserving strip keeps)
 * or as `**Project:** **vinaya**`. Without this, each of those wrappers made an
 * otherwise-valid name fail the slug shape and vanish, so the registry check
 * could not refuse an unregistered `notaproject.` and passed vacuously on a
 * fully-wrapped one.
 *
 * The peel is **anchored to the value's ends**, not applied body-wide. Deleting
 * `.` and `;` wherever they appeared let `v.i.n.a.y.a` and `vin;aya` collapse
 * onto the registered `vinaya`, so a body could read to a human as one thing
 * and resolve, for the gate AND for `Task.projects`, as a registered project.
 * Interior punctuation now leaves the value non-slug, which reports it as
 * residue — the honest answer.
 *
 * `issue-validation.ts`'s `declaredProjects` peels the same character SET, and
 * that much the two share. They are not otherwise interchangeable and this
 * function does not pretend they are: `declaredProjects` splits on `/[,/]/` and
 * DROPS a non-slug segment, while this one splits on `,` (the documented
 * grammar) and REPORTS it. On `**Project:** vinaya / aeg-core` they disagree by
 * construction. The shared peel set is what keeps a wrapper from costing a real
 * name its shape in one reader and not the other — the drift that silently
 * dropped the project of every plain-form Issue once before; it is not a claim
 * that the two functions agree in general.
 */
const VALUE_EDGE_MARKUP = /^[`.;\s]+|[`.;\s]+$/g

/** Exported alongside `PROJECT_SLUG` — the slug check is only meaningful applied AFTER this peel, same as `parseFieldValue` applies it. */
export function unwrapValue(raw: string): string {
  return raw.replace(/\*\*/g, '').replace(VALUE_EDGE_MARKUP, '')
}

/**
 * The `Project:` field, read from the body **minus its examples**.
 *
 * Reads `stripCode(body, { inlineSpans: 'keep' })` rather than the raw body.
 * `PROJECT_FIELD` is line-anchored, first-match-wins and un-global, so against a
 * raw body it takes the first field-shaped line ANYWHERE — including one inside
 * a fenced code block. The real declaration sits at the body's foot by
 * convention, so any earlier fenced example outranked it, and both consumers
 * inherited the wrong answer in agreement: a rationale that *documents* the
 * field's shape had its own documentation parsed as its declaration. A `Project`
 * line inside a fence is an example, not a declaration.
 *
 * Inline spans are KEPT (`'keep'`), not stripped: prose writes the value in
 * backticks by convention ("`Project: vinaya`"), so a span-blind read finds
 * nothing on the very bodies this must parse. `unwrapValue` peels the backticks
 * off the captured value instead. This is the same reading, through the same
 * stripper, that `issue-validation.ts`'s `PATH_TEXT` already uses — `stripCode`
 * moved down to `strip-code.ts` so both share one implementation rather than
 * two regexes that agree today.
 */
export function projectFieldFromBody(body: string): ProjectField {
  const m = stripCode(body, { inlineSpans: 'keep' }).match(PROJECT_FIELD)
  if (m) return parseFieldValue(m[1] ?? '')

  // No field OUTSIDE code. Two very different reasons, and collapsing them is
  // the same fail-open this function exists to close, one layer in:
  //
  //   - the body genuinely declares none, or declares one only inside a
  //     BALANCED fence (an example, not a declaration) — absent, and a pass;
  //   - an UNTERMINATED fence ran to end of body and swallowed the rest,
  //     including the foot where the real declaration lives by convention.
  //
  // In the second case the reader is blind, not looking at an empty page. A
  // body with unbalanced fences is malformed — GitHub renders its tail as code
  // too — so the honest answer is "a field is there and this read of it cannot
  // be trusted": declared, with the value as residue, which fails the gate
  // closed and names what it could not check. Reported rather than parsed,
  // because inside the swallowed region a quoted example and a real
  // declaration are genuinely indistinguishable — and unlike `Closes #N`,
  // there is no GitHub behaviour to match here. This system is the only
  // reader, so the safe direction is fail-closed, not pass.
  if (hasUnterminatedFence(body)) {
    const raw = body.match(PROJECT_FIELD)
    if (raw) return { declared: true, names: [], unparsed: [(raw[1] ?? '').trim()], unreadable: true }
  }
  return { declared: false, names: [], unparsed: [], unreadable: false }
}

/** Splits one captured field value into resolved names and the residue that yielded none. */
function parseFieldValue(value: string): ProjectField {
  const names: string[] = []
  const unparsed: string[] = []
  for (const raw of value.split(',')) {
    const name = unwrapValue(raw)
    if (name.length === 0) continue
    if (PROJECT_SLUG.test(name)) names.push(name)
    else unparsed.push(raw.trim())
  }
  return { declared: true, names: [...new Set(names)], unparsed, unreadable: false }
}

/**
 * The declared project names, and only those — the `Task.projects` shape every
 * consumer already reads. Signature-identical to its pre-fence-fix form on
 * purpose: `checkProjectsRegistered` (the gate) and the Studio board derivation
 * both call it, and a change that moved one of them and not the other would
 * create the gate/board disagreement the shared parser exists to prevent.
 *
 * Use `projectFieldFromBody` when `[]` needs to be told apart from "declared
 * but unparseable" — this function cannot express the difference.
 */
export function projectsFromBody(body: string): string[] {
  return projectFieldFromBody(body).names
}

function taskFromIssue(issue: GhIssue): Task | null {
  const m = issue.title.match(TITLE_PATTERN)
  if (!m) return null
  const id = (m[2] ?? '').trim()
  const title = (m[3] ?? '').trim()
  if (!id || !title) return null
  const body = issue.body ?? ''
  const { dependsOn, conflictsWith } = parseRationaleDeps(body)
  return {
    id,
    title,
    issue: issue.number,
    projects: projectsFromBody(body),
    dependsOn,
    conflictsWith,
    rationaleMarkdown: body
  }
}

/** Numeric-then-alpha ordering so suffixed ids (`7a`, `7b`) sort right after
 * their base id, matching the topology table's natural row order. */
function compareTaskIds(a: string, b: string): number {
  const numA = a.match(/^(\d+)(.*)$/)
  const numB = b.match(/^(\d+)(.*)$/)
  if (numA && numB) {
    const diff = Number(numA[1]) - Number(numB[1])
    if (diff !== 0) return diff
    return (numA[2] ?? '').localeCompare(numB[2] ?? '')
  }
  return a.localeCompare(b)
}

/** Shared `GhIssue[] → Task[]` transform (`taskFromIssue` map + `compareTaskIds`
 * sort), the single source both the sync and async list functions call so the
 * two can never derive a different task list.
 *
 * Exported so a caller that has ALREADY fetched a slug's labeled Issues (see
 * `fetchTrancheIssuesAsync`) can derive the task list without paying a second
 * identical `gh issue list` — the pure half of `listTasksForSlug`, split out
 * rather than reimplemented, so the two can still never disagree. */
export function tasksFromIssues(issues: GhIssue[]): Task[] {
  const tasks: Task[] = []
  for (const issue of issues) {
    const task = taskFromIssue(issue)
    if (task) tasks.push(task)
  }
  return tasks.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** Lists `vinaya/tranche:<slug>`-labeled Issues and builds the `Task[]` for
 * that tranche. Issue title's bracketed slug is not re-validated against
 * `slug` — the `vinaya/tranche:<slug>` label is the authoritative membership
 * signal; a title typo should not silently drop a real task. */
export function listTasksForSlug(owner: string, repo: string, slug: string): Task[] {
  return tasksFromIssues(ghIssueListByAnyLabel(owner, repo, [trancheLabel(slug)]))
}

/** Async twin of `listTasksForSlug` — non-blocking `gh` exec, same transform. */
export async function listTasksForSlugAsync(owner: string, repo: string, slug: string): Promise<Task[]> {
  return tasksFromIssues(await fetchTrancheIssuesAsync(owner, repo, slug))
}

/**
 * The raw `vinaya/tranche:<slug>`-labeled Issue list — the ONE fetch that
 * `tasksFromIssues` (the task list) and `issueMilestonesFromIssues` (L4's
 * Milestone-attachment facts) both derive from.
 *
 * Both derivations previously ran their own copy of this identical query, so
 * a caller needing both paid two round trips per slug (measured: 6.4 s + 6.9 s
 * across 6 tranches in `verify-coherence.ts`'s sweep). Fetch once, derive
 * twice. `--state all` and the `--json` field set are `gh.ts`'s single arg
 * vector, so what comes back here is byte-identical to what either wrapper
 * fetched before.
 */
export async function fetchTrancheIssuesAsync(owner: string, repo: string, slug: string): Promise<GhIssue[]> {
  return ghIssueListByAnyLabelAsync(owner, repo, [trancheLabel(slug)])
}

/**
 * Resolves an arbitrary Issue's title + labels to its Vinaya task identity, if
 * it has one — the REVERSE of `taskFromIssue`/`listTasksForSlug` (those start
 * from a known tranche slug and list its tasks; this starts from an
 * unknown Issue and asks "is this a task Issue, and if so which task?").
 *
 * Same authoritative-signal discipline as `listTasksForSlug`'s doc comment:
 * the `vinaya/tranche:<slug>` label — not the title's bracketed text — is the
 * slug source. The title only needs to match the `[<slug>] <id> — ...`
 * shape closely enough to yield a task id; a bracket/label slug mismatch
 * (title typo) doesn't invalidate the label's membership signal.
 *
 * Used by `checkClosesN`'s reverse-direction check (Layer 1 reverse,
 * `@attalabs/aeg-core`'s `coherence-checks.ts`).
 */
export function resolveTaskIssueRef(title: string, labels: string[]): TaskIssueRef | null {
  const m = title.match(TITLE_PATTERN)
  if (!m) return null
  const taskId = (m[2] ?? '').trim()
  if (!taskId) return null
  const trancheSlug = findTrancheSlug(labels)
  if (!trancheSlug) return null
  return { trancheSlug, taskId }
}
