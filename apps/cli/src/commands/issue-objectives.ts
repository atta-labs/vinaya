import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Objective, objectivesOf, objectivesVersion, renderObjectives } from '@attalabs/aeg-core'
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

function formatList(objectives: Objective[]): string {
  return objectives.map((o) => `${o.id}. ${o.text}`).join('\n')
}

function parseArgs(args: string[]): { json: boolean; issueRef: string; op: EditOp; reason: string } {
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

  return { json, issueRef, op: ops[0] as EditOp, reason: reason as string }
}

function fetchIssueBodyAndComments(issueRef: string): { body: string; comments: string[] } {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'body,comments'], {
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
    const parsed = JSON.parse(out) as { body?: string; comments?: Array<{ body: string }> }
    return { body: parsed.body ?? '', comments: (parsed.comments ?? []).map((c) => c.body) }
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh issue view ${issueRef} --json body,comments\` output.`,
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

export function issueObjectivesEditCommand(args: string[]): void {
  const { json, issueRef, op, reason } = parseArgs(args)
  refuseUnlessPrincipal(RETRY)

  const { body, comments } = fetchIssueBodyAndComments(issueRef)
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
  const newBody = spliceObjectivesSection(body, renderObjectives(updated))

  const dir = mkdtempSync(join(tmpdir(), 'vinaya-objectives-edit-'))
  const tmp = join(dir, 'body.md')
  writeFileSync(tmp, newBody, 'utf8')
  try {
    const ghArgs = ['--body-file', tmp]
    writeValidatedIssueEdit({
      issueRef,
      ghArgs,
      bodyResult: locateBody(ghArgs),
      json: false,
      retryCommand: RETRY,
      quiet: true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const newVersion = objectivesVersion(updated)
  const k = countMarkerComments(comments, MARKER_PREFIX) + 1
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

  if (json) printJson({ written: true, version: newVersion, url })
  else process.stdout.write(`${url}\n`)
}
