import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FrozenBriefCandidate,
  type Objective,
  objectivesOf,
  objectivesVersion,
  parseIssueParts,
  renderObjectives,
  resolveNewestFrozenBrief
} from '@attalabs/aeg-core'
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config.js'
import { prepareIssueTask, prepareTask } from '../lib/dispatch-task.js'
import { printJson } from '../lib/envelope'
import {
  countMarkerComments,
  locateBody,
  makeCheckError,
  postMarkedComment,
  refuse,
  refuseUnlessPrincipal,
  writeValidatedIssueEdit
} from '../lib/forge-write'

const RETRY =
  'vinaya issue objectives edit <n> --add "<sentence>" | --drop O<k> | --replace O<k> "<sentence>" --reason "<text>"'
const MARKER_PREFIX = '<!-- aeg:objectives:v'

type EditOp =
  | { kind: 'add'; sentence: string }
  | { kind: 'drop'; id: string }
  | { kind: 'replace'; id: string; sentence: string }

/**
 * The same `## Objectives` heading/next-heading boundary `objectivesOf`
 * itself locates (that scanner is internal to `packages/aeg-core`, never
 * exported — the parsed `Objective[]` list is the public surface, not the
 * raw span). Re-deriving the SAME regex here only decides where to splice
 * text back in; it never re-implements the grammar `objectivesOf` already
 * validated.
 */
const HEADING_RE = /^##[ \t]*Objectives[ \t]*$/im
const NEXT_HEADING_RE = /^##[ \t]/m

/**
 * Replaces the `## Objectives` section (heading through the next `##`
 * heading, or end of body) with `renderedSection`, leaving every other byte
 * of `body` untouched — the before-heading and after-next-heading slices are
 * copied verbatim, never re-derived.
 */
export function spliceObjectivesSection(body: string, renderedSection: string): string {
  const heading = HEADING_RE.exec(body)
  if (!heading) {
    throw new Error(
      'spliceObjectivesSection: no `## Objectives` heading — caller must validate with objectivesOf first.'
    )
  }
  const before = body.slice(0, heading.index)
  const afterHeadingStart = heading.index + heading[0].length
  const afterHeading = body.slice(afterHeadingStart)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  if (!next) return `${before}${renderedSection}\n`
  const tail = afterHeading.slice(next.index)
  return `${before}${renderedSection}\n\n${tail}`
}

/** The body with its `## Objectives` section blanked out — used to assert the edit touched nothing else. */
export function withoutObjectivesSection(body: string): string {
  const heading = HEADING_RE.exec(body)
  if (!heading) return body
  const before = body.slice(0, heading.index)
  const afterHeadingStart = heading.index + heading[0].length
  const afterHeading = body.slice(afterHeadingStart)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  return next ? before + afterHeading.slice(next.index) : before
}

const PARTS_HEADING_RE = /^##[ \t]*Parts[ \t]*$/im

/** `{ headingEnd, sectionEnd }` byte offsets of the `## Parts` section's own content (heading excluded, next `##` heading excluded) — `null` when there is no `## Parts` heading at all. */
function partsSectionBounds(body: string): { headingEnd: number; sectionEnd: number } | null {
  const heading = PARTS_HEADING_RE.exec(body)
  if (!heading) return null
  const headingEnd = heading.index + heading[0].length
  const afterHeading = body.slice(headingEnd)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  const sectionEnd = next ? headingEnd + next.index : body.length
  return { headingEnd, sectionEnd }
}

/**
 * Appends `partLine` as a new line at the end of the `## Parts` section —
 * `--add`'s own write, in the SAME edit as the Objectives change (O5).
 * Throws when there is no `## Parts` heading at all: a pre-cutover Issue
 * with no Parts section has no self-serve add path here — the same posture
 * the brief-sections cutover already takes for a Surface-less Issue.
 */
export function appendPartLine(body: string, partLine: string): string {
  const bounds = partsSectionBounds(body)
  if (!bounds) {
    throw new Error('appendPartLine: no `## Parts` heading in this Issue body — cannot add a Part.')
  }
  const before = body.slice(0, bounds.headingEnd)
  const section = body.slice(bounds.headingEnd, bounds.sectionEnd).replace(/\s+$/, '')
  const tail = body.slice(bounds.sectionEnd)
  return `${before}${section}\n${partLine}\n${tail}`
}

