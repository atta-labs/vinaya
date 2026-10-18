import { execFileSync } from 'node:child_process'
import { forgeSnapshotDir, snapshotBody, snapshotComments } from './forge-snapshot'

/**
 * The one reader of an Issue's or pull request's body and comments. Those
 * are the forge reads that grow without bound, and `execFileSync`'s own
 * default `maxBuffer` (1 MiB) made each hand-rolled `gh issue view --json
 * comments` throw a raw `ENOBUFS` once an Issue's comments passed it.
 *
 * Comments are paged through the REST listing (`per_page` pages, in order,
 * each exactly once) instead of one aggregate view; the whole read is held
 * under `FORGE_READ_CEILING_BYTES`, and a response above it is a
 * `ForgeReadOversizeError` every caller reports the same way.
 *
 * In CI, when the step that runs checks carries the forge snapshot
 * (`forge-snapshot.ts`), a body or comment read of the pull request or the
 * task Issue it closes is served from that snapshot instead of the forge;
 * every other number, and every run outside CI, reads live exactly as before.
 */

/** The declared ceiling, in bytes, on everything one forge read buffers. */
export const FORGE_READ_CEILING_BYTES = 64 * 1024 * 1024

const PAGE_SIZE = 100

/** An Issue or pull request comment, in the shape `gh issue view --json comments` returns. */
export type ForgeComment = { body: string; url: string; author: { login: string } | null }

/** Runs `gh` with the given args and returns stdout; the seam tests replace. */
export type ForgeRunner = (args: string[], maxBuffer: number) => string

export const ghRunner: ForgeRunner = (args, maxBuffer) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer })

/** A forge response larger than the ceiling — names the subject, the ceiling and the observed size. */
export class ForgeReadOversizeError extends Error {
  readonly subject: string
  readonly ceilingBytes: number
  readonly observedBytes: number
  constructor(
    subject: string,
    observedBytes: number,
    atLeast = false,
    ceilingBytes: number = FORGE_READ_CEILING_BYTES
  ) {
    super(
      `The forge response for ${subject} is ${atLeast ? 'at least ' : ''}${observedBytes} bytes, above the ${ceilingBytes}-byte read ceiling (FORGE_READ_CEILING_BYTES) — refusing rather than buffering it.`
    )
    this.name = 'ForgeReadOversizeError'
    this.subject = subject
    this.ceilingBytes = ceilingBytes
    this.observedBytes = observedBytes
  }
}

export function isForgeReadOversize(err: unknown): err is ForgeReadOversizeError {
  return err instanceof ForgeReadOversizeError
}

function isBufferOverflow(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOBUFS'
}

/** Runs one `gh` read with what is left of the ceiling as its buffer; a larger response is a `ForgeReadOversizeError`. */
export function runBounded(runner: ForgeRunner, args: string[], subject: string, usedBytes: number): string {
  const remaining = FORGE_READ_CEILING_BYTES - usedBytes
  let out: string
  try {
    out = runner(args, remaining)
  } catch (err) {
    // A spawn buffer overflow means the output passed what was left of the ceiling.
    if (isBufferOverflow(err)) throw new ForgeReadOversizeError(subject, FORGE_READ_CEILING_BYTES + 1, true)
    throw err
  }
  const size = Buffer.byteLength(out, 'utf8')
  if (usedBytes + size > FORGE_READ_CEILING_BYTES) throw new ForgeReadOversizeError(subject, usedBytes + size)
  return out
}

/** One row of the REST comment listing — the fields the readers below map from. */
export type RestComment = {
  body?: string | null
  html_url?: string
  created_at?: string
  user?: { login?: string; type?: string } | null
}

/**
 * Every REST comment row on an Issue or pull request, in order, each once —
 * paged through the REST listing under the read ceiling. `number` is already
 * resolved: this never reads the snapshot and never takes a ref.
 */
export function readRestCommentRows(
  number: number,
  subjectLabel = `Issue ${number}`,
  runner: ForgeRunner = ghRunner
): RestComment[] {
  const rows: RestComment[] = []
  let used = 0
  for (let page = 1; ; page++) {
    const out = runBounded(
      runner,
      ['api', `repos/{owner}/{repo}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`],
      subjectLabel,
      used
    )
    used += Buffer.byteLength(out, 'utf8')
    const pageRows = JSON.parse(out) as RestComment[]
    rows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) return rows
  }
}

/** Every comment on an Issue or pull request, in order, each once. `issue` is a number or any ref `gh issue view` accepts. */
export function readIssueComments(
  issue: number | string,
  subjectLabel = `Issue ${issue}`,
  runner: ForgeRunner = ghRunner
): ForgeComment[] {
  const number = resolveNumber(issue, subjectLabel, runner)
  const fromSnapshot = snapshotComments(number)
  if (fromSnapshot !== null) return fromSnapshot
  return readRestCommentRows(number, subjectLabel, runner).map((r) => ({
    body: r.body ?? '',
    url: r.html_url ?? '',
    author: r.user?.login ? { login: r.user.login } : null
  }))
}

/** An Issue's or pull request's body. */
export function readIssueBody(
  issue: number | string,
  subjectLabel = `Issue ${issue}`,
  runner: ForgeRunner = ghRunner
): string {
  if (forgeSnapshotDir() !== null) {
    const fromSnapshot = snapshotBody(resolveNumber(issue, subjectLabel, runner))
    if (fromSnapshot !== null) return fromSnapshot
  }
  const out = runBounded(runner, ['issue', 'view', String(issue), '--json', 'body'], subjectLabel, 0)
  return (JSON.parse(out) as { body?: string | null }).body ?? ''
}

/** Small scalar fields of an Issue (`number`, `title`, `labels`) through the same bounded buffer. */
export function readIssueFields<T extends object>(
  issue: number | string,
  fields: string,
  subjectLabel = `Issue ${issue}`,
  runner: ForgeRunner = ghRunner
): T {
  return JSON.parse(runBounded(runner, ['issue', 'view', String(issue), '--json', fields], subjectLabel, 0)) as T
}

function resolveNumber(issue: number | string, subjectLabel: string, runner: ForgeRunner): number {
  if (typeof issue === 'number') return issue
  if (/^\d+$/.test(issue)) return Number(issue)
  return readIssueFields<{ number: number }>(issue, 'number', subjectLabel, runner).number
}
