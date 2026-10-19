/* The hero's fabric, stood up as a wall: the same sheet of ink hairlines (field-3d.js), turned upright and seen
   obliquely, so it reads as a vertical membrane across the track — the boundary of Vinaya's domain. The energy line
   pierces it at its centre, and `shock()` sends the hero's own shock wave out through it from that point.
   Every colour comes from the theme (the hero's fabric variables, read off `host`, which carries
   `data-hero-viewport`); the canvas is transparent, so the page's own background shows through. */
import * as THREE from 'three'
import { buildField } from '../../_components/hero-canvas/field-3d'
import { heroColor, heroFabricAlpha, readToken } from '../../_components/hero-canvas/harness-model'

const RADIUS = 9
// The upright walls run twice as deep, so they reach further into the background before they dissolve.
const DEEP = 18
// How far the wall is turned at the screen's edge (radians, ~66°: well into perspective; edge-on is 90°), and the lens
// it is seen through: a narrow field of view from further back, for little foreshortening.
const TURN = 1.15
const DISTANCE = 36
const FOV = 24

export function mountFabricWall(canvas, host, { reduced = false, flat = false, mirror = false } = {}) {
  const palette = () => {
    const card = readToken('--card')
    if (card == null) return null
    try {
      return { ink: heroColor(host, 'fabricInk'), alpha: heroFabricAlpha(), card }
    } catch {
      return null
    }
  }
  const colors = palette()
  if (!colors) return { shock() {}, dispose() {} }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200)
  camera.position.set(0, 0, DISTANCE)
  camera.lookAt(0, 0, 0)

  const field = buildField(THREE, {
    ink: colors.ink,
    radius: flat ? RADIUS : DEEP,
    divisions: flat ? 56 : 112, // the same spacing between lines at either size
    dishDepth: 0,
    dishR: 2,
    coreR: 0,
    opacity: colors.alpha * 2.4,
    surface: colors.card,
    flashHex: colors.card,
    activeRadius: RADIUS,
    crestAmount: 0.45
  })
  // A wall, not a floor: no opaque skin behind the hairlines, and no hole at the centre. The sheet fades out toward its
  // rim on every side, so no edge of it ever reads as a line: not the far one (the depth fade does that) and not the
  // near one, which faces the reader on a wall turned this far.
  field.surface.visible = false
  const alphaAttr = field.mesh.geometry.attributes.aAlpha
  const flatPositions = field.mesh.geometry.attributes.position.array
  for (let i = 0; i < alphaAttr.count; i++) {
    const d = Math.hypot(flatPositions[i * 3], flatPositions[i * 3 + 2])
    const size = flat ? RADIUS : DEEP
    const t = Math.max(0, Math.min(1, (size - d) / (size * 0.55)))
    alphaAttr.array[i] = t * t * (3 - 2 * t)
  }
  alphaAttr.needsUpdate = true
  field.mesh.rotation.x = Math.PI / 2
  const wall = new THREE.Group()
  wall.add(field.mesh)
  // Upright across a horizontal track; lying down, like the hero's floor, across a vertical one (`flat`, on phones).
  // The wall on the way out (`mirror`) is the way-in wall's exact mirror image: drawn the same, as if it stood on the
  // mirrored side of the screen, and flipped left to right by its canvas (EnergyCrossing). So the two walls lean toward
  // each other like the walls of a corridor, and match line for line.
  // The wall turns with the camera. The reader is the camera, looking straight ahead from the middle of the screen: a
  // wall level with the middle is seen exactly edge-on, a straight line, and the further it slides to a side the more it
  // opens into perspective, up to TURN at the screen's edge. `look()` reads where the wall's crossing sits on screen
  // (the middle of its canvas: across for an upright wall, down for a flat one) and sets the angle from it.
  // Upright, only the half of the wall past the crossing is drawn (the page clips the rest), so the sheet's own centre,
  // where its shock wave starts, is slid along that half to its middle: the wave rises from the middle of the wall you
  // see, not from its edge. The sheet still reaches back across the crossing, so the wall starts there.
  // The way-out wall is turned the other way, so its visible half lies on the other side of its own centre.
  if (!flat) field.mesh.position.x = DEEP * (mirror ? -0.3 : 0.45)
  const look = () => {
    const box = canvas.getBoundingClientRect()
    const span = flat ? window.innerHeight : window.innerWidth
    const at = flat ? box.top + box.height / 2 : box.left + box.width / 2
    const offset = Math.max(-1, Math.min(1, (at - span / 2) / (span / 2)))
    // a flat wall (phones) still turns the other way on the way out; an upright one is drawn as the way-in wall
    const turn = flat
      ? ((mirror ? -1 : 1) * Math.PI) / 2 + (Math.PI / 2 - TURN) * offset
      : Math.PI / 2 + (Math.PI / 2 - TURN) * offset * (mirror ? -1 : 1)
    if (flat) wall.rotation.x = turn
    else wall.rotation.y = turn
  }
  look()
  scene.add(wall)
  // Lying flat, the sheet tips away from the reader through its centre, where the energy pierces it: the fade starts
  // past that point so the crossing reads as clearly as it does on an upright wall.
  if (flat) field.setFade(DISTANCE * 1.05, DISTANCE * 1.8)
  else field.setFade(DISTANCE * 0.75, DISTANCE * 1.75)

  const resize = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const sizes = new ResizeObserver(resize)
  sizes.observe(canvas)

  // Draw only while on screen; a still frame otherwise.
  let visible = false
  let raf = 0
  let last = performance.now()
  let time = 0
  const frame = (now) => {
    raf = 0
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (!reduced) time += dt
    field.update(reduced ? 0 : dt, { mass: 0, time, lift: 1 })
    look()
    renderer.render(scene, camera)
    if (visible && !reduced) raf = requestAnimationFrame(frame)
  }
  const seen = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible && !raf) {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
  })
  seen.observe(canvas)

  // Theme switch: repaint the ink in place.
  const themes = new MutationObserver(() => {
    const next = palette()
    if (!next) return
    field.retheme({ ink: next.ink, surface: next.card, opacity: next.alpha * 2.4 })
    if (!raf) raf = requestAnimationFrame(frame)
  })
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })

  return {
    shock() {
      if (reduced) return
      // a quiet ripple, not the hero's full latch wave: low, short-lived, so the wall moves only a little
      field.pulse({ amp: 0.45, decay: 2 })
      if (!raf) raf = requestAnimationFrame(frame)
    },
    dispose() {
      cancelAnimationFrame(raf)
      sizes.disconnect()
      seen.disconnect()
      themes.disconnect()
      field.mesh.geometry.dispose()
      field.material.dispose()
      renderer.dispose()
    }
  }
}
