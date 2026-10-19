import { DOT, Glyph, LINE, MARK } from './glyph'

// The harness, its parts and how you install it.

export function VinayaHarnessIcon({ className }: { className?: string }) {
  // the four joints sit over the ring, filled with the page so the ring breaks behind them
  const joint = { ...LINE, className: 'fill-background' }
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <circle cx='28' cy='28' r='19' {...LINE} />
      <circle cx='28' cy='9' r='3' {...joint} />
      <circle cx='47' cy='28' r='3' {...joint} />
      <circle cx='28' cy='47' r='3' {...joint} />
      <circle cx='9' cy='28' r='3' {...joint} />
      <circle cx='28' cy='28' r='6' {...DOT} />
    </Glyph>
  )
}

export function FeaturesIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <rect x='8' y='8' width='17' height='17' rx='3' {...LINE} />
      <rect x='31' y='8' width='17' height='17' rx='3' {...LINE} />
      <rect x='8' y='31' width='17' height='17' rx='3' {...LINE} />
      <rect x='31' y='31' width='17' height='17' rx='3' {...LINE} {...DOT} />
    </Glyph>
  )
}

export function DevProcessIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.181 5.181 41.637 45.842'>
      <path d='M18 6v10M38 6v10' {...LINE} />
      <path d='M8 16h40v8a20 20 0 0 1-40 0z' {...LINE} />
      <path d='M28 44v6' {...MARK} />
    </Glyph>
  )
}

export function GetStartedIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='16.068 6.219 23.865 43.758'>
      <path d='M28 7c8 5 12 13 11 24l-6 6H23l-6-6c-1-11 3-19 11-24z' {...LINE} />
      <circle cx='28' cy='22' r='4' {...DOT} />
      <path d='M22 41l-3 8M34 41l3 8M28 41v8' {...MARK} />
    </Glyph>
  )
}

export function CliIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <rect x='6' y='6' width='44' height='44' rx='4' {...LINE} />
      <path d='M28 37h13' {...LINE} />
      <path d='M15 21l8 7-8 7' {...MARK} />
    </Glyph>
  )
}
