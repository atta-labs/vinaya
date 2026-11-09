import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Whether the working directory's `vinaya.config.json` declares a `logs.folder`, read as plain JSON so no configuration provider loads. */
function declaresLogsFolder(cwd: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(cwd, 'vinaya.config.json'), 'utf8')) as { logs?: { folder?: unknown } }
    return typeof config.logs === 'object' && config.logs !== null && typeof config.logs.folder === 'string'
  } catch {
    return false
  }
}

/**
 * Whether this process has a Log destination, answered without loading the Log client, so the program can decide at
 * startup whether the exit record is worth loading it for.
 *
 * Outside a test run (`NODE_ENV` not `test`) every process has one: its destination resolves from the `logs` setting
 * when the record is written, exactly as before. In a test run a process has one only when it names a spool folder
 * (`VINAYA_LOG_SPOOL_DIR`) or its working directory's `vinaya.config.json` declares a `logs.folder`; a test that starts
 * a command with neither records nothing and loads nothing of the Log. The signal is the caller's environment, so it
 * is no defence against a caller that controls the process; the record is an audit aid, not a tamper-proof trail.
 */
export function processHasLogDestination(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): boolean {
  const spool = env.VINAYA_LOG_SPOOL_DIR
  if (spool !== undefined && spool.trim() !== '') return true
  if (env.NODE_ENV !== 'test') return true
  return declaresLogsFolder(cwd)
}
