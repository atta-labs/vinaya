// Mask textures for canvas and three.js. A mask carries no colour of its own: every pixel is full
// intensity and only its alpha varies, so the material that uses it supplies the colour.

const FULL = 255

/** A gradient's stops as `[offset, alpha]` pairs, offsets 0…1 ascending. */
export type AlphaStops = readonly (readonly [number, number])[]

/** The alpha at `t` along piecewise-linear stops, clamped to the end stops. */
export function alphaAt(stops: AlphaStops, t: number): number {
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (!first || !last) return 0
  if (t <= first[0]) return first[1]
  if (t >= last[0]) return last[1]
  for (let i = 1; i < stops.length; i++) {
    const [b, bAlpha] = stops[i] as readonly [number, number]
    const [a, aAlpha] = stops[i - 1] as readonly [number, number]
    if (t <= b) return b === a ? bAlpha : aAlpha + ((bAlpha - aAlpha) * (t - a)) / (b - a)
  }
  return last[1]
}

/** A mask whose alpha at each pixel centre is `coverage(x, y)`, 0…1. */
export function coverageMask(width: number, height: number, coverage: (x: number, y: number) => number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const image = ctx.createImageData(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      image.data[i] = FULL
      image.data[i + 1] = FULL
      image.data[i + 2] = FULL
      image.data[i + 3] = Math.round(Math.min(1, Math.max(0, coverage(x + 0.5, y + 0.5))) * FULL)
    }
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/** A mask drawn with `draw`: the shapes keep their antialiased alpha and lose the context's colour. */
export function drawnMask(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return canvas
  draw(ctx)
  const image = ctx.getImageData(0, 0, width, height)
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = FULL
    image.data[i + 1] = FULL
    image.data[i + 2] = FULL
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}
