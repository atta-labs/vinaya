import type { NextConfig } from 'next'

const config: NextConfig = {
  // No `output: 'standalone'`: Studio runs behind its own custom server (`src/server/host.ts`), which Next's generated
  // standalone `server.js` cannot be combined with and whose files standalone output does not trace. The CLI packs
  // the production build, the host and their runtime dependencies explicitly (`apps/cli/scripts/bundle-studio.ts`).
  // Next.js offers an upgrade menu during `next build` by default. Builds run
  // under turbo (and inside `bun release`), where the menu gets no input and
  // the build hangs, so it is off; upgrades go through a normal change.
  experimental: { agentUpgrade: false },
  // These workspace packages ship raw .ts
  transpilePackages: ['@attalabs/process-vinaya', '@vinaya/cms', '@vinaya/ui']
}
export default config
