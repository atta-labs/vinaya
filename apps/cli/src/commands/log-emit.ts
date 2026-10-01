// `vinaya log emit <event>` — the call a script or agent outside Vinaya
// makes to record its own declared event (O1/O2/O3). It reads the field
// values as one JSON object — `--json '<json>'` or standard input, never
// positional arguments, since the declared fields are flat and typed — and
// records them through `emitCustomEvent` (`apps/cli/specs/log.md` § Custom
// events), the same chokepoint every other custom-event caller goes
// through, so the refusal event and the redaction stay in one place.
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
// O3 needs no code of its own: a process with only `VINAYA_WORK_REF` and
// `VINAYA_FLOW` set, and no `VINAYA_ROLE`/`VINAYA_TASK`, already gets a
// header carrying that work reference and flow id — `log()`'s own
// `snapshot()` reads all four from the environment unconditionally, for
// every caller (`apps/cli/specs/log.md` § Attribution).

import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import { loadConfig, loadTrustAnchorConfigAsync } from '../lib/config.js'
import { emitCustomEvent, type EmitCustomEventResult } from '../lib/log-custom.js'
import {
  drainLogSink,
  LOG_DESTINATION_ANCHOR_DEADLINE_MS,
  resolveLogDestinationFrom,
  withDeadline,
  type ResolvedLogDestination
} from '../lib/log-sink.js'
import { isUnattendedProcess, repoRootSync, runtimeDirForRepoAsync } from '../lib/run-paths.js'

const USAGE = "Usage: vinaya log emit <event> --json '<json object>' (or pipe the JSON object on standard input)\n"

export type LogEmitDeps = {
  /** Records the event through the one chokepoint every custom event goes through — `emitCustomEvent`. */
  emit: (name: string, fields: Readonly<Record<string, unknown>>) => EmitCustomEventResult
  /** The kind of destination THIS process's own event just went toward — the sink's own decision, resolved the same way a live event's does. */
  resolveDestinationKind: () => Promise<ResolvedLogDestination['kind']>
  /** Waits for the just-recorded event to land before the process exits — `drainLogSink`. */
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

export function realLogEmitDeps(): LogEmitDeps {
  return {
    emit: (name, fields) => emitCustomEvent(name, fields),
    resolveDestinationKind: () => resolveDestinationKindReal(),
    drain: () => drainLogSink(),
    readStdin: () => readStdinReal(),
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
}

/** The event name and the raw JSON text, or `null` when the shape itself is wrong (O2's usage case) — before any JSON parsing is attempted. */
async function parseArgs(
  args: string[],
  readStdin: () => Promise<string>
): Promise<{ name: string; raw: string } | null> {
  const name = args[0]
  if (!name || name.startsWith('-')) return null
  const flagIndex = args.indexOf('--json')
  if (flagIndex === -1) return { name, raw: await readStdin() }
  const value = args[flagIndex + 1]
  if (value === undefined) return null
  return { name, raw: value }
}

/**
 * `vinaya log emit <event>` — exit 0 with the name and destination kind
 * (O1), exit 1 with the refusal reason and field names (O2's refusal case),
 * or exit 2 with a usage message (O2's usage case). Never prints a field
 * value in any of the three.
 */
export async function logEmitCommand(args: string[], deps: LogEmitDeps = realLogEmitDeps()): Promise<number> {
  const parsedArgs = await parseArgs(args, deps.readStdin)
  if (parsedArgs === null) {
    deps.stderr(USAGE)
    return 2
  }

  let fields: unknown
  try {
    fields = JSON.parse(parsedArgs.raw)
  } catch {
    deps.stderr(`vinaya log emit: the JSON could not be read.\n${USAGE}`)
    return 2
  }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    deps.stderr(`vinaya log emit: the field values must be a JSON object.\n${USAGE}`)
    return 2
  }

  const result = deps.emit(parsedArgs.name, fields as Record<string, unknown>)
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

import type { SurfaceExemption } from '../lib/surface-exemption'

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
export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'log emit': { date: '2026-10-01', callsToday: 9, retiresVia: 'logDeliveryChokepoint' }
}
