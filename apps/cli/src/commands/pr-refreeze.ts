/**
 * `vinaya pr refreeze <n> --reason <text>` (task 12, #387) — the door the
 * frozen body lacks: `aeg-root/roles/developer.md`'s PR body is written
 * once at open and never hand-edited again, but a Principal sometimes has a
 * real reason to edit it anyway (a wrong Tier, a typo in the title's
 * meaning, a field the Developer got wrong that review shouldn't have to
 * carry forward). Without this command that edit permanently reddens
 * `pr-body-frozen` — there was no way to move the baseline.
 *
 * Refuses unless the running `gh` identity is on the principal allowlist
 * (the same `isPrincipal`/`resolvePrincipalAllowlist`/`loadTrustAnchorConfig`
 * trust anchor `review-gate`/`pr-body-frozen` already use — never a
 * local-git/env-derived source). Posts a fresh `aeg:body-hash` marker over
 * the PR's LIVE body (fetched fresh, never a local draft) with the reason
 * in the same comment; `checkPrBodyFrozen`'s newest-allowlisted-wins
 * selection (`pr-body-frozen.ts`) picks this marker up from then on.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authoredRegionHash, isPrincipal, renderBodyHashMarker } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../checks/contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config'

const USAGE = 'Usage: vinaya pr refreeze <n> --reason <text>'

function refuse(check: string, message: string, agentRecoveryPrompt: string): never {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check,
    severity: 'error',
    message,
    agent_recovery_prompt: agentRecoveryPrompt
  })
  process.exit(1)
}

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new Error(String(stderr ?? (err as Error).message).trim() || 'gh command failed')
  }
}

function currentLogin(): string | null {
  try {
    const login = gh(['api', 'user', '-q', '.login']).trim()
    return login || null
  } catch {
    return null
  }
}

export async function prRefreezeCommand(args: string[]): Promise<void> {
  const prNumber = args[0]
  if (!prNumber || !/^\d+$/.test(prNumber) || prNumber.startsWith('--')) {
    console.error(USAGE)
    process.exit(2)
  }

  const reasonIdx = args.indexOf('--reason')
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined
  if (!reason) {
    console.error(`vinaya pr refreeze: refused — --reason <text> is required.\n${USAGE}`)
    process.exit(2)
  }

  const login = currentLogin()
  const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  if (!isPrincipal(login, principalAllowlist)) {
    refuse(
      'pr-body-frozen',
      `pr refreeze: refused — the running \`gh\` identity (${login ?? 'unresolvable'}) is not on the principal allowlist. Only a Principal may move the frozen-body baseline.`,
      'Run this command authenticated as a configured principal (`gh auth status` to check the current identity), then retry.'
    )
  }

  let liveBody: string
  try {
    liveBody = gh(['pr', 'view', prNumber, '--json', 'body', '-q', '.body'])
  } catch (err) {
    refuse(
      'pr-body-frozen',
      `pr refreeze: refused — could not fetch PR ${prNumber}'s live body: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status` and network, then retry.'
    )
  }

  const hash = authoredRegionHash(liveBody)
  const marker = renderBodyHashMarker(hash)
  const commentBody = `${marker}\n\nRefrozen by @${login}: ${reason}`

  const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-refreeze-'))
  const tmp = join(dir, 'comment.md')
  writeFileSync(tmp, commentBody)
  try {
    gh(['pr', 'comment', prNumber, '--body-file', tmp])
  } catch (err) {
    refuse(
      'pr-body-frozen',
      `pr refreeze: refused — posting the refreeze marker comment on PR ${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`,
      `Post the comment manually: \`gh pr comment ${prNumber} --body "${marker}"\`, then confirm with \`gh pr view ${prNumber} --json comments\`.`
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  process.stdout.write(`Refroze PR ${prNumber} at ${hash}\n`)
}
