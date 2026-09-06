/**
 * Doc-claim binding (Issue #434). Pure — no `fs`; cited-file content is
 * injected via `fileReader`, the same discipline `premise-check.ts` and
 * `quoted-command.ts` keep.
 *
 * **The defect this closes.** A brief may not state a fact about code as
 * prose — every fact is a premise pin or an executed command. Doctrine pages
 * and source comments had no such rule, so a behavioural sentence ("the
 * extraction reads only the first five lines, never a caller field") was a
 * claim nothing verified: an edit that changed the number left the sentence
 * standing, half true. Measured, live: one false sentence had five copies and
 * took seven review rounds, each round fixing the one copy its finding
 * happened to anchor.
 *
 * **Marker-based, not inferred.** This module implements NO inference and NO
 * heuristic fallback over unmarked prose; only annotated sentences are ever
 * evaluated — the Principal's standing ruling for `quoted-command.ts`,
 * applied unchanged. Coverage grows only as docs adopt the marker.
 *
 * **The marker grammar** is the premise pin, reused rather than reinvented:
 * the same `<path> contains:<literal>` / `absent:` / `sha256:` triple
 * `premise-check.ts` parses, carried inline in a marker that sits on its own
 * line immediately before the paragraph it binds. Two forms, one per host
 * language — in markdown, an HTML comment of the same invisible-on-render
 * shape as `AEG:QUOTES-FILE`; in TypeScript, a `//` line comment or a `*`
 * block-comment line:
 *
 *     <!-- AEG:CLAIM: <path> contains:<literal> -->
 *     // AEG:CLAIM: <path> contains:<literal>
 *
 * Several markers may stack before one paragraph. Both example lines above
 * are inert here by construction: the patterns below require `AEG:CLAIM:` to
 * follow its comment prefix immediately, and in a JSDoc both examples carry
 * an intervening `<!--` or `//` after this comment's own `*`.
 *
 * **What it proves, and what it does not.** It proves the cited file still
 * holds the literal (or still lacks it, or still hashes the same). It cannot
 * prove the sentence is true. Choosing a literal whose change would falsify
 * the sentence is the author's judgment, and whether an unbound sentence
 * should be bound or deleted is the Reviewer's — the same division
 * `documentation-coherence.md` already draws for C7. For a claim about a read
 * window, the binding literal is the function that windows the read, never
 * another comment: a comment-to-comment binding proves only that two
 * unverified sentences agree.
 */

import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { checkPremises, type PremiseAssertion } from './premise-check'
import { isValidCitedFilePath } from './quoted-command'

export type DocClaimSourceFile = { path: string; content: string }

/** One marker: the file carrying it, the line it sits on, and the pin it asserts. */
export type ClaimBinding = { file: string; line: number; assertion: PremiseAssertion }

export type ClaimFinding = { file: string; line: number; message: string }

/** Markdown form — an HTML comment, invisible on render, exactly as `AEG:QUOTES-FILE` is. */
const MARKDOWN_MARKER = /^\s*<!--\s*AEG:CLAIM:\s*(\S+)\s+(contains|absent|sha256)\s*:\s*(.+?)\s*-->\s*$/i

/** Source-comment form — a `//` line or a `*` block-comment line. */
const COMMENT_MARKER = /^\s*(?:\/\/|\*)\s*AEG:CLAIM:\s*(\S+)\s+(contains|absent|sha256)\s*:\s*(.+?)\s*$/i

/**
 * A line that announces itself as a marker but parses as neither form. Kept
 * deliberately loose — anything carrying the `AEG:CLAIM:` token after a
 * comment opener is a marker the author *meant*, so a typo in the kind or a
 * missing colon surfaces as a finding rather than silently binding nothing.
 * Silence there would be the worst outcome this check has: a sentence that
 * looks bound to every reader and is checked by nothing.
 */
const MARKER_ANNOUNCEMENT = /^\s*(?:<!--|\/\/|\*)\s*AEG:CLAIM:/i

/**
 * Marker lines are scanned on `maskCode`'s output — index- and
 * line-preserving, so a masked line still maps 1:1 onto the original. This is
 * what makes a fenced example inert: `documentation-coherence.md` and
 * `roles/reviewer.md` both *show* this grammar in fenced blocks, and a check
 * that evaluated its own documentation would fire on every page that explains
 * it. Values are then read back from the ORIGINAL line, never the mask —
 * `maskCode` blanks inline code spans, and a literal may legitimately contain
 * backticks. Same find-in-mask / slice-from-original discipline
 * `quoted-command.ts` uses.
 */
function scanFile(path: string, content: string): { bindings: ClaimBinding[]; malformed: ClaimFinding[] } {
  const original = content.split('\n')
  const masked = maskCode(content).split('\n')
  const bindings: ClaimBinding[] = []
  const malformed: ClaimFinding[] = []

  for (let i = 0; i < original.length; i++) {
    const maskedLine = masked[i] ?? ''
    if (!MARKER_ANNOUNCEMENT.test(maskedLine)) continue

    const raw = original[i] as string
    const line = i + 1
    const m = MARKDOWN_MARKER.exec(raw) ?? COMMENT_MARKER.exec(raw)
    if (m === null) {
      malformed.push({
        file: path,
        line,
        message: `${path}:${line} carries an \`AEG:CLAIM:\` marker that parses as neither form — expected \`<path> contains:<literal>\` (or \`absent:\`/\`sha256:\`), in an HTML comment in markdown or a \`//\`/\`*\` comment line in TypeScript. A marker that binds nothing is worse than no marker: the sentence reads as checked and is not.`
      })
      continue
    }

    const [, citedPath, kindRaw, value] = m
    bindings.push({
      file: path,
      line,
      assertion: {
        kind: (kindRaw as string).toLowerCase(),
        path: citedPath as string,
        value: (value as string).trim()
      } as PremiseAssertion
    })
  }

  return { bindings, malformed }
}

