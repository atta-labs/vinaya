import { describe, expect, it } from 'bun:test'

describe('the test preload removes the log server credentials', () => {
  it('leaves neither log token in this process', () => {
    expect(process.env.VINAYA_LOG_TOKEN).toBeUndefined()
    expect(process.env.VINAYA_LOG_READ_TOKEN).toBeUndefined()
  })

  it('leaves a child started with the inherited environment seeing neither token', () => {
    const child = Bun.spawnSync(
      ['sh', '-c', 'printf "%s|%s" "$' + '{VINAYA_LOG_TOKEN-unset}" "$' + '{VINAYA_LOG_READ_TOKEN-unset}"'],
      { env: process.env }
    )
    expect(child.stdout.toString()).toBe('unset|unset')
  })
})
