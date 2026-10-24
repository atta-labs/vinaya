import { Children, cloneElement, isValidElement, type ReactNode } from 'react'
import { cn } from '@/ui/lib/utils'

// The site's drawn icons: the outline in the text's ink (`currentColor`), and the one detail that carries the
// meaning in the theme's accent, `--ring` (the site's orange), so they follow light and dark mode.
// Each one's `viewBox` is its artwork's own box, strokes included, so the drawing touches the icon's edges: a square
// icon fills both sides, a taller or wider one fills its longer side and is centred on the other. The artwork is drawn
// on a 56-unit grid; the stroke widths scale with the box, so every icon has the same line weight at the same size.
// Size them with `className` (`size-14` by default).

/** Stroke widths on the 56-unit grid: an outline, and the heavier accent detail. */
const LINE_WEIGHT = 2
const MARK_WEIGHT = 2.5

export function Glyph({
  className,
  children,
  viewBox = '0 0 56 56'
}: {
  className?: string
  children: ReactNode
  viewBox?: string
}) {
  const [, , w = 56, h = 56] = viewBox.split(' ').map(Number)
  const k = Math.max(w, h) / 56
  return (
    <svg viewBox={viewBox} fill='none' aria-hidden='true' className={cn('size-14 shrink-0', className)}>
      <g strokeWidth={LINE_WEIGHT * k}>
        <GlyphStrokes longerSide={Math.max(w, h)}>{children}</GlyphStrokes>
      </g>
    </svg>
  )
}

/** Apply family weights through moving groups, compensating scaled agent role signs. */
export function GlyphStrokes({ children, longerSide }: { children: ReactNode; longerSide: number }) {
  function weigh(nodes: ReactNode, scale: number): ReactNode {
    return Children.map(nodes, (child) => {
      if (
        !isValidElement<{
          children?: ReactNode
          'data-weight'?: string
          'data-role-sign'?: boolean
          strokeWidth?: number
        }>(child)
      )
        return child
      const roleSign = child.props['data-role-sign']
      const nextScale = roleSign ? scale / 0.80769 : scale
      return cloneElement(child, {
        ...(roleSign ? { strokeWidth: LINE_WEIGHT * nextScale } : {}),
        ...(child.props['data-weight'] === 'mark' ? { strokeWidth: MARK_WEIGHT * nextScale } : {}),
        ...(child.props.children !== undefined ? { children: weigh(child.props.children, nextScale) } : {})
      })
    })
  }
  return <>{weigh(children, longerSide / 56)}</>
}

/** An outline, at the Glyph's line weight. */
export const LINE = {
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** The one detail that carries the meaning: in the accent (`--ring`), a little heavier. */
export const MARK = {
  stroke: 'currentColor',
  className: 'stroke-ring',
  'data-weight': 'mark',
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** A filled detail, in the accent (`--ring`). Spread after LINE, it turns that shape into a solid accent shape. */
export const DOT = { fill: 'currentColor', className: 'fill-ring', stroke: 'none' } as const

/** For an icon in a 20px row (sidebar, list): strokes stay 1.75 screen pixels instead of scaling down to a hairline. */
export const SMALL_ICON = 'size-5 [&_*]:![stroke-width:1.75px] [&_*]:[vector-effect:non-scaling-stroke]'
