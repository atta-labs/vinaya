// `vinaya log emit <event>` — the call a script or agent outside Vinaya
// makes to record its own declared event (O1/O2/O3). It reads the field
// values as one JSON object — `--json '<json>'` or standard input, never
// positional arguments, since the declared fields are flat and typed — and
// records them through `emitCustomEvent` (`harness/kernel/log/log.md` § Custom
// events), the same chokepoint every other custom-event caller goes
// through: one `log.custom.recorded` record for a declared event, or one
// `log.command.completed` refusal, written through the run's Log handle.
//
// A declared event with every field present and of its declared type exits
// 0 and prints the event name and the kind of destination it was recorded
// toward (folder, server, or none — `log()`'s own sanctioned "nothing
// configured" outcome) — never the field values. A refused event (an
// undeclared name, a missing, extra, wrong-typed or too-long field) exits 1
// and prints the reason class and the field names `checkCustomEvent`
// reports — never a value, since a rejected value may be the secret. A
// missing event name, unreadable JSON, or JSON that is not a flat object is
// a usage error: exit 2, before anything is recorded.
//
// A process with `VINAYA_WORK_REF` set files the record under that work
// reference; the run's local copy is then sent to the configured OpenTelemetry
// address by the run recorder's drain (`sendLocalCopy`), and the command
// reports where the event went.

import { isEntryPoint } from '../../../../kernel/gates/checks/entry-point.js'
import { EMIT_USAGE, readFields } from '@attalabs/vinaya-log-sdk'
import { join } from 'node:path'
import { resolveRepo } from '../../../../kernel/adapters/code-host/github/resolve-repo'
import { loadConfig, loadTrustAnchorConfigAsync } from '../config/compose.js'
import { emitCustomEvent, type EmitCustomEventResult } from '../../../../kernel/log/client/log-custom.js'
import {
  LOG_DESTINATION_ANCHOR_DEADLINE_MS,
  processLocalCopyPlace,
  resolveLogDestinationFrom,
  withDeadline,
  type ResolvedLogDestination
} from '../../../../kernel/log/log-sink.js'
import { runRecorder } from '../../../../kernel/log/run-recorder.js'
import { isUnattendedProcess, repoRootSync, runtimeDirForRepoAsync } from '../../../../kernel/run-paths.js'

export type LogEmitDeps = {
  /** Records the event through the one chokepoint every custom event goes through — `emitCustomEvent`; `repository` is the one the record is filed under. */
  emit: (name: string, fields: Readonly<Record<string, unknown>>, repository?: string) => EmitCustomEventResult
  /** The repository (`owner/repo`) the process is in, when it can tell. */
  repository: () => Promise<string | undefined>
  /** The kind of destination THIS process's own event just went toward — the sink's own decision, resolved the same way a live event's does. */
  resolveDestinationKind: () => Promise<ResolvedLogDestination['kind']>
  /** Waits for the just-recorded event to land in the run's local copy and sends the copy to the OpenTelemetry address — the run recorder's drain. */
  drain: () => Promise<void>
  /** The field values as raw JSON text, read from standard input when `--json` is absent. */
  readStdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

async function readStdinReal(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The destination THIS event just went toward, resolved the SAME way a live
 * event does — `resolveLogDestinationFrom` over `vinaya.config.json`'s
 * `logs` setting, trust-anchor-gated for an unattended caller, bounded by
 * the identical deadline — never a destination forced unattended the way
 * `log selftest` deliberately forces it. A human running this command by
 * hand (the Test Plan's own `[principal]` scenario) gets the attended
 * resolution, honoring the working tree directly, exactly as `log send`
 * already does.
 */
async function resolveDestinationKindReal(): Promise<ResolvedLogDestination['kind']> {
  // Recording off writes nothing, whatever the settings name as a destination.
  if (processLocalCopyPlace(await repositoryReal()) === undefined) return 'none'
  const repo = await resolveRepo()
  const localConfig = loadConfig()
  const unattended = isUnattendedProcess(process.env)
  const trustAnchorConfig = unattended
    ? await withDeadline(
        loadTrustAnchorConfigAsync(undefined, { quiet: true }),
        LOG_DESTINATION_ANCHOR_DEADLINE_MS,
        null
      )
    : null
  const defaultFolder = join(await runtimeDirForRepoAsync(repo), 'logs')
  return resolveLogDestinationFrom({
    localConfig,
    trustAnchorConfig,
    unattended,
    env: process.env,
    defaultFolder,
    repoRoot: repoRootSync()
  }).kind
}

/** The repository the record is filed under: the one the environment names, else the checkout's own. */
async function repositoryReal(): Promise<string | undefined> {
  if (process.env.VINAYA_REPO) return process.env.VINAYA_REPO
  try {
    const repo = await resolveRepo()
    return repo === null ? undefined : `${repo.owner}/${repo.repo}`
  } catch {
    return undefined
  }
}

export function realLogEmitDeps(): LogEmitDeps {
  return {
    emit: (name, fields, repository) =>
      emitCustomEvent(name, fields, {
        ...(repository === undefined ? {} : { repository }),
        ...(process.env.VINAYA_WORK_REF ? { workRef: process.env.VINAYA_WORK_REF } : {})
      }),
    repository: () => repositoryReal(),
    resolveDestinationKind: () => resolveDestinationKindReal(),
    drain: () => runRecorder().drain(),
    readStdin: () => readStdinReal(),
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
}

/**
 * `vinaya log emit <event>` — exit 0 with the name and destination kind
 * (O1), exit 1 with the refusal reason and field names (O2's refusal case),
 * or exit 2 with a usage message (O2's usage case). Never prints a field
 * value in any of the three.
 */
export async function logEmitCommand(args: string[], deps: LogEmitDeps = realLogEmitDeps()): Promise<number> {
  const parsed = await readFields(args, deps.readStdin)
  if (!parsed.ok) {
    deps.stderr((parsed.message === undefined ? '' : `vinaya log emit: ${parsed.message}\n`) + EMIT_USAGE)
    return 2
  }

  const result = deps.emit(parsed.name, parsed.fields, await deps.repository())
  if (!result.ok) {
    const fieldsNote = result.fieldNames.length > 0 ? ` (fields: ${result.fieldNames.join(', ')})` : ''
    deps.stderr(`vinaya log emit: refused — ${result.reason}${fieldsNote}\n`)
    return 1
  }

  await deps.drain()
  const kind = await deps.resolveDestinationKind()
  deps.stdout(`vinaya log emit: recorded ${result.name} → ${kind}\n`)
  return 0
}

// `log emit` deliberately composes several lib helpers rather than routing
// through one chokepoint, the same shape `log send` and `log selftest`
// already carry: it records through `emitCustomEvent` and separately
// resolves the destination it just recorded toward the SAME way a live
// event does (config + run-paths + the pure `resolveLogDestinationFrom`),
// since there is no single lib function that both records a custom event
// AND reports the destination it landed on, and inventing a façade to
// satisfy the one-call rule would only hide the wiring a reader needs to
// see. The retirement target is the same future `log-delivery.ts` those two
// commands already name.

// Run as a program (`vinaya-log-emit`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'log-emit')) {
  const { runProgram } = await import('../../tools/program-entry.js')
  await runProgram('log-emit', async (argv: string[]) => {
    process.exit(await logEmitCommand(argv))
  })
}
