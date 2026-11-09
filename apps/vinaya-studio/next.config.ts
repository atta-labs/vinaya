import type { NextConfig } from 'next'

const config: NextConfig = {
  // One self-contained server folder (`.next/standalone`), which the CLI packs and starts on the user's machine
  output: 'standalone',
  // These workspace packages ship raw .ts
  transpilePackages: ['@attalabs/process-vinaya', '@vinaya/cms', '@vinaya/ui']
}
export default config
