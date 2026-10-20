'use client'

import { Fragment } from 'react'

/**
 * Text revealed letter by letter by a progress value, not a timer: the
 * reader's scroll drives it, so it plays forward and back at their pace.
 * Each letter fades in and rises 4px over a short window of `progress`;
 * the windows overlap so the text reads as a wave. Words never break.
 * Under reduced motion pass `progress = 1`.
 */
export function ScrubLetters({ text, progress }: { text: string; progress: number }) {
  const total = Math.max(1, text.replace(/ /g, '').length)
  const per = 1 / total
  // Each word with the index of its first letter, so letters key on their place in the text.
  const words: { word: string; at: number }[] = []
  let at = 0
  for (const word of text.split(' ')) {
    words.push({ word, at })
    at += word.length
  }
  const reveal = (i: number) => Math.min(1, Math.max(0, (progress - i * per * 0.65) / (per * 2.2 + 0.02)))
  return (
    <>
      <span className='sr-only'>{text}</span>
      <span aria-hidden>
        {words.map(({ word, at }, w) => (
          <Fragment key={`w${at}`}>
            <span className='inline-block whitespace-nowrap'>
              {[...word].map((ch, j) => {
                const t = reveal(at + j)
                return (
                  <span
                    key={`c${at + j}`}
                    className='inline-block'
                    style={{ opacity: t, transform: `translateY(${((1 - t) * 4).toFixed(2)}px)` }}
                  >
                    {ch}
                  </span>
                )
              })}
            </span>
            {w < words.length - 1 ? ' ' : ''}
          </Fragment>
        ))}
      </span>
    </>
  )
}
