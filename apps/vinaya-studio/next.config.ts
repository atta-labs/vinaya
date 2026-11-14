import type { NextConfig } from 'next'

const config: NextConfig = {
  // One self-contained server folder (`.next/standalone`), which the CLI packs and starts on the user's machine
  output: 'standalone',
  // Next.js offers an upgrade menu during `next build` by default. Builds run
  // under turbo (and inside `bun release`), where the menu gets no input and
  // the build hangs, so it is off; upgrades go through a normal change.
  experimental: { agentUpgrade: false },
  // These workspace packages ship raw .ts
  transpilePackages: ['@attalabs/process-vinaya', '@vinaya/cms', '@vinaya/ui']
}
export default config
