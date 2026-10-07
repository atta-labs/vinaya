import { describe, expect, it } from 'bun:test'
import './test-env-preload'
import { spawnSyncBudgeted } from './process-fixture'

// Imported explicitly: the hook's selected-file run starts at the repository
// root, where `apps/cli/bunfig.toml`'s preload is not read, so the test must
// not depend on the runner having loaded it. The module is cached, so a run
// that did load it executes it once.
describe('the test preload removes the log server credentials', () => {
  it('leaves neither log token in this process', () => {
    expect(process.env.VINAYA_LOG_TOKEN).toBeUndefined()
    expect(process.env.VINAYA_LOG_READ_TOKEN).toBeUndefined()
  })

  it('leaves a child started with the inherited environment seeing neither token', () => {
    const child = spawnSyncBudgeted(
      'sh',
      ['-c', 'printf "%s|%s" "$' + '{VINAYA_LOG_TOKEN-unset}" "$' + '{VINAYA_LOG_READ_TOKEN-unset}"'],
      { env: process.env, encoding: 'utf8' }
    )
    expect(child.stdout).toBe('unset|unset')
  })
})
