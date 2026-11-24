import { createRequire } from 'node:module'

/**
 * The SDK's own version: the `version` field of this package's `package.json`, read relative to this module,
 * which is the package root from both `src/contract/` and `dist/contract/`. Recorded on every handle's
 * resource and as its instrumentation scope's version.
 */
export const SDK_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
