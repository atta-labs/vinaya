import { DOT, Glyph, LINE, MARK } from './glyph'

// The Vinaya process and its parts.

export function VinayaProcessIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='6.222 8.222 43.556 39.556'>
      <circle cx='12' cy='28' r='5' {...LINE} />
      <circle cx='28' cy='28' r='5' {...LINE} />
      <circle cx='44' cy='28' r='5' {...LINE} {...DOT} />
      <path d='M17 28h6M33 28h6' {...LINE} />
      <path d='M7 9h42M7 47h42' {...LINE} strokeDasharray='2 5' />
    </Glyph>
  )
}

export function IntegrationIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 7.185 45.63 41.63'>
      <rect x='6' y='8' width='18' height='40' rx='4' {...LINE} />
      <rect x='32' y='8' width='18' height='40' rx='4' {...LINE} />
      <path d='M18 28h20' {...MARK} />
    </Glyph>
  )
}

export function GatesIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <path d='M28 6l22 8v12c0 13-9 21-22 24-13-3-22-11-22-24V14z' {...LINE} />
      <path d='M19 28l7 7 12-13' {...MARK} />
    </Glyph>
  )
}
