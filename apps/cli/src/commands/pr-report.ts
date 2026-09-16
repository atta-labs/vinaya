import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  buildReport,
  collectTokensAddition,
  composeWrittenBody,
  type GateRunner,
  gh,
  GitCommandError,
  ghEditBody,
  prReportExitCode,
  type ReportResult,
  runReportForOpenPr,
  UnresolvableMergeBaseError
} from '../lib/pr-report-engine.js'
import { runBodyChecks } from '../lib/forge-write'

// Re-exported so every existing import of this command file's own path
// (`apps/cli/src/checks/bin/check-evidence-fresh.ts`'s `agentCommandText`/
// `extractAgentCommandLines`, `apps/cli/src/commands/pr-verify-evidence.ts`'s
// `buildReport`, this command's own test suite) keeps resolving unchanged —
// see `apps/cli/src/lib/pr-report-engine.ts`'s own module doc.
export {
  agentCommandText,
  anyGateFailed,
  bodiesAgreeOutsideRegions,
  buildReport,
  collectTokensAddition,
  composeWrittenBody,
  computeGroupA,
  computeGroupC,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DivergentEvidenceAnchorError,
  extractAgentCommandLines,
  type GateOutcome,
  type GateRunner,
  type GateRunResult,
  GitCommandError,
  groupCFailed,
  type GroupCCommandResult,
  MissingEvidenceAnchorError,
  prReportExitCode,
  renderGroupC,
  replaceEvidenceBlock,
  type ReportResult,
  resolveCommandTimeoutMs,
  runAgentCommand,
  spliceIntoLiveBody,
  UnresolvableMergeBaseError,
  writeTokensBlock
} from '../lib/pr-report-engine.js'

/**
 * `vinaya pr report` — the CLI surface over the `AEG:EVIDENCE`/`AEG:TOKENS`
 * engine (`apps/cli/src/lib/pr-report-engine.ts`): argv
 * parsing, console I/O, and `process.exit` only. Every computation lives in
 * the engine, which the loop's driver (`apps/cli/src/lib/dev-review-loop.ts`)
 * also calls directly, in-process — a command never calls a command
 * (`apps/cli/specs/surface.md`'s "the rule"), so the loop never shells out to
 * this file. See the engine's own module doc for the Group A/B/C model, why
 * gate running is injectable, and why `cwd` is threaded explicitly rather
 * than relying on `process.chdir()`.
 *
 * `--push <pr>` is the post-open sibling of `--write`: it fetches the PR's
 * LIVE body from the forge, splices the freshly-built blocks into it through
 * the same anchor resolver `--write` uses, pushes the result via `gh pr edit`,
 * then re-reads the live body and refuses (restoring the pre-edit body)
 * unless the two bodies agree outside the `AEG:EVIDENCE`/`AEG:TOKENS`
 * regions. The local body file a Developer might still be holding is never
 * the input — the live body always is. The non-`--body-file` half of this
 * sequence is `runReportForOpenPr` (the engine), called below exactly the
 * way the driver calls it, translating its `EvidenceReportOutcome` back into
 * the same console messages and exit code this command always printed.
 *
 * `--push <n> --body-file <path>` is a narrower, separate mode, not the
 * routine one: `--body-file` names a local file that IS the whole body —
 * `AEG:EVIDENCE`/`AEG:TOKENS` are regenerated fresh against it (never
 * trusting stale copies the file itself carries) and the file's own content
 * is written to the forge verbatim, replacing the live body outright, rather
 * than fetching-and-splicing into whatever the forge currently holds. This
 * exists for the one legitimate case a routine splice cannot cover: a
 * section outside the two generated blocks (a Decisions bullet, most often)
 * that only ever existed in a local draft, never yet posted.
 */

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: process.env }).trim()
  } catch {
    return ''
  }
}

const USAGE =
  'Usage: vinaya pr report [--write <body-file> | --push <pr> [--body-file <path>]] [--phase <phase>] ' +
  '[--role <role>] [--model <id>] [--transcript <path>]'

