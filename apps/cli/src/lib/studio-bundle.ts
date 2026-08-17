/**
 * Shared between `scripts/bundle-studio.ts` (pack time) and
 * `commands/studio.ts` (run time). npm/bun's packer strips ANY directory
 * literally named `node_modules` from a published tarball, unconditionally
 * — confirmed live: `bun pm pack` silently drops the standalone Studio
 * bundle's `node_modules` (holding `next`, `react`, `sharp`, … —
 * `server.js`'s own real runtime requires), and the installed package then
 * fails at `require('next')`. `bundle-studio.ts` packs it under this name
 * instead; `studio.ts` renames it back on first run. The two must agree on
 * the exact name, hence one shared constant rather than two literals.
 */
export const STUDIO_NODE_MODULES_PACKED_DIRNAME = '_node_modules'

/**
 * Where `scripts/bundle-studio.ts` fetches the standalone build from.
 * `atta-labs/attalabs` is PUBLIC, so the release asset is downloadable over
 * plain HTTPS with no token — the `.github/workflows/vinaya-studio-artifact.yml`
 * workflow in that repo publishes it on every push to `main` that touches
 * Studio's build inputs, plus on manual `workflow_dispatch`. The tag is
 * rolling (force-updated on every publish), not a version — Studio's build
 * output has no version of its own to pin against, and `bundle-studio.ts`
 * always wants whatever attalabs `main` currently produces.
 */
export const STUDIO_ARTIFACT_OWNER = 'atta-labs'
export const STUDIO_ARTIFACT_REPO = 'attalabs'
export const STUDIO_ARTIFACT_RELEASE_TAG = 'studio-standalone-latest'
export const STUDIO_ARTIFACT_ASSET_NAME = 'studio-standalone.tar.gz'
