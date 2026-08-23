// `vinaya milestone create` — the write side of vinaya-milestone-model-v1
// task 2: a Milestone means a product goal, and the Architect is the role
// that creates one. `checkMilestoneShape` (`@attalabs/aeg-core`) refuses a
// malformed body — goal absent, `Release:` present but malformed, the
// `### Tranche intents` section unparseable — before any `gh` call, exactly
// like the Issue-only content gate refuses before `issue.ts`'s forge write.
//
// `gh` has no built-in `milestone create` subcommand (unlike `issue`/`pr`),
// so the actual write goes through `gh api repos/<repo>/milestones` directly
// rather than the `runGhWrite`/`resolveShippableArgs` argv-passthrough
// plumbing `issue.ts`/`pr.ts` share — there is no `gh milestone create` argv
// shape to pass through.

import { execFileSync } from 'node:child_process'
import { checkMilestoneShape } from '@attalabs/aeg-core'
import { detectGitRepo } from '../lib/detect.js'
import { printJson } from '../lib/envelope.js'
import {
  type BodyResult,
  ForgeArgError,
  extractTitle,
  locateBody,
  makeCheckError,
  refuse,
  resolveSections,
  validateForgeWrite
} from '../lib/forge-write.js'

const RETRY_CREATE = 'vinaya milestone create --title <title> --body-file <path>'

function sh(args: string[], input?: string): string {
  return execFileSync(args[0] as string, args.slice(1), { encoding: 'utf8', input }).trim()
}

function locateBodyOrRefuse(args: string[]): BodyResult {
  let result: BodyResult | null
  try {
    result = locateBody(args)
  } catch (e) {
    if (e instanceof ForgeArgError) {
      refuse([makeCheckError('forge-args', e.message, `Fix the invocation, then re-run \`${RETRY_CREATE}\`.`)])
    }
    throw e
  }
  if (result === null) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone create` requires a `--body-file <path>` (or `--body <text>`) carrying the milestone description.',
        `Add \`--body-file <path>\`, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }
  return result
}

export async function milestoneCreateCommand(args: string[]): Promise<void> {
  const json = args.includes('--json')
  const validateOnly = args.includes('--validate-only')
  const rest = args.filter((a) => a !== '--json' && a !== '--validate-only')

  const title = extractTitle(rest)
  if (!title) {
    refuse([
      makeCheckError(
        'forge-args',
        '`vinaya milestone create` requires a `--title <title>` — the Milestone title is free text, never parsed for the version.',
        `Add \`--title <title>\`, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }

  const bodyResult = locateBodyOrRefuse(rest)
  const body = bodyResult.body

  // Unconditional — runs whether or not `briefSchema.milestone` is
  // configured, mirroring the Issue-only content gate: config decides which
  // EXTRA sections are required, never whether this refusal runs.
  const shape = checkMilestoneShape(body)
  if (shape.status === 'fail') {
    refuse(
      shape.errors.map((message) =>
        makeCheckError('milestone-shape', message, `Fix the Milestone description, then re-run \`${RETRY_CREATE}\`.`)
      )
    )
  }

  // `title: null` — the Milestone title is free text (settled decision: the
  // version comes from `Release:` alone, never the title), so `checkForgeTitle`'s
  // commit-style/task-style grammar (built for PR/Issue titles) does not apply.
  const sections = resolveSections('milestone', RETRY_CREATE)
  const schemaErrors = validateForgeWrite({ body, title: null, sections, changedFiles: [], retryCommand: RETRY_CREATE })
  if (schemaErrors.length > 0) refuse(schemaErrors)

  if (validateOnly) {
    if (json) printJson({ validated: true, written: false, command: 'milestone create' })
    else process.stdout.write('✓ all brief-schema gates PASS — nothing written (--validate-only).\n')
    return
  }

  const repo = await detectGitRepo()
  if (!repo?.owner || !repo.repo) {
    refuse([
      makeCheckError(
        'forge-fetch',
        'Could not resolve a GitHub owner/repo from the `origin` remote.',
        'Run this command from inside a git repository whose `origin` remote points at GitHub.'
      )
    ])
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  let out: string
  try {
    out = sh(
      ['gh', 'api', `repos/${repoFlag}/milestones`, '--input', '-'],
      JSON.stringify({ title, description: body })
    )
  } catch (e) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `\`gh api repos/${repoFlag}/milestones\` failed: ${((e as Error).message ?? '').split('\n')[0]}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY_CREATE}\`.`
      )
    ])
  }

  const created = JSON.parse(out) as { number: number; html_url: string }
  if (json) printJson({ validated: true, written: true, number: created.number, url: created.html_url })
  else process.stdout.write(`${created.html_url}\n`)
}
