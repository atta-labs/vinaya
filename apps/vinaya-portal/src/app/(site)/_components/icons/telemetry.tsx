import { DOT, Glyph, LINE, MARK } from './glyph'

// Telemetry's four steps.

export function TelemetrySourceIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <path d='M8 8h14l4 5h22v35H8z' {...LINE} />
      <path d='M28 21v17M22 32l6 6 6-6' {...MARK} />
    </Glyph>
  )
}

export function NormaliserIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <path d='M8 8h40L32 28v16l-8 4V28z' {...LINE} />
      <path d='M18 16h20' {...MARK} />
    </Glyph>
  )
}

export function CacheIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <ellipse cx='28' cy='12' rx='22' ry='6' {...LINE} />
      <path d='M6 12v32c0 3 10 6 22 6s22-3 22-6V12M6 28c0 3 10 6 22 6s22-3 22-6' {...LINE} />
      <circle cx='41' cy='42' r='2.5' {...DOT} />
    </Glyph>
  )
}

export function QuestionsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <circle cx='28' cy='28' r='20' {...LINE} />
      <path d='M22 22a6 6 0 1 1 9 5c-2 1-3 3-3 5' {...MARK} />
      <circle cx='28' cy='39' r='2' {...DOT} />
    </Glyph>
  )
}
