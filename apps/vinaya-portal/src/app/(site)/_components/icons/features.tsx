import { DOT, Glyph, LINE, MARK } from './glyph'

// The five features' icons.

export function LogIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='8.259 7.259 39.481 41.481'>
      <rect x='9' y='8' width='38' height='40' rx='4' {...LINE} />
      <path d='M17 19h14M17 27h22M17 35h18' {...LINE} />
      <circle cx='40' cy='19' r='3' {...DOT} />
    </Glyph>
  )
}

export function TelemetryIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='8.296 8.296 39.407 39.407'>
      <path d='M9 47h38' {...LINE} />
      <rect x='12' y='31' width='7' height='12' rx='1.5' {...LINE} />
      <rect x='24.5' y='20' width='7' height='23' rx='1.5' {...LINE} />
      <rect x='37' y='9' width='7' height='34' rx='1.5' {...LINE} {...DOT} />
    </Glyph>
  )
}

export function StudioIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <rect x='6' y='6' width='44' height='34' rx='4' {...LINE} />
      <path d='M20 50h16M28 40v10' {...LINE} />
      <path d='M12 30l7-7 6 5 8-9' {...MARK} />
      <circle cx='42' cy='14' r='3' {...DOT} />
    </Glyph>
  )
}

export function SelfImprovementIcon({ className }: { className?: string }) {
  return (
    // the eye that watches its own work, and the infinity for its pupil: it never stops looking, never stops improving
    <Glyph className={className} viewBox='3.111 11.111 49.778 33.778'>
      <path d='M4 28c7-11 15-16 24-16s17 5 24 16c-7 11-15 16-24 16S11 39 4 28z' {...LINE} />
      <path
        d='M28 28c-3-3.5-5-5-7.5-5a5 5 0 0 0 0 10c2.5 0 4.5-1.5 7.5-5s5-5 7.5-5a5 5 0 0 1 0 10c-2.5 0-4.5-1.5-7.5-5z'
        {...MARK}
      />
    </Glyph>
  )
}

export function ConfigurationIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.185 5.185 41.63 45.63'>
      <path d='M8 6h26l14 14v30H8zM34 6v14h14' {...LINE} />
      <path d='M23 28l-5 6 5 6M33 28l5 6-5 6' {...MARK} />
    </Glyph>
  )
}
