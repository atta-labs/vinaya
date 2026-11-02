/**
 * The standalone driver's module sits in the process package, so the nearest `package.json` to it is the
 * process's own. Its runner version is still the CLI package's: the default names that package, and the checkout
 * it walks from to the process definition is still the one the CLI package sits in.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setStandaloneLogIdentity } from '../../../../loops/dev-review/standalone/dev-review-loop.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..')

function versionOf(folder: string): string {
  return (JSON.parse(readFileSync(join(REPO_ROOT, folder, 'package.json'), 'utf8')) as { version: string }).version
}

describe('setStandaloneLogIdentity — the runner version is the CLI package’s, from source', () => {
  it('stamps the CLI package version, never the version of the process package that holds the driver', async () => {
    const env: NodeJS.ProcessEnv = {}
    await setStandaloneLogIdentity(env)
    expect(env.VINAYA_RUNNER_ID).toBe('standalone')
    expect(env.VINAYA_RUNNER_VERSION).toBe(versionOf('apps/cli'))
    expect(versionOf('apps/cli')).not.toBe(versionOf('harness/processes/vinaya-strict'))
    // The process identity is read from the checkout the CLI package sits in, so it resolves too.
    expect(env.VINAYA_PROCESS_ID).toBe('vinaya')
  })
})
