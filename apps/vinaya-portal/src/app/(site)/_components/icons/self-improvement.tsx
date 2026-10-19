import { Glyph, LINE, MARK } from './glyph'

// Self-improvement's three steps.

export function ImproverIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='4.148 12.148 47.704 31.704'>
      <path d='M5 28c6-10 14-15 23-15s17 5 23 15c-6 10-14 15-23 15S11 38 5 28z' {...LINE} />
      <circle cx='28' cy='28' r='6' {...MARK} />
    </Glyph>
  )
}

export function ProposalIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='12.259 6.259 31.481 41.481'>
      <path d='M28 7a15 15 0 0 0-9 27c2 2 3 4 3 7h12c0-3 1-5 3-7a15 15 0 0 0-9-27z' {...LINE} />
      <path d='M22 47h12' {...LINE} />
      <path d='M24 25l4 5 4-5' {...MARK} />
    </Glyph>
  )
}

export function ApprovalIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.219 7.219 43.758 41.563'>
      <circle cx='22' cy='17' r='9' {...LINE} />
      <path d='M6 48c0-9 7-16 16-16 3 0 6 1 8 3' {...LINE} />
      <path d='M32 40l5 5 11-12' {...MARK} />
    </Glyph>
  )
}
