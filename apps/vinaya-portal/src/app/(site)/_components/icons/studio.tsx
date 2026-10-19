import { Glyph, LINE, MARK } from './glyph'

// Studio's screens.

export function MissionControlIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <circle cx='28' cy='28' r='20' {...LINE} />
      <path d='M28 16v12l8 5' {...MARK} />
    </Glyph>
  )
}

export function DashboardIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='5.185 5.185 45.63 45.63'>
      <rect x='6' y='6' width='44' height='44' rx='4' {...LINE} />
      <path d='M6 18h44M20 18v32' {...LINE} />
      <path d='M28 41l5-7 5 4 6-9' {...MARK} />
    </Glyph>
  )
}

export function ManyRepositoriesIcon({ className }: { className?: string }) {
  // three repositories stacked: the two behind show only the edges the front one leaves uncovered
  return (
    <Glyph className={className} viewBox='6.023 6.219 43.758 41.758'>
      <path d='M19 14v-4a3 3 0 0 1 3-3h24a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3h-3' {...LINE} />
      <path d='M13 21v-4a3 3 0 0 1 3-3h24a3 3 0 0 1 3 3v22a3 3 0 0 1-3 3h-3' {...LINE} />
      <rect x='7' y='21' width='30' height='26' rx='3' {...MARK} />
    </Glyph>
  )
}
