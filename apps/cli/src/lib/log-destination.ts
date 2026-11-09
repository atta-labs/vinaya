/**
 * Whether this process has a Log destination, answered from its environment alone so the program can decide at
 * startup, before the Log client loads, whether the exit record is worth loading it for.
 *
 * A dispatched process names its spool folder (`VINAYA_LOG_SPOOL_DIR`), which is a destination wherever it runs. A test
 * process (`NODE_ENV=test`, which `bun test` sets and its children inherit) has none, so a command a test starts
 * records nothing and loads nothing of the Log. Every other process resolves its destination from the `logs`
 * setting when the record is written, exactly as before.
 */
export function processHasLogDestination(env: NodeJS.ProcessEnv): boolean {
  const spool = env.VINAYA_LOG_SPOOL_DIR
  if (spool !== undefined && spool.trim() !== '') return true
  return env.NODE_ENV !== 'test'
}
