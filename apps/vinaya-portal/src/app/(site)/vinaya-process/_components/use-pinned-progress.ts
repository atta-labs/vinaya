'use client'

import { type RefObject, useEffect, useRef, useState } from 'react'
import { useEnterProgress, useViewportHeight } from '../../_components/landing/LandingInteractions'

/**
 * 0..1 through a pinned section on this page. The page scrolls inside SiteContentPad, whose top padding (the bar's
 * `h-14`) makes `sticky top-0` stick just under the bar, so a pin is the screen less the bar tall and its progress
 * runs from the moment it sticks (its top at the bar) to the moment it lets go. The bar is measured from the root
 * font, never assumed. Reads 1 under reduced motion.
 */
export function usePinnedProgress(ref: RefObject<HTMLElement | null>) {
  const viewport = useViewportHeight()
  const [frame, setFrame] = useState({ bar: 56, runway: 3000 })
  useEffect(() => {
    const measure = () =>
      setFrame({
        bar: Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) * 3.5,
        runway: ref.current?.offsetHeight ?? 3000
      })
    measure()
    const observer = new ResizeObserver(measure)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref])
  return useEnterProgress(ref, frame.bar / viewport, Math.max(1, frame.runway - viewport + frame.bar) / viewport)
}

/** How long the eased progress takes to close most of the way to the scroll (the time constant, ms). */
const EASE_MS = 140

/**
 * The same progress as `usePinnedProgress`, delivered to `onFrame` on every animation frame it changes instead of
 * through React state: no re-render, no threshold. It eases toward the scroll position, so a wheel tick glides
 * instead of jumping, and stops asking for frames once it has arrived. `onFrame` also runs whenever it changes
 * identity, with the current value, so a caller that re-measures can redraw at once.
 */
export function usePinnedFrames(
  ref: RefObject<HTMLElement | null>,
  onFrame: (progress: number) => void,
  enabled = true
) {
  const latest = useRef(onFrame)
  latest.current = onFrame
  const current = useRef(0)

  useEffect(() => {
    onFrame(current.current)
  }, [onFrame])

  useEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    const target = () => {
      const bar = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.5
      const viewport = window.innerHeight || 800
      const span = Math.max(1, element.offsetHeight - viewport + bar)
      const value = (bar - element.getBoundingClientRect().top) / span
      return value < 0 ? 0 : value > 1 ? 1 : value
    }
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = 0
      const goal = target()
      const dt = Math.min(64, now - last)
      last = now
      const next = current.current + (goal - current.current) * (1 - Math.exp(-dt / EASE_MS))
      current.current = Math.abs(goal - next) < 0.0002 ? goal : next
      latest.current(current.current)
      if (current.current !== goal) raf = requestAnimationFrame(tick)
    }
    const wake = () => {
      if (raf) return
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }
    current.current = target()
    latest.current(current.current)
    document.addEventListener('scroll', wake, { passive: true, capture: true })
    window.addEventListener('resize', wake)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('scroll', wake, { capture: true })
      window.removeEventListener('resize', wake)
    }
  }, [ref, enabled])
}

/**
 * Keeps a pinned block inside its pin: when the block is taller than the pin less `margin` pixels top and bottom,
 * it is scaled down (CSS zoom) until it fits; where it fits it is left alone. Re-measured at full size on every
 * resize of the pin or the block.
 */
export function useFitToPin(block: RefObject<HTMLElement | null>, enabled: boolean, margin = 24) {
  useEffect(() => {
    const box = block.current
    const pin = box?.parentElement
    if (!box || !pin) return
    if (!enabled) {
      box.style.zoom = ''
      return
    }
    const measure = () => {
      box.style.zoom = ''
      const room = pin.clientHeight - margin * 2
      const height = box.offsetHeight
      box.style.zoom = height > room ? String(room / height) : ''
    }
    measure()
    // The pin's size and the block's content both change what fits. A measure ends on the same zoom it started from
    // unless the content changed, so watching the block settles after one pass.
    const observer = new ResizeObserver(measure)
    observer.observe(pin)
    observer.observe(box)
    return () => observer.disconnect()
  }, [block, enabled, margin])
}
