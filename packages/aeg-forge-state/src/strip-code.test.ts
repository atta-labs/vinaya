import { describe, expect, it } from 'vitest'
import { maskCode, maskDetailsBlocks } from './strip-code'

/** A masked-out region reads as all-space lines; a live one keeps its text. */
function isBlank(line: string): boolean {
  return line.trim() === ''
}

describe('maskDetailsBlocks (fix/body-bare-digits)', () => {
  it('masks a single <details>...</details> block, index-preserving', () => {
    const body = ['before', '<details>', 'inside', '</details>', 'after'].join('\n')
    const masked = maskDetailsBlocks(body)
    const lines = masked.split('\n')
    expect(lines[0]).toBe('before')
    expect(isBlank(lines[1] as string)).toBe(true)
    expect(isBlank(lines[2] as string)).toBe(true)
    expect(isBlank(lines[3] as string)).toBe(true)
    expect(lines[4]).toBe('after')
    expect(masked.length).toBe(body.length)
  })

  it('masks nested <details> blocks as one region, not closing early on the inner </details>', () => {
    const body = ['<details>', 'outer', '<details>', 'inner', '</details>', 'still outer', '</details>', 'after'].join(
      '\n'
    )
    const masked = maskDetailsBlocks(body)
    const lines = masked.split('\n')
    for (let i = 0; i < 7; i++) expect(isBlank(lines[i] as string)).toBe(true)
    expect(lines[7]).toBe('after')
  })

  it('masks multiple sibling <details> blocks independently, leaving the gap between them live', () => {
    const body = ['<details>', 'a', '</details>', 'live text', '<details>', 'b', '</details>'].join('\n')
    const masked = maskDetailsBlocks(body)
    const lines = masked.split('\n')
    expect(isBlank(lines[0] as string)).toBe(true)
    expect(isBlank(lines[1] as string)).toBe(true)
    expect(isBlank(lines[2] as string)).toBe(true)
    expect(lines[3]).toBe('live text')
    expect(isBlank(lines[4] as string)).toBe(true)
    expect(isBlank(lines[5] as string)).toBe(true)
    expect(isBlank(lines[6] as string)).toBe(true)
  })

  it('fails closed on an unterminated <details> — masks to end of body', () => {
    const body = ['<details>', 'never closed', 'still open'].join('\n')
    const masked = maskDetailsBlocks(body)
    for (const line of masked.split('\n')) expect(isBlank(line)).toBe(true)
  })

  it('leaves a stray, unmatched </details> untouched — inert text, not a region boundary', () => {
    const body = ['live before', '</details>', 'live after'].join('\n')
    expect(maskDetailsBlocks(body)).toBe(body)
  })

  it('a <details> tag quoted inside a fenced code block is inert by the time maskDetailsBlocks runs (correct call order)', () => {
    const body = ['```', '<details>quoted example</details>', '```', 'live: 42'].join('\n')
    // The load-bearing order: maskCode first neutralizes the fenced decoy
    // tag into filler, so maskDetailsBlocks never sees a real tag there.
    const masked = maskDetailsBlocks(maskCode(body))
    const lines = masked.split('\n')
    expect(isBlank(lines[0] as string)).toBe(true)
    expect(isBlank(lines[1] as string)).toBe(true)
    expect(isBlank(lines[2] as string)).toBe(true)
    expect(lines[3]).toBe('live: 42')
  })

  it('reversing the call order lets a fenced decoy tag corrupt real content (documents why order is load-bearing)', () => {
    const body = ['```', '<details>', '```', 'real content between the fence and a real close', '</details>'].join('\n')
    // maskDetailsBlocks BEFORE maskCode: the decoy `<details>` inside the
    // fence is a real, unmasked tag at this point, so it opens a region
    // that swallows genuine content all the way to the real `</details>`.
    const wrongOrder = maskCode(maskDetailsBlocks(body))
    const wrongLines = wrongOrder.split('\n')
    expect(isBlank(wrongLines[3] as string)).toBe(true) // corrupted: real content lost

    // Correct order recovers it.
    const rightOrder = maskDetailsBlocks(maskCode(body))
    expect(rightOrder.split('\n')[3]).toBe('real content between the fence and a real close')
  })
})
