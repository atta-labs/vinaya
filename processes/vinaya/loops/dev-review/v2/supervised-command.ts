// The wrapper a supervised ready-push command runs under: `process.execPath supervised-command.ts <argv...>`, spawned
// as the leader of its own process group with five pipes. Descriptor 3 is the supervisor's control pipe and
// descriptor 4 the result channel; descriptors 0 to 2 are the command's own.
//
// The wrapper waits for one acknowledgement line on the control pipe, so no work starts before the supervisor has
// registered the group, then runs the command as its child in this same group, with the wrapper's stdin, stdout,
// stderr, environment and working directory reaching it by inheritance. Only descriptors 0 to 2 reach the command,
// so neither it nor a descendant can write to, or hold open, the result channel or the control pipe. The wrapper
// never reads stdin: the command receives it byte for byte.
//
// When the command exits, the wrapper writes one JSON line on the result channel — the exit code, or the name of the
// signal that terminated it — closes the channel, and stays alive as the group leader, so the supervisor can stop the
// group's leftover descendants through a verified live leader. End-of-file on the control pipe is the release: the
// wrapper kills its own process group, itself included, so a supervisor that dies never leaves a waiting wrapper, a
// running command or a leaderless group behind.

import { spawn } from 'node:child_process'
import { closeSync, createReadStream, writeSync } from 'node:fs'

/** The descriptor the supervisor writes the acknowledgement on, and closes to release the wrapper. */
export const CONTROL_FD = 3
/** The descriptor the wrapper writes the command's result on. */
export const RESULT_FD = 4

/** What the wrapper reports for the command on the result channel. */
export interface SupervisedCommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** Why the command could not be started, when it never ran. */
  error?: string
}

/** The wrapper's result line, or null when `text` holds none: a channel that ended without one carries no result. */
export function parseSupervisedCommandResult(text: string): SupervisedCommandResult | null {
  try {
    const value = JSON.parse(text.trim()) as { code?: unknown; signal?: unknown; error?: unknown }
    const code = typeof value.code === 'number' && Number.isInteger(value.code) ? value.code : null
    const signal = typeof value.signal === 'string' && value.signal !== '' ? (value.signal as NodeJS.Signals) : null
    const error = typeof value.error === 'string' ? value.error : undefined
    if (code === null && signal === null && error === undefined) return null
    return { code, signal, ...(error !== undefined ? { error } : {}) }
  } catch {
    return null
  }
}

function report(result: SupervisedCommandResult): void {
  try {
    writeSync(RESULT_FD, `${JSON.stringify(result)}\n`)
  } catch {
    // A supervisor that stopped reading has gone; the release below still ends the group.
  }
  try {
    closeSync(RESULT_FD)
  } catch {}
}

function main(argv: string[]): void {
  const [file, ...args] = argv
  let started = false
  let pending = ''
  const control = createReadStream('', { fd: CONTROL_FD, encoding: 'utf8' })
  control.on('data', (chunk) => {
    if (started) return
    pending += chunk
    if (!pending.includes('\n')) return
    started = true
    if (file === undefined) {
      report({ code: null, signal: null, error: 'no command was given' })
      return
    }
    const child = spawn(file, args, { stdio: ['inherit', 'inherit', 'inherit'] })
    child.on('error', (error) => report({ code: null, signal: null, error: error.message }))
    child.on('exit', (code, signal) => report({ code, signal }))
  })
  const release = () => {
    // Before the acknowledgement the group holds only this wrapper: nothing ran, so it simply exits.
    if (!started) process.exit(1)
    process.kill(0, 'SIGKILL')
  }
  control.on('end', release)
  control.on('error', release)
}

if (import.meta.main) main(process.argv.slice(2))