/** Every well-formed marker across `files`. Zero I/O — `files` is read by the caller. */
export function findClaimBindings(files: readonly DocClaimSourceFile[]): ClaimBinding[] {
  const bindings: ClaimBinding[] = []
  for (const file of files) bindings.push(...scanFile(file.path, file.content).bindings)
  return bindings
}

/**
 * Every marker that announced itself and then failed to parse. Separate from
 * `findClaimBindings` because a malformed marker yields no binding to
 * evaluate — it is a finding on its own, before any file is read.
 */
export function findMalformedClaimMarkers(files: readonly DocClaimSourceFile[]): ClaimFinding[] {
  const malformed: ClaimFinding[] = []
  for (const file of files) malformed.push(...scanFile(file.path, file.content).malformed)
  return malformed
}

/**
 * Removes every `AEG:CLAIM:` marker line from a cited file's content before a
 * `contains`/`absent` pin is evaluated against it.
 *
 * Defeat case this closes: a marker whose literal is the marker's own text
 * ("`reviewer.md` contains `AEG:CLAIM`", written inside `reviewer.md`) would
 * otherwise satisfy itself, proving nothing while reading as bound. Stripping
 * the marker lines makes the evidence necessarily live outside the claim —
 * and closes the cross-file variant too, where a marker in one file cites
 * another whose only matching text is that file's own marker. Not applied to
 * `sha256`, which hashes the file as it actually is.
 */
function withoutClaimMarkers(content: string): string {
  return content
    .split('\n')
    .filter((line) => !MARKER_ANNOUNCEMENT.test(line))
    .join('\n')
}

/**
 * Re-assert every binding against the cited file's current content. The
 * predicate itself is delegated to `checkPremises` — one implementation of
 * `contains`/`absent`/`sha256`, shared with the brief's own `Premise:` block,
 * so the two grammars can never drift into disagreeing about what a pin
 * means. Only the message is composed here, because a doc claim's remediation
 * differs from a stale brief's.
 */
export function evaluateClaimBindings(
  bindings: readonly ClaimBinding[],
  fileReader: (path: string) => string | null
): ClaimFinding[] {
  const findings: ClaimFinding[] = []

  for (const binding of bindings) {
    const { file, line, assertion } = binding
    const pin = `${assertion.path} ${assertion.kind}:${assertion.value}`

    // An invalid cited path never reaches the file-read stage. `quoted-command.ts`
    // treats one as no marker at all, to deny an attacker any signal difference;
    // here it is a finding instead, because the outcome is constant — the same
    // message for every path shape, with no file read and so no content to leak —
    // and silence would let a doc carry a marker that binds nothing forever.
    if (!isValidCitedFilePath(assertion.path)) {
      findings.push({
        file,
        line,
        message: `${file}:${line} binds \`${pin}\`, but \`${assertion.path}\` is not a repo-root-relative path (absolute paths and \`..\` traversal are refused). Cite a file inside the repository.`
      })
      continue
    }

    const content = fileReader(assertion.path)
    if (content === null) {
      findings.push({
        file,
        line,
        message: `${file}:${line} binds \`${pin}\`, but \`${assertion.path}\` could not be read. Cite a file that exists, or remove the sentence.`
      })
      continue
    }

    const subject = assertion.kind === 'sha256' ? content : withoutClaimMarkers(content)
    const result = checkPremises([assertion], () => subject)
    if (result.pass) continue

    const remediation =
      assertion.kind === 'sha256'
        ? `\`${assertion.path}\` changed, so the pinned hash is stale. If this PR is the change, update the pin in this same PR; otherwise the bound sentence may no longer be true — re-read it, then re-bind or remove it.`
        : `The sentence bound here claims something \`${assertion.path}\` no longer shows. Re-read the code, then correct the sentence and re-bind it, or remove it — never reword an unbound claim.`

    findings.push({
      file,
      line,
      message: `${file}:${line} binds \`${pin}\`, which no longer holds. ${remediation}`
    })
  }

  return findings
}

/**
 * Both phases in one call: discover markers, report the malformed, evaluate
 * the rest. Returns `bindingCount` alongside the findings so a caller that
 * wants to report "how many bindings were verified" does not scan the corpus
 * a second time to count them (review round 1, MINOR) — this is the one
 * entry point `verify-docs` needs, and the only one the package barrel
 * exports; the granular functions stay module-level for direct testing.
 */
export function checkDocClaims(
  files: readonly DocClaimSourceFile[],
  fileReader: (path: string) => string | null
): { findings: ClaimFinding[]; bindingCount: number } {
  const scanned = files.map((file) => scanFile(file.path, file.content))
  const bindings = scanned.flatMap((s) => s.bindings)
  return {
    findings: [...scanned.flatMap((s) => s.malformed), ...evaluateClaimBindings(bindings, fileReader)],
    bindingCount: bindings.length
  }
}
