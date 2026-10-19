// Theme colours for canvas and three.js, which take a number, not a CSS colour. The value always comes
// from the CMS theme's custom property; there is no literal fallback, so an unset token is an error.

let probe: CanvasRenderingContext2D | null = null
let unset: CanvasGradient | null = null
let solver: HTMLSpanElement | null = null

/** Parses any CSS colour the engine knows (oklch included) to a 0xRRGGBB number. */
export function colorHex(css: string): number {
  if (!probe) {
    probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!probe) throw new Error('colorHex: no 2D canvas')
    unset = probe.createLinearGradient(0, 0, 0, 0)
  }
  // A notation the canvas rejects (oklch on older engines) leaves fillStyle as it was: the gradient.
  probe.fillStyle = unset as CanvasGradient
  probe.fillStyle = css
  if (typeof probe.fillStyle === 'string') {
    probe.clearRect(0, 0, 1, 1)
    probe.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data
    return (r << 16) | (g << 8) | b
  }
  // The fallback parser is a hidden element: its computed colour comes back as rgb().
  if (!solver) {
    solver = document.createElement('span')
    solver.style.display = 'none'
    document.documentElement.appendChild(solver)
  }
  solver.style.color = ''
  solver.style.color = css
  const [r = 0, g = 0, b = 0] = (getComputedStyle(solver).color.match(/[\d.]+/g) ?? []).map(Number)
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)
}

/** A theme token (`--primary`) as a 0xRRGGBB number. */
export function tokenHex(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) throw new Error(`theme token ${name} is not defined`)
  return colorHex(raw)
}
