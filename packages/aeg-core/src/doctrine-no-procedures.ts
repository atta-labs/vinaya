/**
 * Doctrine-no-procedures sweep (task 10, Issue #385) — task 9's rule that
 * doctrine prose describes no command sequence, made a check. `roles/*.md`
 * and `contracts/*.md` explain *what* a command sequence does and *why*;
 * they are not a runbook a reader executes verbatim, and a copy-pasted
 * sequence rots the moment the real command changes (found live: two of
 * this tranche's own PRs were blocked writing exactly this shape after the
 * rule was already known in prose).
 *
 * Zero I/O: every input (file paths + contents) is read by the adapter
 * (`check-doctrine-no-procedures.ts`) and passed in — same discipline as
 * `doctrine-portability.ts` beside it.
 */

import { COMMAND_WORDS, extractFencedBlocks } from './brief-validation'
import { VENDOR_EXAMPLE_END, VENDOR_EXAMPLE_START } from './doctrine-portability'

export type DoctrineFile = { path: string; content: string }
export type DoctrineProcedureFinding = { file: string; line: number; message: string }

/**
 * The one sanctioned fenced home for a real command sequence in doctrine
 * (`tranche-model.md` §12's `AEG:VENDOR-EXAMPLE` pair) — same markers
 * `doctrine-portability.ts` exempts from its own vendor-name scan, exported
 * from there rather than re-declared here. First pair wins, same rule as
 * every other `AEG:*` anchor consumer.
 */
function vendorExampleSpan(content: string): { start: number; end: number } | null {
  const start = VENDOR_EXAMPLE_START.exec(content)
  if (!start) return null
  const afterStart = start.index + start[0].length
  const end = VENDOR_EXAMPLE_END.exec(content.slice(afterStart))
  if (!end) return null
  return { start: start.index, end: afterStart + end.index + end[0].length }
}

function isCommandLine(line: string): boolean {
  const word = line.trim().split(/\s+/)[0] ?? ''
  return (COMMAND_WORDS as readonly string[]).includes(word)
}

function procedureLineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

/** `aeg-root/templates/**` (or any adopter's `<doctrineRoot>/templates/**`) — worked-example templates that show the vendor-facing PR-report shape and legitimately carry a full command block. */
function isTemplatePath(path: string): boolean {
  return /(^|\/)templates\//.test(path)
}

/**
 * A fenced block containing two or more lines that each start with a shell
 * command word is a command sequence, not an illustration — the failure
 * names it: "this sequence is a `vinaya` command, name it." Exempt: a block
 * inside the `AEG:VENDOR-EXAMPLE` anchor pair, and any file under a
 * `templates/` directory.
 */
export function checkDoctrineNoProcedures(files: DoctrineFile[]): DoctrineProcedureFinding[] {
  const findings: DoctrineProcedureFinding[] = []

  for (const file of files) {
    if (isTemplatePath(file.path)) continue
    const span = vendorExampleSpan(file.content)

    for (const block of extractFencedBlocks(file.content)) {
      if (span && block.start >= span.start && block.end <= span.end) continue

      const commandLineCount = block.content.split('\n').filter(isCommandLine).length
      if (commandLineCount >= 2) {
        findings.push({
          file: file.path,
          line: procedureLineNumberAt(file.content, block.start),
          message: `this fenced block has ${commandLineCount} shell-command lines — this sequence is a \`vinaya\` command, name it (or move it inside the \`AEG:VENDOR-EXAMPLE\` anchor / a \`templates/\` file).`
        })
      }
    }
  }

  return findings
}
