import { clamp01 } from '@/ui/lib/math'

/** 0 when the section's top hits the viewport top, 1 when its bottom hits the viewport bottom. */
export const pinProgress = (top: number, height: number, viewport: number) =>
  clamp01(-top / Math.max(1, height - viewport))

/** Starts when the top crosses `start` of the viewport height; completes after `span` viewport heights. */
export const enterProgress = (top: number, viewport: number, start: number, span: number) =>
  clamp01((viewport * start - top) / (viewport * span))
