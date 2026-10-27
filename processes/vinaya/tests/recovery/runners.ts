// The recovery suite: one shared place for the interruption and recovery cases every runner must survive.
// Each owner adds its cases to its own file in this folder, so parallel work never conflicts. A case runs against
// every runner it applies to; a case that only one runner can reach names that runner alone.

/** The runners a recovery case can run against. */
export type RecoveryRunner = 'standalone' | 'engine-v1' | 'engine-v2'

export const ALL_RUNNERS: readonly RecoveryRunner[] = ['standalone', 'engine-v1', 'engine-v2']

/** The Engine runners only, for cases about checkpoints, the dev-tools host or the Engine dispatch path. */
export const ENGINE_RUNNERS: readonly RecoveryRunner[] = ['engine-v1', 'engine-v2']
