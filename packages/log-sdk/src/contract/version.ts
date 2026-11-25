import manifest from '../../package.json' with { type: 'json' }

/**
 * The SDK's own version: the `version` field of this package's `package.json`, imported relative to this module,
 * which is the package root from both `src/contract/` and `dist/contract/`. A bundler that inlines this module
 * inlines the manifest's value with it. Recorded on every handle's resource and as its instrumentation scope's version.
 */
export const SDK_VERSION: string = manifest.version
