import type { ComponentProps, ComponentType } from 'react'
import { cn } from '../../lib/utils'

export type ScrollableTableProps = ComponentProps<'table'> & {
  /**
   * Extends/overrides the wrapper div (merged LAST, so a consumer's class wins).
   * Common use: shift the pinned header down past a fixed bar above the table
   * with `'[&_thead_th]:top-10'` (defaults to `top-0`).
   */
  containerClassName?: string
  /**
   * Pin the header row while you scroll PAST the table — it sticks at the top of
   * the nearest scrolling ancestor and leaves when the table scrolls out. No
   * fixed height. **OFF by default — opt in per call site.**
   *
   * Default-off is deliberate: this is a shared `@atta/ui` primitive used by every
   * product (Vāda, Herald, Atta, Vinaya), and pinning is only correct where the
   * table sits inside a scrolling ancestor to pin against. A consumer that has
   * browser-verified the behavior opts in explicitly (`<Table stickyHeader>`);
   * everyone else gets the responsive horizontal-scroll wrapper with no behavior
   * change. Vinaya's tables pass `stickyHeader` at every call site.
   *
   * How it works when on: the wrapper does NOT trap the sticky in a
   * horizontal-scroll box (that would pin the header to the box, not the page). It
   * leaves the installed container `overflow-visible` (gated on `@min-[780px]/tbl:`
   * so it only engages once the container is wide enough to fit the table), so the
   * header sticks to whatever ancestor actually scrolls — a page shell (e.g.
   * Studio's `overflow-y-auto` region) or the page itself. The per-library
   * sticky-header rule (matching each library's own row-border width and color) is
   * applied so the pinned header keeps a matching separator after sticky detaches
   * it from the row.
   */
  stickyHeader?: boolean
  /**
   * - `default`: the library's table
   * - `docs`: reference prose — headers in full ink and semibold, cells top-aligned in full ink
   * - `data`: a dense mono grid — small uppercase headers, tight rows
   */
  variant?: 'default' | 'docs' | 'data'
}

const tableVariants = {
  default: '',
  docs: '[&_td]:align-top [&_td]:text-foreground [&_th]:font-semibold [&_th]:text-foreground',
  data: 'font-mono text-xs [&_td]:py-1.5 [&_th]:h-8 [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wider'
} as const

/**
 * Wraps a library's installed `Table` so the table is responsive (never bleeds
 * past its parent) and its header pins on scroll — both correct in every library.
 *
 * `min-w-0 max-w-full` caps the wrapper at its parent and lets it shrink below
 * the table's intrinsic width, the constraint the installed container needs so a
 * `min-w` table clips/scrolls instead of overflowing the page.
 *
 * `stickyHeader` (opt-in) is why this is a factory: sticky `<th>` cells detach from
 * the row border (a `border-collapse` quirk), so the pinned header must carry its
 * own bottom rule as a box-shadow — and that rule must match each library's REAL
 * row border, which differs by both width AND color: retro rows are
 * `border-b-2`, basic/animate `border-b`; retro/animate rows resolve to
 * `--border` (no color class — the base `border-border` rule applies), basic uses
 * `border-border/60`. So each library passes its own literal, Tailwind-scannable
 * sticky-header class as the second arg (retro/animate → `--border`, basic →
 * `--border`/60), and `stickyHeader` renders per-library-correct in all three
 * with zero sticky/border classes at the call site.
 */
export function makeScrollableTable(InstalledTable: ComponentType<ComponentProps<'table'>>, stickyHeaderClass: string) {
  function Table({
    className,
    containerClassName,
    stickyHeader = false,
    variant = 'default',
    ...props
  }: ScrollableTableProps) {
    // Sticky mode switches on the table's own CONTAINER width, not the viewport
    // (`@container/tbl` + `@min-[780px]/tbl:` on the inner). Only when the
    // container is wide enough to actually FIT the table (≥ 780px, past the
    // 720–760 min-widths) does the header pin: the installed container is left
    // non-scrolling so the header sticks to the page/shell and the shell absorbs
    // any overflow. Below that width — including the awkward intermediate range
    // where a viewport breakpoint would have said "wide" while the table still
    // didn't fit — the installed container keeps its OWN horizontal scroll, so the
    // table scrolls inside its own box (contained, never overflowing the card) and
    // the header is not pinned. `stickyHeaderClass` is authored with the same
    // `@min-[780px]/tbl:` prefix.
    return (
      <div className='@container/tbl w-full min-w-0 max-w-full'>
        <div
          className={cn(
            // Every table is framed: a rounded border, clipped with `overflow-clip`, which
            // (unlike `overflow-hidden`) is not a scroll container, so the sticky header
            // still pins to the page. The last row's own border is dropped by the table.
            'overflow-clip rounded-lg border border-border',
            stickyHeader && '@min-[780px]/tbl:[&>div]:overflow-visible',
            stickyHeader && stickyHeaderClass,
            containerClassName
          )}
        >
          <InstalledTable className={cn(tableVariants[variant], className)} {...props} />
        </div>
      </div>
    )
  }
  Table.displayName = 'Table'
  return Table
}
