import { Glyph } from './glyph'

// The roadmap track's marks.

/** The junction on every milestone card: a hexagonal connector, card-filled so the track's line stops at its edge. */
export function JunctionIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='0 0 40 40'>
      <polygon
        points='20,2 35.59,11 35.59,29 20,38 4.41,29 4.41,11'
        fill='var(--background)'
        stroke='var(--foreground)'
        strokeWidth='2.2'
        strokeLinejoin='round'
      />
      <path d='M12.6 20 H27.4' stroke='var(--foreground)' strokeWidth='3' strokeLinecap='round' opacity='0.5' />
    </Glyph>
  )
}