/**
 * `<n>` out of a `task/<tranche>/<n>` branch name — the `<task-id>` half of
 * the `<task-id>: develop` phase convention. Duplicated here, not imported
 * from the engine (which keeps its own private copy for its default `phase`
 * — see `runReportForOpenPr`'s own `derivePhase` default): this command's
 * `--phase` default and the engine's are the same rule, but keeping this
 * command able to compute it without reaching into the engine's internals
 * avoids exporting a name the engine has no other reason to expose.
 */
function derivePhase(): string {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const m = /^task\/[^/]+\/(.+)$/.exec(branch)
  const taskId = m ? m[1] : branch || 'unknown'
  return `${taskId}: develop`
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function prReportCommand(args: string[], testOverrides?: { gateRunner?: GateRunner }): Promise<void> {
  const writeIdx = args.indexOf('--write')
  const writePath = writeIdx !== -1 ? args[writeIdx + 1] : undefined
  const pushIdx = args.indexOf('--push')
  const pushPr = pushIdx !== -1 ? args[pushIdx + 1] : undefined
  // (`#543`, O6) `--body-file <path>` names the
  // local file that IS the whole body source for this push — every byte of
  // it, not only the freshly regenerated AEG:EVIDENCE/AEG:TOKENS blocks,
  // reaches the forge (`composeWrittenBody`, the SAME whole-body composer
  // `--write` alone already uses). Valid only alongside `--push`: it names
  // what to push, and `--write` alone has no forge target for it to reach.
  const bodyFileIdx = args.indexOf('--body-file')
  const bodyFilePath = bodyFileIdx !== -1 ? args[bodyFileIdx + 1] : undefined
  const transcriptIdx = args.indexOf('--transcript')
  const transcriptPath = transcriptIdx !== -1 ? args[transcriptIdx + 1] : undefined
  const phaseIdx = args.indexOf('--phase')
  const phaseOverride = phaseIdx !== -1 ? args[phaseIdx + 1] : undefined
  const roleIdx = args.indexOf('--role')
  const roleOverride = roleIdx !== -1 ? args[roleIdx + 1] : undefined
  const modelIdx = args.indexOf('--model')
  const modelOverride = modelIdx !== -1 ? args[modelIdx + 1] : undefined

  if (writeIdx !== -1 && !writePath) {
    console.error(USAGE)
    process.exit(2)
  }
  if (pushIdx !== -1 && !pushPr) {
    console.error(USAGE)
    process.exit(2)
  }
  if (pushPr && !/^\d+$/.test(pushPr)) {
    // Catches a flag value swallowed as the PR number (e.g. a stray
    // `--transcript` with no path) before it ever reaches `gh pr view`,
    // which would otherwise surface as an opaque forge error instead of a
    // clean usage refusal.
    console.error(`vinaya pr report: refused — \`--push ${pushPr}\` is not a PR number.\n${USAGE}`)
    process.exit(2)
  }
  if (writePath && pushPr) {
    console.error(`vinaya pr report: refused — --write and --push are mutually exclusive.\n${USAGE}`)
    process.exit(2)
  }
  if (bodyFileIdx !== -1 && !bodyFilePath) {
    console.error(USAGE)
    process.exit(2)
  }
  if (bodyFilePath && !pushPr) {
    console.error(`vinaya pr report: refused — --body-file only applies alongside --push.\n${USAGE}`)
    process.exit(2)
  }
  if (bodyFilePath && !existsSync(bodyFilePath)) {
    console.error(`vinaya pr report: refused — --body-file ${bodyFilePath} does not exist.\n${USAGE}`)
    process.exit(2)
  }

  // `--push` fetches the LIVE body up front — it is the input the splice
  // targets, never a local file — and exports it (with PR_NUMBER and BRANCH)
  // before the gate run below, so Group B's own `evidence-fresh` check
  // actually compares against this PR's real state instead of silently
  // skipping for want of `PR_NUMBER` (the gap the manual sequence this
  // command replaces left open — see `aeg-root/roles/developer.md`).
  let preEditBody: string | undefined
  if (pushPr) {
    try {
      preEditBody = gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
    } catch (err) {
      console.error(
        `vinaya pr report: refused — could not fetch PR ${pushPr}'s live body: ${err instanceof Error ? err.message : String(err)}`
      )
      process.exit(1)
    }
    process.env.PR_BODY = preEditBody
    process.env.PR_NUMBER = pushPr
    process.env.BRANCH = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  // (`#543` O6) `--body-file` names the actual source this push grades and
  // sends — never the stale live body fetched just above, which exists
  // here only so the live-splice branch (no `--body-file`) has something to
  // splice into.
  const bodyFileSource = bodyFilePath !== undefined ? readFileSync(bodyFilePath, 'utf8') : undefined
  if (bodyFileSource !== undefined) {
    process.env.PR_BODY = bodyFileSource
  }

  // Read BEFORE `buildReport()`, not after: Group C extracts its command
  // list from the body it is given, and the `--write` local draft is the
  // one body this command can read for that purpose before its own write
  // happens. `--push` already has `preEditBody`; the stdout-only path (no
  // flag) falls back to `buildReport`'s own `PR_BODY` env default.
  const existingForWrite =
    writePath === undefined ? undefined : existsSync(writePath) ? readFileSync(writePath, 'utf8') : ''

  // `--write` forwards the drafted body and branch to Group B the same way
  // `--push` does above — set right before the gate run, so `runRealGates`'s
  // `env: { ...process.env }` spread (read at call time, not construction
  // time) picks these up. No `PR_NUMBER`: there is no pull request yet, and
  // a `requiresOpenPr` check must keep skipping honestly rather than reading
  // a fake number.
  if (writePath !== undefined) {
    process.env.PR_BODY = existingForWrite
    process.env.BRANCH = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  const gradedBodySource =
    bodyFileSource !== undefined ? 'push-from-file' : pushPr ? 'push' : writePath !== undefined ? 'write' : 'ambient'

  let result: ReportResult
  try {
    result = await buildReport({
      body: bodyFileSource ?? preEditBody ?? existingForWrite,
      gradedBodySource,
      gateRunner: testOverrides?.gateRunner
    })
  } catch (err) {
    if (err instanceof UnresolvableMergeBaseError || err instanceof GitCommandError) {
      // Refuse — write nothing, print nothing that looks like a block.
      // See that class's doc comment: an unresolvable base is an
      // infrastructure failure, and writing an empty Group A here would
      // silently claim "verified: no changes" for "never verified anything."
      console.error(`vinaya pr report: refused — ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  // A refused token row must not cost the caller its Evidence block.
  // `aeg-root/roles/developer.md` makes this command's exit code the
  // Developer's pre-open verification run, and states that a red gate still
  // writes the block and exits non-zero — so refusing here means withholding
  // the row and exiting non-zero, never aborting before the write. Aborting
  // would leave every unwired host unable to populate Evidence at all.
  let tokensRefused = false
  if (pushPr && bodyFileSource !== undefined) {
    // (`#543` O6) The whole local body — every byte of it, never only the
    // regenerated blocks — replaces the live body outright. `composeWrittenBody`
    // is the SAME whole-body composer `--write` alone already uses (source +
    // freshly regenerated Evidence/Tokens); the only difference here is the
    // destination (the forge, via `gh pr edit`) rather than a local file.
    const tokens = collectTokensAddition({
      phase: phaseOverride ?? derivePhase(),
      role: roleOverride ?? 'Developer',
      date: isoToday(),
      transcriptPath,
      modelOverride
    })
    const composed = composeWrittenBody(bodyFileSource, result.blockInner, tokens)

    await runBodyChecks(
      composed,
      process.env.BRANCH ?? '',
      Number(pushPr),
      `vinaya pr report --push ${pushPr} --body-file ${bodyFilePath}`
    )

    try {
      ghEditBody(pushPr, composed)
    } catch (err) {
      console.error(
        `vinaya pr report: refused — \`gh pr edit ${pushPr}\` failed: ${err instanceof Error ? err.message : String(err)}. Nothing was pushed.`
      )
      process.exit(1)
    }

    let postEditBody: string
    try {
      postEditBody = gh(['pr', 'view', pushPr, '--json', 'body', '-q', '.body'])
    } catch (err) {
      console.error(
        `vinaya pr report: pushed to PR ${pushPr} but could not re-read its live body to self-verify: ${err instanceof Error ? err.message : String(err)}. Inspect PR ${pushPr} by hand — this command could not confirm the push landed cleanly.`
      )
      process.exit(1)
    }
    if (postEditBody !== composed) {
      console.error(
        `vinaya pr report: PR ${pushPr}'s live body, re-read after the push, does not byte-match what was sent — inspect it by hand (a forge-side normalisation, or a concurrent edit, may be the cause).`
      )
    }

    if (!tokens.collected) tokensRefused = true
    process.stdout.write(`Pushed the whole body from ${bodyFilePath} to PR ${pushPr}\n`)
    if (!tokens.collected) {
      console.error(`${tokens.refusal}\n\nThe AEG:EVIDENCE block was still pushed to PR ${pushPr}.`)
    }
  } else if (pushPr) {
    const outcome = await runReportForOpenPr(pushPr, preEditBody as string, result, {
      transcriptPath,
      phaseOverride,
      roleOverride,
      modelOverride
    })
    switch (outcome.kind) {
      case 'splice-refused':
        console.error(`vinaya pr report: refused — ${outcome.message}`)
        process.exit(1)
        break
      case 'body-checks-refused':
      case 'edit-failed':
      case 'reread-failed':
      case 'drift-restore-failed':
      case 'drift-restored':
        console.error(outcome.message)
        process.exit(1)
        break
      case 'ok':
        if (!outcome.tokensSpliced && outcome.tokensCollected) {
          console.error(
            `vinaya pr report: PR ${pushPr}'s live body carries no AEG:TOKENS anchor pair — the token row was withheld rather than creating one via --push (only --write's local draft creates a fresh pair; see aeg-root/templates/pr-report-template.md). The AEG:EVIDENCE block was still pushed to PR ${pushPr}.`
          )
        }
        if (outcome.tokensSpliced) {
          process.stdout.write(`Pushed AEG:EVIDENCE and AEG:TOKENS blocks to PR ${pushPr}\n`)
        } else {
          if (!outcome.tokensCollected) tokensRefused = true
          process.stdout.write(`Pushed AEG:EVIDENCE block to PR ${pushPr}\n`)
          if (!outcome.tokensCollected) {
            console.error(`${outcome.tokensRefusal}\n\nThe AEG:EVIDENCE block was still pushed to PR ${pushPr}.`)
          }
        }
        break
    }
  } else if (writePath) {
    const existing = existingForWrite ?? ''
    const tokens = collectTokensAddition({
      phase: phaseOverride ?? derivePhase(),
      role: roleOverride ?? 'Developer',
      date: isoToday(),
      transcriptPath,
      modelOverride
    })
    writeFileSync(writePath, composeWrittenBody(existing, result.blockInner, tokens))
    if (tokens.collected) {
      process.stdout.write(`Wrote AEG:EVIDENCE and AEG:TOKENS blocks to ${writePath}\n`)
    } else {
      tokensRefused = true
      process.stdout.write(`Wrote AEG:EVIDENCE block to ${writePath}\n`)
      // The Evidence half is the CALLER's fact — this is the only place that
      // knows a file was written, and to which path. `TOKEN_ROW_REMEDY` says
      // nothing about it on purpose; see its doc comment.
      console.error(`${tokens.refusal}\n\nThe AEG:EVIDENCE block was still written to ${writePath}.`)
    }
  } else {
    process.stdout.write(`${result.block}\n`)
  }

  process.exit(prReportExitCode({ gatesFailed: result.gatesFailed, tokensRefused }))
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'pr report': { date: '2026-09-13', callsToday: 8, retiresVia: 'collectTokens' }
}
