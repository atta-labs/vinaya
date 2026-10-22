/**
 * The parent-environment variables an agent child process is given; nothing
 * else is forwarded. PATH and HOME locate the tools and the agent's own
 * config; USER and LOGNAME are needed for the macOS Keychain lookup the
 * subscription login reads its credential through. `extra` names any further
 * variable the calling process forwards (a sandbox opt-in, say); the harness
 * names none of its own.
 */
export function agentEnvAllowlist(options: { extra?: readonly string[] } = {}): string[] {
  return ['PATH', 'HOME', 'USER', 'LOGNAME', ...(options.extra ?? [])]
}