/**
 * Removes every `## Parts` line whose citation is EXACTLY `droppedId` (and
 * nothing else) — `--drop`'s own write (O5). A Part citing the dropped
 * objective alongside another is left untouched, unchanged from before this
 * edit: narrowing a multi-objective citation is out of this rule's scope. If
 * that leaves a Part citing an objective no longer defined,
 * `writeValidatedIssueEdit`'s own pre-existing `checkPartsCiteDefinedObjectives`
 * gate refuses the write naming the dangling citation — the Planner resolves
 * it by hand before the drop can proceed. A no-op when there is no
 * `## Parts` heading.
 */
export function removePartLinesCitingOnly(body: string, droppedId: string): string {
  const bounds = partsSectionBounds(body)
  if (!bounds) return body
  const droppedN = Number.parseInt(droppedId.replace(/^O/i, ''), 10)
  const before = body.slice(0, bounds.headingEnd)
  const section = body.slice(bounds.headingEnd, bounds.sectionEnd)
  const tail = body.slice(bounds.sectionEnd)
  const kept = section.split('\n').filter((line) => {
    const m = /^Part\s+\d+\s*\(([^)]*)\)\s*[-—–]/i.exec(line.trim())
    if (!m) return true
    const refs = [...(m[1] as string).matchAll(/O(\d+)/gi)].map((r) => Number.parseInt(r[1] as string, 10))
    return !(refs.length === 1 && refs[0] === droppedN)
  })
  return `${before}${kept.join('\n')}${tail}`
}

function formatList(objectives: Objective[]): string {
  return objectives.map((o) => `${o.id}. ${o.text}`).join('\n')
}

function parseArgs(args: string[]): { json: boolean; issueRef: string; op: EditOp; reason: string; part?: string } {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')

  const issueRef = rest[0]
  if (!issueRef || issueRef.startsWith('-')) {
    refuse([
      makeCheckError(
        'forge-args',
        '`issue objectives edit` requires the target Issue number as the first argument.',
        `Pass the Issue number, e.g. \`${RETRY}\`.`
      )
    ])
  }

  const ops: EditOp[] = []
  let reason: string | undefined
  let part: string | undefined
  const flagArgs = rest.slice(1)
  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i] as string
    if (a === '--add') {
      ops.push({ kind: 'add', sentence: flagArgs[++i] ?? '' })
    } else if (a === '--drop') {
      ops.push({ kind: 'drop', id: flagArgs[++i] ?? '' })
    } else if (a === '--replace') {
      const id = flagArgs[++i] ?? ''
      const sentence = flagArgs[++i] ?? ''
      ops.push({ kind: 'replace', id, sentence })
    } else if (a === '--reason') {
      reason = flagArgs[++i]
    } else if (a === '--part') {
      part = flagArgs[++i]
    }
  }

  if (ops.length !== 1) {
    refuse([
      makeCheckError(
        'forge-args',
        `\`issue objectives edit\` requires exactly one of --add, --drop, --replace (found ${ops.length}).`,
        `Pass exactly one edit flag, e.g. \`${RETRY}\`.`
      )
    ])
  }
  if (!reason || reason.trim().length === 0) {
    refuse([
      makeCheckError(
        'forge-args',
        '`issue objectives edit` requires a non-empty `--reason "<text>"`.',
        `Add \`--reason "<text>"\`, then re-run \`${RETRY}\`.`
      )
    ])
  }
  // Security review (Issue #502), round 2, HIGH: this same reason is later
  // handed to `prepareTask`'s own O6 supersede call, which refuses a
  // `\r`/`\n` reason for the header-corruption hazard `dispatch-task.ts`
  // documents at its own check. Checked here too, before ANY write, so a
  // bad reason never gets past the point where the Objectives comment has
  // already posted — `prepareTask`'s refusal would otherwise fire only
  // after that comment exists, leaving the Issue and its frozen brief
  // disagreeing with no disclosure.
  if (/[\r\n]/.test(reason as string)) {
    refuse([
      makeCheckError(
        'forge-args',
        "`--reason` must be a single line — it becomes one line of the frozen comment header this edit may supersede, and a newline in it would corrupt every reader's header-line count for that version.",
        `Remove the newline from --reason, then re-run \`${RETRY}\`.`
      )
    ])
  }

  // O5: `--add` without a `--part` would freeze an
  // objective no `## Parts` line ever cites — `checkPartsCiteDefinedObjectives`
  // stays silent about it (it only checks a citation names a REAL objective,
  // never the reverse), so a frozen brief re-issued after this edit would
  // simply omit the new objective from every Part with nothing to fail on.
  // Refused here, naming the rule, rather than discovered downstream.
  if (ops[0]?.kind === 'add' && (!part || part.trim().length === 0)) {
    refuse([
      makeCheckError(
        'objectives-part-required',
        '`--add` requires `--part "Part <n> (O<k>) — <outcome>"` for the objective it adds — an objective with no citing Part is never covered by a frozen brief re-issued after this edit.',
        `Pass --part "Part <n> (O<k>) — <outcome>", then re-run \`${RETRY}\`.`
      )
    ])
  }
  if (ops[0]?.kind !== 'add' && part !== undefined) {
    refuse([
      makeCheckError(
        'forge-args',
        '`--part` is only meaningful with `--add`.',
        `Remove --part, then re-run \`${RETRY}\`.`
      )
    ])
  }

  return { json, issueRef, op: ops[0] as EditOp, reason: reason as string, part }
}

