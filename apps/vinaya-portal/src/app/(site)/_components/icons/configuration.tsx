import { DOT, Glyph, LINE } from './glyph'

// Configuration's parts. The file itself uses ConfigurationIcon.

export function TrustIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='8.259 16.259 41.481 23.481'>
      <circle cx='20' cy='28' r='11' {...LINE} />
      <path d='M31 28h18M43 28v7M49 28v5' {...LINE} />
      <circle cx='20' cy='28' r='4' {...DOT} />
    </Glyph>
  )
}

export function SetupCommandsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className} viewBox='7.259 7.259 41.481 41.481'>
      <path d='M8 48V20l20-12 20 12v28' {...LINE} />
      <path d='M20 48V32h16v16' {...LINE} />
      <path d='M24 40h8' {...LINE} />
    </Glyph>
  )
}
