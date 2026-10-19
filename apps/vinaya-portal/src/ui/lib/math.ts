// Small numeric helpers shared by the scroll-driven animations and the scenes.

/** `value` held to 0…1. */
export const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/** The point `t` of the way from `a` to `b`. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Quadratic ease in and out over 0…1. */
export const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** Cubic ease in and out over 0…1. */
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Cubic ease out over 0…1. */
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/** Hermite smoothstep: 0 below `a`, 1 above `b`, eased between. */
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** The point `t` of the way through `range`, `t` held to 0…1. */
export const rangeAt = ([from, to]: readonly [number, number], t: number) => from + (to - from) * clamp01(t)

/** How far `x` is through `a…b`, held to 0…1. */
export const progressBetween = (x: number, a: number, b: number) => clamp01((x - a) / (b - a))
