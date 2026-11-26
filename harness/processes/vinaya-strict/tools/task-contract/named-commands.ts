import { stripCode } from '@harness/kernel/adapters/code-host/github/strip-code'
import { programForWords } from '../programs'
import { extractFencedBlocks } from './brief-validation'
import {
  backtickedSpans,
  CLI_INVOCATION_PREFIXES,
  type CommandReferenceFacts,
  commandStatements,
  type IssueSectionResult,
  introducedText,
  invokedCommandTokens,
  maskQuoted,
  parseIssuePremises,
  resolveCommand,
  stripLineComment
} from './issue-validation'
import { locateTestPlanSection } from './test-plan-section'

/**
 * **A command an Issue quotes is a command the command line has.** The brief
 * render writes a quoted command in the repository's own way of invoking the
 * command line, so a name the command line does not have reaches the Developer
 * as a complete, runnable-looking command that does not exist. Two places carry
 * such a name: a code span in any field outside the Objectives and Parts, and a
 * fenced `## Test plan` line. The command reference is the registry the
 * router is tested against, so absence there is the whole question — the
 * tracked tree is never asked, and a repository with no reference file is not
 * excused, because the list is read from the shipped module either way.
 *
 * What counts as a command is what `checkIntroducedCommandsCovered` already
 * decides (`invokedCommandTokens`, `resolveCommand`): the same readers, so the
 * two rules cannot disagree. The Objectives and Parts are that rule's ground;
 * a command they introduce is accepted wherever else the Issue quotes it. A
 * name written with a hyphen (`vinaya-check`) is a separate program, never a
 * command word run, and is not judged here. A `## Premises` line quotes code
 * text, not an invocation, so it is left out as well.
 */

type Quote = { where: string; span: string }

/** Every code span the body carries outside its Objectives, Parts, Premises and fenced blocks. */
function quotedSpans(body: string): Quote[] {
  let text = stripCode(body, { inlineSpans: 'keep' })
  for (const { text: introduced } of introducedText(body)) text = text.replace(introduced, '')
  const premises = parseIssuePremises(body)
  if (premises.ok) for (const p of premises.value) text = text.replace(p.line, '')
  return backtickedSpans(text).map((span) => ({ where: `the code span \`${span}\``, span }))
}

/** Each statement of each fenced `## Test plan` line that invokes the command line, rewritten as `<binary> <words…>`. */
function testPlanInvocations(body: string, binary: string): Quote[] {
  const located = locateTestPlanSection(body)
  if (!located.found) return []
  const out: Quote[] = []
  const lines = extractFencedBlocks(located.section).flatMap((b) =>
    b.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  )
  for (const line of lines) {
    for (const raw of commandStatements(line)) {
      const stmt = stripLineComment(raw)
      const masked = maskQuoted(stmt)
      const pieces: string[] = []
      let last = 0
      for (let i = 0; i < masked.length; i++) {
        if (masked[i] === '|') {
          pieces.push(stmt.slice(last, i))
          last = i + 1
        }
      }
      pieces.push(stmt.slice(last))
      for (const piece of pieces) {
        const tokens = piece.trim().split(/\s+/).filter(Boolean)
        while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] as string)) tokens.shift()
        const prefix = CLI_INVOCATION_PREFIXES.find((p) => p.every((token, i) => tokens[i] === token))
        if (prefix === undefined) continue
        out.push({
          where: `the Test plan line \`${line}\``,
          span: [binary, ...tokens.slice(prefix.length)].join(' ')
        })
      }
    }
  }
  return out
}

export function checkQuotedCommandsExist(body: string, reference: CommandReferenceFacts): IssueSectionResult {
  const names = new Set(reference.commands.map((c) => c.name.toLowerCase()))
  const introduced = new Set<string>()
  for (const { text } of introducedText(body)) {
    for (const span of backtickedSpans(text)) {
      const tokens = invokedCommandTokens(span, reference.binary)
      if (tokens === null) continue
      const resolved = resolveCommand(tokens, names)
      if (resolved.introduced !== null) introduced.add(resolved.introduced)
    }
  }

  const errors: string[] = []
  const reported = new Set<string>()
  for (const { where, span } of [...quotedSpans(body), ...testPlanInvocations(body, reference.binary)]) {
    const tokens = invokedCommandTokens(span, reference.binary)
    if (tokens === null) continue
    const { introduced: missing } = resolveCommand(tokens, names)
    if (missing === null || introduced.has(missing) || reported.has(missing)) continue
    reported.add(missing)
    const program = programForWords(tokens)
    const standsFor =
      program === null
        ? ''
        : ` Those words belong to the separate program \`vinaya-${program.name}\`, not to a command of the command line.`
    errors.push(
      `issue-validation Commands/named: ${where} quotes the command \`${reference.binary} ${missing}\`, which the command line does not have.${standsFor} Quote a command the command reference carries, or introduce this one in the Objectives or Parts.`
    )
  }
  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}
