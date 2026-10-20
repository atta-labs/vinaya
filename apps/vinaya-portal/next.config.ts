import type { NextConfig } from 'next'

const config: NextConfig = {
  // The portal's docs read the installed doctrine at build time; @attalabs packages ship raw .ts
  transpilePackages: ['@attalabs/aeg-core', '@attalabs/aeg-forge-state', '@attalabs/vinaya-sources'],
  // The docs read their Markdown from disk with a computed path, which tracing cannot see.
  outputFileTracingIncludes: { '/docs/**': ['./src/content/docs-tree/**'] },
  images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.sanity.io' }] },
  // The old docs and the old life-cycle page land on their new homes.
  async redirects() {
    return [
      { source: '/product/gates', destination: '/docs/process/gates', permanent: true },
      { source: '/product/:feature(log|configuration)', destination: '/docs/features/:feature', permanent: true },
      { source: '/product/dev-process', destination: '/docs/dev-process/overview', permanent: true },
      { source: '/product', destination: '/docs/features', permanent: true },
      { source: '/docs/config', destination: '/docs/features/configuration', permanent: true },
      { source: '/docs/rings/:path*', destination: '/docs/process/gates', permanent: true },
      { source: '/docs/reference', destination: '/docs/process/roles', permanent: true },
      { source: '/docs/state-machine', destination: '/docs/process', permanent: true },
      // Two docs sets, each with its entry page at its prefix; /docs lands on The Vinaya harness.
      { source: '/docs', destination: '/docs/start', permanent: true },
      { source: '/docs/features/overview', destination: '/docs/features', permanent: true },
      { source: '/docs/process/overview', destination: '/docs/process', permanent: true },
      { source: '/docs/features/get-started', destination: '/docs/start/get-started', permanent: true },
      { source: '/docs/features/cli', destination: '/docs/start/cli', permanent: true },
      { source: '/docs/cli', destination: '/docs/start/cli', permanent: true },
      { source: '/docs/cli/:path*', destination: '/docs/start/cli/:path*', permanent: true },
      { source: '/docs/harness', destination: '/docs/features', permanent: true },
      { source: '/docs/harness/gates', destination: '/docs/process/gates', permanent: true },
      {
        source: '/docs/harness/your-own-process/:path*',
        destination: '/docs/dev-process/:path*',
        permanent: true
      },
      { source: '/docs/harness/:path*', destination: '/docs/features/:path*', permanent: true },
      // Dev Process left Features; Reading back became the Telemetry feature.
      { source: '/docs/features/dev-process', destination: '/docs/dev-process/overview', permanent: true },
      { source: '/docs/features/dev-process/:path*', destination: '/docs/dev-process/:path*', permanent: true },
      { source: '/docs/dev-process', destination: '/docs/dev-process/overview', permanent: true },
      { source: '/docs/features/log/reading-back', destination: '/docs/features/telemetry', permanent: true },
      { source: '/docs/process/configuration', destination: '/docs/process/vinaya-keys', permanent: true },
      {
        source: '/docs/process/gates/gate-mechanisms',
        destination: '/docs/process/gates/mechanisms-outside-the-registry',
        permanent: true
      },
      // Old standalone pages, removed: each lands on its docs page.
      { source: '/the-studio', destination: '/docs/features/studio', permanent: true },
      { source: '/the-harness', destination: '/docs/start/get-started', permanent: true },
      { source: '/cli', destination: '/docs/start/cli', permanent: true },
      { source: '/install', destination: '/docs/start/cli', permanent: true },
      { source: '/config', destination: '/docs/features/configuration', permanent: true },
      { source: '/state-machine', destination: '/docs/process', permanent: true },
      { source: '/compare', destination: '/docs/start', permanent: true },
      { source: '/life-cycle', destination: '/vinaya-process', permanent: true },
      { source: '/process', destination: '/vinaya-process', permanent: true }
    ]
  }
}
export default config
