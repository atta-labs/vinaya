import { DOT, Glyph, LINE, MARK } from './glyph'

// The Log's parts.

export function EventContractIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='8.259 7.259 39.481 41.481'>
      <path
        d='M20 8c-5 0-6 3-6 7v6c0 3-2 5-5 7 3 2 5 4 5 7v6c0 4 1 7 6 7M36 8c5 0 6 3 6 7v6c0 3 2 5 5 7-3 2-5 4-5 7v6c0 4-1 7-6 7'
        {...LINE}
      />
      <circle cx='28' cy='28' r='3' {...DOT} />
    </Glyph>
  )
}

export function DeliveryIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.256 9.07 41.674 39.674'>
      <path d='M8 27l40-17-15 38-6-15z' {...LINE} />
      <path d='M27 33l21-23' {...MARK} />
    </Glyph>
  )
}

export function CustomEventsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <rect x='8' y='8' width='40' height='40' rx='6' {...LINE} />
      <path d='M28 18v20M18 28h20' {...MARK} />
    </Glyph>
  )
}

export function RedactionIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <rect x='8' y='8' width='40' height='40' rx='4' {...LINE} />
      <path d='M16 20h10M16 36h14' {...LINE} />
      <rect x='30' y='17' width='12' height='6' rx='1.5' {...DOT} />
      <rect x='34' y='33' width='8' height='6' rx='1.5' {...DOT} />
      <path d='M16 28h24' {...LINE} />
    </Glyph>
  )
}