/** A comment reduced to what both `countMarkerComments` (body only) and `resolveNewestFrozenBrief` (body + author, O6) need, plus its own URL to name in a superseding-brief context. */
type IssueComment = FrozenBriefCandidate & { url: string }

function fetchIssueBodyAndComments(issueRef: string): {
  number: number
  body: string
  title: string
  labels: string[]
  comments: IssueComment[]
} {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'number,body,title,labels,comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not fetch Issue ${issueRef} (\`gh issue view\`): ${err instanceof Error ? err.message : String(err)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY}\`.`
      )
    ])
  }
  try {
    const parsed = JSON.parse(out) as {
      number?: number
      body?: string
      title?: string
      labels?: Array<{ name: string }>
      comments?: Array<{ body: string; url: string; author: { login: string } | null }>
    }
    return {
      number: parsed.number ?? Number.NaN,
      body: parsed.body ?? '',
      title: parsed.title ?? '',
      labels: (parsed.labels ?? []).map((l) => l.name),
      comments: (parsed.comments ?? []).map((c) => ({ body: c.body, url: c.url, author: c.author?.login ?? null }))
    }
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh issue view ${issueRef} --json number,body,title,labels,comments\` output.`,
        `Re-run \`${RETRY}\`.`
      )
    ])
  }
}

function applyOp(previous: Objective[], op: EditOp): Objective[] {
  if (op.kind === 'add') {
    if (op.sentence.trim().length === 0) {
      refuse([
        makeCheckError(
          'objectives-args',
          '`--add` requires a non-empty sentence.',
          `Pass a sentence, then re-run \`${RETRY}\`.`
        )
      ])
    }
    const maxN = previous.reduce((m, o) => Math.max(m, Number.parseInt(o.id.slice(1), 10)), 0)
    return [...previous, { id: `O${maxN + 1}`, text: op.sentence }]
  }

  const idx = previous.findIndex((o) => o.id === op.id)
  if (idx === -1) {
    refuse([
      makeCheckError(
        'objectives-args',
        `${op.id} does not exist in the current Objectives list.`,
        `Check the current list, then re-run \`${RETRY}\` with an existing id.`
      )
    ])
  }

  if (op.kind === 'replace') {
    if (op.sentence.trim().length === 0) {
      refuse([
        makeCheckError(
          'objectives-args',
          '`--replace` requires a non-empty sentence.',
          `Pass a sentence, then re-run \`${RETRY}\`.`
        )
      ])
    }
    return previous.map((o, i) => (i === idx ? { id: o.id, text: op.sentence } : o))
  }

  // --drop: remove the line, never renumber the survivors. If the parser then
  // refuses the result (a real numbering gap), that is a live contradiction
  // between the rationale's never-renumber rule and `objectivesOf`'s
  // contiguous-from-O1 grammar — report it verbatim and stop; do not change
  // `objectives.ts` to paper over it (§10).
  const dropped = previous.filter((o) => o.id !== op.id)
  const check = objectivesOf(renderObjectives(dropped))
  if (!check.ok) {
    refuse([
      makeCheckError(
        'objectives-drop-contiguity',
        `${check.errors.join(' ')} Dropping ${op.id} never renumbers the surviving objectives, but the result no longer parses — the Principal must rule on this contradiction (contiguous-from-O1 grammar vs. never-renumber rationale) before this drop can proceed.`,
        'Escalate to the Principal; do not change `objectives.ts`.'
      )
    ])
  }
  return dropped
}

