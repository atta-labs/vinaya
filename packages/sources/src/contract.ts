/**
 * Re-exports the StateSource contract from `@attalabs/aeg-core` — the type lives
 * there (aeg-core's purity charter keeps the contract itself I/O-free); this
 * module is the adapter package's own named surface for it, so consumers
 * importing from `@attalabs/vinaya-sources` don't need to know the contract's
 * origin package.
 */
export type { StateSource } from '@attalabs/aeg-core'
export type { DoctrineContent, DoctrineSource } from '@attalabs/aeg-core'