export async function issueObjectivesEditCommand(args: string[]): Promise<void> {
  const { json, issueRef, op, reason, part } = parseArgs(args)
  refuseUnlessPrincipal(RETRY)

  const { number, body, title, labels, comments } = fetchIssueBodyAndComments(issueRef)
  const parsed = objectivesOf(body)
  if (!parsed.ok) {
    refuse([
      makeCheckError(
        'objectives-parse',
        `Issue ${issueRef}'s \`## Objectives\` section does not parse: ${parsed.errors.join(' ')}`,
        "Fix the Issue body's Objectives section by hand, then retry."
      )
    ])
  }
  const previous = parsed.objectives

  const updated = applyOp(previous, op)
  const objectivesBody = spliceObjectivesSection(body, renderObjectives(updated))

  // O5: `--add` writes its `--part` line into `## Parts`
  // in this SAME edit, so a frozen brief re-issued right after this command
  // always passes `checkObjectivesCoverage`/`checkPartsCiteDefinedObjectives`
  // — never a two-step "edit Objectives, then remember to edit Parts too."
  // `--drop` removes the Part lines that cited only the dropped objective.
  let finalBody = objectivesBody
  if (op.kind === 'add') {
    finalBody = appendPartLine(finalBody, part as string)
    const reparsedParts = parseIssueParts(finalBody)
    if (!reparsedParts.ok) {
      refuse([
        makeCheckError(
          'objectives-part-malformed',
          `--part "${part}" produced a malformed \`## Parts\` section: ${reparsedParts.errors.join(' ')}`,
          `Fix --part to match \`Part <n> (O<k>) — <outcome>\`, then re-run \`${RETRY}\`.`
        )
      ])
    }
    const addedId = (updated[updated.length - 1] as Objective).id
    const addedN = Number.parseInt(addedId.slice(1), 10)
    if (!reparsedParts.value.some((p) => p.objectiveIds.includes(addedN))) {
      refuse([
        makeCheckError(
          'objectives-part-mismatch',
          `--part "${part}" does not cite ${addedId}, the objective this --add just created.`,
          `Pass --part "Part <n> (${addedId}) — <outcome>", then re-run \`${RETRY}\`.`
        )
      ])
    }
  } else if (op.kind === 'drop') {
    finalBody = removePartLinesCitingOnly(finalBody, op.id)
  }

  const dir = mkdtempSync(join(tmpdir(), 'vinaya-objectives-edit-'))
  const tmp = join(dir, 'body.md')
  writeFileSync(tmp, finalBody, 'utf8')
  try {
    const ghArgs = ['--body-file', tmp]
    await writeValidatedIssueEdit({
      issueRef,
      ghArgs,
      bodyResult: locateBody(ghArgs),
      json: false,
      retryCommand: RETRY,
      quiet: true,
      // This command IS the sanctioned Objectives-change path O3 names as
      // its own escape hatch — `## Parts` is also rewritten here, in the
      // same edit, per O5 above — and it posts its own superseding
      // `aeg:brief:v<k+1>` comment below (O6) rather than being refused by
      // the gate it is the sanctioned alternative to.
      skipFrozenSectionsCheck: true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const newVersion = objectivesVersion(updated)

  // O3/O6 — if this task's brief is already frozen, the Objectives edit
  // above just moved the Issue and the frozen brief out of agreement (the
  // frozen comment still shows the OLD list). Resolve and post the
  // superseding brief BEFORE this edit's own audit comment below — never
  // after — so a failure here (this task's brief-render path, not merely a
  // missing tranche identity) leaves no objectives comment behind at all.
  // A tranche-labeled Issue supersedes through `prepareTask`; a backlog
  // Issue (no tranche identity at all — `resolveTaskIssueRef` returns
  // `null`) supersedes through the same `--issue` path `task brief --issue`
  // already uses (`prepareIssueTask`), never refused for lack of a tranche
  // label. Dormant when the brief was never frozen — nothing to supersede
  // yet.
  let supersedeUrl: string | null = null
  const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  const frozen = resolveNewestFrozenBrief(comments, allowlist)
  if (frozen !== null) {
    const taskRef = resolveTaskIssueRef(title, labels)
    const result =
      taskRef !== null
        ? await prepareTask({
            tranche: taskRef.trancheSlug,
            n: Number.parseInt(taskRef.taskId, 10),
            supersede: { reason }
          })
        : await prepareIssueTask({ issue: number, supersede: { reason } })
    supersedeUrl = result.commentUrl
  }

  const k =
    countMarkerComments(
      comments.map((c) => c.body),
      MARKER_PREFIX
    ) + 1
  const marker = `${MARKER_PREFIX}${k} -->`
  const commentBody = [
    'Previous:',
    formatList(previous),
    '',
    'Now:',
    formatList(updated),
    '',
    `Reason: ${reason}`,
    `Version: ${newVersion}`
  ].join('\n')
  const url = postMarkedComment('issue', issueRef, marker, commentBody)

  if (json) printJson({ written: true, version: newVersion, url, supersedeUrl })
  else {
    process.stdout.write(`${url}\n`)
    if (supersedeUrl) process.stdout.write(`${supersedeUrl}\n`)
  }
}
