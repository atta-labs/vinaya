import * as THREE from 'three'
import { clamp01, easeInOutCubic, easeOutCubic, lerp, smoothstep } from '@/ui/lib/math'
import { buildFloaters } from '../canvas/floaters'
import { buildField } from './field-3d'
import { buildHarness, heroColor, heroFabricAlpha, readToken } from './harness-model'
import { buildInfinityFlow } from './infinity-flow'
import { buildBeam } from './underworld-beam'

/**
 * Mount factory for the hero scene. The three canvas builders live alongside this file —
 * this file is the orchestration layer, a `.js` factory behind a dynamic `import()` so
 * `three` stays out of the SSR module graph (the `/life-cycle` precedent,
 * `.claude/skills/vinaya-architecture/SKILL.md`).
 *
 * DO NOT retune the timeline below: its relative rhythm is the design. Main's arrival opens
 * it — an `open` ramp at the head, every later beat 0.75 s behind it. With the outer ring
 * switched off (RING) its two beats are skipped and everything after them moves up, so the
 * columns close 0.75 s after the bolts rise, the same step as every other beat.
 * Every `document`/`window`/`getComputedStyle` read lives inside `mountHeroScene`.
 */

/* The outer ring — its four bands deploying out of the bolts, and the electric arcs that strike
   across its gaps. Off, the harness is bolts, columns and main: the ring's parts are still built
   (harness-model.js `ring`), never shown, and the timeline skips their beats. */
const RING = false

/* ── the timeline. Build beats are seconds; everything else is scroll progress 0–1 ── */
const RING_BEATS = ['deploy', 'spark']
const RING_SPAN = 3.85 - 2.05 // from the ring's first beat to `clamp`, the beat after its last
const afterRing = (s) => (RING || s < 2.05 ? s : s - RING_SPAN)
const BUILD = [
  ['open', 0.25, 0.9], // main's aperture — the sheet is empty until it opens
  ['screw', 1.3, 0.5],
  ['deploy', 2.05, 0.7],
  ['spark', 3.05, 0.45],
  ['clamp', 3.85, 0.8],
  ['mainPulse', 4.6, 0.62],
  ['merge', 4.73, 0.55]
]
  .filter(([key]) => RING || !RING_BEATS.includes(key))
  .map(([key, start, dur]) => [key, afterRing(start), dur])
const WAVE_T = afterRing(4.73) // fires with `merge`
const FLOW_T = WAVE_T + 0.35 // the infinity leaves main just behind the shock wave's front
const ARRIVAL_T = 0.2 // the small ripple that precedes main's opening
const FLASH_T = afterRing(5.35) // the build flash trails the latch
/* the scene clock (and the field's step) runs INTRO_SPEED times the rate the beats above are written at
   until INTRO_END, the end of the build flash, then at real time, with no jump. Without the ring the
   intro plays at the speed it is written at; with it, 1.5 times faster, as it always has */
const INTRO_SPEED = RING ? 1.5 : 1
const INTRO_END = FLASH_T + 2.2
const TIP_FROM = 0.02
const TIP_TO = 0.72
const H1_FROM = 0.28
const H1_SPAN = 0.18 // line 1 completes…
const H1B_FROM = 0.47 // …before line 2 starts
const SUB_FROM = 0.68
const SUB_SPAN = 0.16
/* The end of the scene. Over the last stretch of the scroll the harness rises (a view offset, END_LIFT of the
   viewport height) as it finishes turning, so the buttons have room under it; the buttons fade in only once that
   rise is done, at the scene's final state. Never at the start, never mid-way. */
const LIFT_FROM = 0.55 // overlaps the end of the tip (TIP_TO), so the turn and the rise read as one move
const LIFT_TO = 0.9
const END_LIFT = 0.12
const ACTIONS_FROM = 0.92
const ACTIONS_SPAN = 0.05
const DISH = 0.62
const RELEASE_MS = 500 // the ease from the gated start into the live scroll position, once the intro ends

/* split into per-character <i> so each letter can be driven independently. Class strings
   come from `labelClass` (authored in the .tsx, per the WebGL-surface rule: Tailwind's
   @source globs are .ts/.tsx only, so a class string literal in this .js file compiles to
   nothing). */
function splitLetters(el, labelClass) {
  const words = (el.dataset.text ?? el.textContent ?? '').trim().split(' ')
  const letter = (c) => `<i class="${labelClass.letter}">${c === '&' ? '&amp;' : c}</i>`
  el.innerHTML = words
    .map((w) => {
      /* "loop": its two o's are the hero's infinity, drawn small and flowing (LOOP_GLYPH) */
      const m = /^loop([^a-z]*)$/i.exec(w)
      const inner = m
        ? `${letter(w[0])}<i class="${labelClass.letter}">${LOOP_GLYPH}</i>${[...`p${m[1]}`].map(letter).join('')}`
        : [...w].map(letter).join('')
      return `<span class="${labelClass.word}">${inner}</span>`
    })
    .join(' ')
  return [...el.querySelectorAll('i')]
}

/* The infinity as a glyph: the same lemniscate as infinity-flow.js (lobes squashed alike),
   three hairlines in the text's own colour, and the same packets, amber → red → green,
   running one loop every 1 / 0.07 s — the 3D current's speed. Styled in hero-core.css. */
const LOOP_GLYPH = (() => {
  const pts = []
  for (let i = 0; i <= 96; i++) {
    const t = Math.PI / 2 - (2 * Math.PI * i) / 96
    const d = 1 + Math.sin(t) ** 2
    pts.push(
      `${(50 + (46 * Math.cos(t)) / d).toFixed(2)},${(20 - ((46 * Math.sin(t) * Math.cos(t)) / d) * 1.12).toFixed(2)}`
    )
  }
  const path = `M${pts.join('L')}Z`
  const strand = (dy) => `<path class="hero-loop-base" d="${path}" transform="translate(0 ${dy})" pathLength="100"/>`
  const packet = (len, cls) =>
    `<path class="hero-loop-packet ${cls}" d="${path}" pathLength="100" stroke-dasharray="${len} ${100 / 3 - len}"/>`
  return (
    '<svg class="hero-loop" viewBox="0 0 100 40" role="img" aria-label="oo" focusable="false">' +
    '<defs><linearGradient id="hero-loop-ink" x1="0" x2="1" y1="0" y2="0">' +
    '<stop offset="0" style="stop-color:var(--warning)"/><stop offset="0.5" style="stop-color:var(--destructive)"/>' +
    '<stop offset="1" style="stop-color:var(--success)"/></linearGradient></defs>' +
    strand(-1.4) +
    strand(0) +
    strand(1.4) +
    packet(20, 'hero-loop-tail') +
    packet(11, 'hero-loop-mid') +
    packet(5, 'hero-loop-head') +
    '</svg>'
  )
})()

/* Every design token the scene and its builders read, as one all-or-nothing snapshot, or
   null while any of them can't be read. The root tokens are the ones harness-model.js's
   retheme() re-reads (TOKENS there), plus --background and --foreground (the fabric ink's
   source); the hero's derived ramp and fabric colours come from heroColor, resolved off the
   hero element. */
const ROOT_TOKENS = [
  '--background',
  '--foreground',
  '--primary',
  '--secondary',
  '--card',
  '--success',
  '--warning',
  '--destructive'
]
function readPalette(hero) {
  const hex = {}
  for (const name of ROOT_TOKENS) {
    const v = readToken(name)
    if (v == null) return null
    hex[name] = v
  }
  try {
    heroColor(hero, 'coreShade')
    heroColor(hero, 'coreDeep')
    return {
      bg: hex['--background'],
      ink: hex['--primary'],
      sand: hex['--secondary'],
      card: hex['--card'],
      flow: { warning: hex['--warning'], destructive: hex['--destructive'], success: hex['--success'] },
      fabricInk: heroColor(hero, 'fabricInk'),
      fabricAlpha: heroFabricAlpha()
    }
  } catch {
    return null
  }
}

/* The hero never throws on a theme it can't read yet. Inside the admin preview frame
   (/?preview=true) the theme arrives by postMessage and is painted onto <html>'s inline
   style after this mounts (@atta/ui's PreviewThemeListener), so the scene waits for a
   readable palette, re-checking whenever <html>'s style/class/data-theme or <head>'s
   stylesheets change, and only then starts. There is no literal-colour fallback: until
   the tokens read, the canvas stays unpainted over the section's own background. */
export function mountHeroScene(opts) {
  const hero = (opts.root ?? document).querySelector('[data-hero-viewport]')
  let scene = null
  let waiter = null
  const tryStart = () => {
    if (scene) return true
    const palette = readPalette(hero)
    if (!palette) return false
    waiter?.disconnect()
    waiter = null
    scene = startHeroScene(opts, palette)
    return true
  }
  if (!tryStart()) {
    waiter = new MutationObserver(tryStart)
    waiter.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    waiter.observe(document.head, { childList: true, subtree: true, characterData: true })
  }
  return {
    applyTheme() {
      scene?.applyTheme()
    },
    dispose() {
      waiter?.disconnect()
      waiter = null
      scene?.dispose()
      scene = null
    }
  }
}

/* The drifting squares share the fabric's ink and its per-scheme strength (heroFabricAlpha), a touch
   stronger because they are filled where the fabric is a hairline: so they sit in the same quiet
   register as the fabric in light and in dark. */
const FLOATER_ALPHA = 1

/* One candidate position for a drifting square, in world space so they parallax as the camera
   tips from top-down to the horizon. Two populations share the sky: one hangs over the fabric
   around the harness (what the top-down opening frame sees, and what swings past as the camera
   tips), the other spreads from just in front of the tipped camera out to the far horizon and up
   the frame. A few land in the central column, never many. */
function heroFloaterPlace(rnd) {
  const spread = (half) => {
    const u = rnd() * 2 - 1
    return (Math.abs(u) < 0.3 && rnd() < 0.8 ? Math.sign(u || 1) * (0.3 + rnd() * 0.7) : u) * half
  }
  if (rnd() < 0.45) return [spread(9), 0.2 + rnd() * 7, (rnd() * 2 - 1) * 6]
  const z = 8 - 38 * rnd() ** 1.4
  const distance = Math.max(2.5, 10 - z)
  return [spread(distance * 0.55), -0.3 + rnd() * 5, z]
}

function startHeroScene({ canvas, root, labelClass, frameShiftRem = 0, onReady = () => {} }, palette) {
  const scope = root ?? document
  const track = scope.querySelector('[data-hero-track]')
  const hero = scope.querySelector('[data-hero-viewport]')
  const h1a = scope.querySelector('[data-hero-h1a]')
  const h1b = scope.querySelector('[data-hero-h1b]')
  const subEl = scope.querySelector('[data-hero-sub]')
  const descendEl = scope.querySelector('[data-hero-descend]')
  const actionsEl = scope.querySelector('[data-hero-actions]')

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  const L_H1A = splitLetters(h1a, labelClass)
  const L_H1B = splitLetters(h1b, labelClass)
  const L_SUB = splitLetters(subEl, labelClass)
  for (const l of [...L_H1A, ...L_H1B, ...L_SUB]) l.style.transition = 'none'

  /* every colour comes from the theme, read once by mountHeroScene's readPalette(). The
     fabric's ink and strength come from heroColor and heroFabricAlpha, per scheme */
  let { bg, ink, sand, card, flow, fabricInk, fabricAlpha } = palette

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
  renderer.localClippingEnabled = true
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(bg)
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 400)

  let disposed = false
  let raf = 0
  let cleanupBuild = () => {}
  let readyFired = false

  /* `frameShiftRem` moves the rendered image down inside the canvas without moving the
     canvas: a view offset that extends the frustum upward by that much, so the same
     framing lands lower and the rows above it are rendered fabric, not a gap. The canvas
     itself always covers the hero box edge to edge, from y = 0 — a CSS translate on it
     instead left an unpainted strip under the transparent top bar. The raycaster reads
     the same projection, so the pointer's hit on the fabric stays under the cursor. */
  let shiftPx = 0
  const resize = () => {
    const w = hero.clientWidth
    const h = hero.clientHeight
    renderer.setSize(w, h, false)
    live?.infinity.setResolution(w, h, renderer.getPixelRatio())
    camera.aspect = w / h
    const shift = frameShiftRem * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    shiftPx = shift
    if (shift > 0 && h > 0) camera.setViewOffset(w, h, 0, -shift, w, h)
    else camera.clearViewOffset()
    camera.updateProjectionMatrix()
  }
  /* THE ACTUAL FLICKER FIX. A live window drag fires the ResizeObserver far faster than
     once per rendered frame — every size the browser lays out during the drag, not once
     per vsync. `renderer.setSize()` reallocates the WebGL drawing buffer (and, at this
     canvas's antialias+devicePixelRatio, its multisample renderbuffers), which is not
     free; calling it synchronously from the observer callback let a burst of resize
     notifications run several of these reallocations back to back with no `render()` call
     landing in between. A freshly resized canvas is spec-cleared to transparent until the
     next draw, so a burst like that held the canvas on that cleared frame for the whole
     burst — visibly the harness and fabric vanishing, then snapping back once the drag
     paused and a render finally landed. Deferring the actual resize into a flag consumed
     once at the top of `frame()` guarantees at most one `setSize()` per rendered frame,
     and that it is always immediately followed by a `render()` in the same tick — no
     cleared-but-unpainted frame can ever reach the screen. (A damped scroll-progress value
     was tried first, in an earlier commit on this same still-unmerged PR; it does not touch
     this — the canvas went blank at scroll position zero, where the camera never moves.) */
  let resizePending = false
  const resizeObserver = new ResizeObserver(() => {
    resizePending = true
  })
  resizeObserver.observe(hero)

  const target = new THREE.Vector3()
  const place = (elevDeg, dist, targetY, azDeg) => {
    const e = (elevDeg * Math.PI) / 180
    const a = (azDeg * Math.PI) / 180
    target.set(0, targetY, 0)
    camera.position.set(
      Math.cos(e) * Math.sin(a) * dist,
      targetY + Math.sin(e) * dist,
      Math.cos(e) * Math.cos(a) * dist
    )
    camera.lookAt(target)
  }

  /* the wordmark itself is the topbar's lockup (see hero-lockup-context.tsx) — VinayaHeroEmblem
     drives it separately via lockup-flip.js. This scene owns only the title/sub/cta/descend
     copy. */
  function setCopy(p, buildDone) {
    const cue = buildDone ? 1 - smoothstep(0.005, 0.06, p) : 0
    descendEl.style.opacity = cue.toFixed(3)
    revealLetters(L_H1A, p, H1_FROM, H1_SPAN)
    revealLetters(L_H1B, p, H1B_FROM, H1_SPAN)
    revealLetters(L_SUB, p, SUB_FROM, SUB_SPAN)
    if (actionsEl) {
      const a = smoothstep(ACTIONS_FROM, ACTIONS_FROM + ACTIONS_SPAN, p)
      actionsEl.style.opacity = a.toFixed(3)
      actionsEl.style.transform = `translateY(${((1 - a) * 8).toFixed(2)}px)`
      actionsEl.style.pointerEvents = a > 0.5 ? 'auto' : 'none'
      actionsEl.inert = a <= 0.5
    }
  }
  /* letters are driven per frame, which is what lets them scrub smoothly */
  function revealLetters(letters, p, from, span) {
    const per = span / Math.max(1, letters.length)
    letters.forEach((l, i) => {
      const t = clamp01((p - (from + i * per * 0.65)) / Math.max(0.001, per * 2.2))
      l.style.opacity = t.toFixed(3)
      l.style.transform = `translateY(${((1 - t) * 4).toFixed(2)}px)`
    })
  }

  function progress() {
    const r = track.getBoundingClientRect()
    const travel = r.height - hero.clientHeight
    return travel <= 20 ? 0 : clamp01(-r.top / travel)
  }

  const scrollHost = hero.closest('.overflow-y-auto')

  /* the live trio once built — what applyTheme() repaints. null while nothing is mounted. */
  let live = null

  function build() {
    /* `locked` holds the page at the top while the intro (the build) plays, so no scroll can pile up behind the intro
       and jump the scene when it ends. Scroll input is refused rather than the overflow hidden: hiding it would drop
       the scrollbar, and its return at release narrows the canvas and nudges the harness. Released when the build is
       done (or torn down, or fails). Progress still eases in over RELEASE_MS after release as a guard. */
    let locked = !reduced
    let releasedAt = -1
    const holdKeys = new Set([' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'])
    const refuse = (e) => {
      if (
        e.type === 'keydown' &&
        (!holdKeys.has(e.key) || e.target.closest?.('input, textarea, select, [contenteditable]'))
      )
        return
      e.preventDefault()
    }
    const pin = () => {
      if (scrollHost && scrollHost.scrollTop !== 0) scrollHost.scrollTop = 0
    }
    const release = () => {
      if (!scrollHost) return
      scrollHost.removeEventListener('wheel', refuse)
      scrollHost.removeEventListener('touchmove', refuse)
      window.removeEventListener('keydown', refuse)
      scrollHost.removeEventListener('scroll', pin)
    }
    if (locked && scrollHost) {
      scrollHost.scrollTop = 0
      scrollHost.addEventListener('wheel', refuse, { passive: false })
      scrollHost.addEventListener('touchmove', refuse, { passive: false })
      window.addEventListener('keydown', refuse)
      scrollHost.addEventListener('scroll', pin)
    }

    let cancelled = false
    // main-core options — the 1c fix for the core reading as an egg in light mode: wire net
    // at 0.07 alpha, per-fragment cel terminator, collar contact, centre lifted 0.13R → 0.22R.
    // See harness-model.js's main block for what each does. Defaults there are inert.
    const harnessOpts = { tokenRoot: hero, ring: RING, core: { wire: 0.07, ramp: 'deep', contact: true, lift: 0.22 } }
    const building = buildHarness(THREE, harnessOpts).then((harness) => {
      if (cancelled || disposed) return
      const field = buildField(THREE, {
        ink: fabricInk,
        radius: 34,
        divisions: 272,
        dishDepth: DISH,
        dishR: 2.15,
        coreR: 0,
        opacity: fabricAlpha,
        surface: bg,
        flashHex: card,
        activeRadius: 13
      })
      /* Seat the RING, not the core. The harness must always sit above the fabric, including
         the shock wave's crest. Seating so the core's bottom kisses the dish floor ties the
         ring's height to the core's lift — and raising that lift (the cel-shaded core sits
         0.22R above the collar, up from 0.13R) pushed the ring down into the dish until the
         wave passed over its arms. The seat is pinned to the lift the dish was tuned against;
         the core's lift above the collar is a core-vs-collar decision and never moves the ring. */
      const SEAT_LIFT = 0.13
      const seatY = -DISH - (harness.dims.coreRadius * SEAT_LIFT - harness.dims.coreRadius)
      harness.group.position.y = seatY
      scene.add(harness.group, field.mesh)
      const beam = buildBeam(THREE, { ink, sand, card, topY: seatY + harness.dims.coreLift, depth: 34, rimRadius: 9 })
      scene.add(beam.group)
      const infinity = buildInfinityFlow(THREE, {
        dims: harness.dims,
        seatY,
        dishDepth: DISH,
        dishR: 2.15,
        colors: flow,
        fabric: field // the strands lie on the sheet and ride its waves
      })
      scene.add(infinity.group)
      /* the drifting squares: floating above the fabric all round the harness, from the first frame */
      const floaters = buildFloaters(THREE, {
        count: 208,
        color: fabricInk,
        opacity: fabricAlpha * FLOATER_ALPHA,
        size: 0.2,
        maxSize: 9,
        place: heroFloaterPlace,
        // the fabric bows up around the dish and would hide every square behind it once the camera tips
        depthTest: false,
        center: [0, 0, 0],
        extent: [0, 0, 0],
        seed: 20261006
      })
      floaters.points.renderOrder = 10 // after the fabric sheet, which would otherwise paint over them
      scene.add(floaters.points)
      live = { harness, field, beam, floaters, infinity }
      applyTheme() // a theme flip during the async build lands on the tokens read now, not at kickoff
      resize()
      place(88, 13.5, seatY, 0)

      const rayc = new THREE.Raycaster()
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
      const hit = new THREE.Vector3()
      const ndc = new THREE.Vector2()
      let pointerIn = false
      let mx = 0
      let my = 0
      let px = 0
      let py = 0
      const onMove = (e) => {
        const r = hero.getBoundingClientRect()
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
        mx = (e.clientX - r.left) / r.width - 0.5
        my = (e.clientY - r.top) / r.height - 0.5
        pointerIn = true
      }
      const onLeave = () => {
        pointerIn = false
        field.setCursor(null)
      }
      hero.addEventListener('pointermove', onMove)
      hero.addEventListener('pointerleave', onLeave)

      const t0 = performance.now()
      let last = t0
      let firedWave = false
      let firedArrival = false
      /* progress() reads the track's live rect: `travel = trackHeight - hero.clientHeight`,
         both of which move with the viewport's height (the track is `320vh`, the hero
         `h-dvh`). Resizing the window changes `travel` on every layout pass while the
         actual scrolled distance in pixels does not rescale with it, so at any nonzero
         scroll offset `progress()` returns a different number the instant the window's
         height changes, snapping the camera a step every such layout pass. `pSmooth`
         chases the raw signal instead of tracking it exactly, so that step becomes a few
         frames of motion instead of a jump — real, but only when scrolled partway into the
         hero; at scroll position zero (`progress()` pinned at `0` either side of the
         resize) this has nothing to smooth. It is NOT the flicker reported live: that
         reproduced at scroll zero too. See `resizePending` below, which is. Bypassed
         (snapped straight to the target) during the scroll-locked build and under
         reduced-motion, where the value must already be exact. */
      let pSmooth = 0
      /* main's arrival: the sphere and its contour open from nothing; the label (and with it
         the wire net and travellers, which ride the spinner) only once the surface is whole */
      const mainSphere = harness.group.getObjectByName('main-sphere')
      const mainContour = harness.group.getObjectByName('main-contour')
      const mainSpinner = harness.group.getObjectByName('main-spinner')

      const frame = (now) => {
        raf = requestAnimationFrame(frame)
        /* Consumed here, not in the observer callback — see resizePending's declaration
           comment. This must run before render() below, and nothing between here and that
           render() call may `return`/`continue` past it, or a resized-but-unpainted frame
           can reach the screen again. */
        if (resizePending) {
          resizePending = false
          resize()
        }
        const real = (now - t0) / 1000
        const introReal = INTRO_END / INTRO_SPEED
        const rate = real < introReal ? INTRO_SPEED : 1
        const dt = Math.min(0.05, (now - last) / 1000) * rate
        last = now
        const t = real < introReal ? real * INTRO_SPEED : INTRO_END + (real - introReal)
        const pTarget = reduced ? 1 : locked ? 0 : progress()
        if (reduced || locked) {
          pSmooth = pTarget // no added motion under reduced-motion; exact 0 through the build lock
        } else if (releasedAt >= 0 && now - releasedAt < RELEASE_MS) {
          // the intro just ended: ease from the gated 0 to the live scroll position, whatever it is
          pSmooth = pTarget * easeInOutCubic(clamp01((now - releasedAt) / RELEASE_MS))
        } else {
          pSmooth += (pTarget - pSmooth) * 0.2
        }
        const p = pSmooth
        // The lockup flip (lockup-flip.js) follows this same gated progress, not the raw scroll.
        hero.dataset.heroP = p.toFixed(4)
        const tip = easeInOutCubic(clamp01((p - TIP_FROM) / (TIP_TO - TIP_FROM)))

        const state = {}
        for (const [key, start, dur] of BUILD) state[key] = reduced ? 1 : clamp01((t - start) / dur)
        const buildDone = state.merge >= 1
        if (buildDone && locked) {
          locked = false
          releasedAt = now
          release()
        }
        if (buildDone && !readyFired) {
          readyFired = true
          onReady?.()
        }

        state.spin = Math.PI * 2 * easeInOutCubic(clamp01(p / (TIP_TO * 0.95)))
        state.green = smoothstep(0.42, 0.9, p)
        state.time = t
        state.cursor = pointerIn ? hit : null
        state.waveAxis = tip
        state.tip = tip
        state.buildFlash = reduced ? 0 : clamp01(1 - (t - FLASH_T) / 2.2)
        if (!firedArrival && t >= ARRIVAL_T) {
          firedArrival = true
          field.pulse({ amp: 0.2, decay: 1.1 }) // small, local; the latch keeps full strength
        }
        if (!firedWave && (t >= WAVE_T || reduced)) {
          firedWave = true
          field.pulse()
        }

        harness.update(state)
        /* after harness.update(), which rewrites main's transform every frame. Sphere and
           contour only — the group carries the label spinner and the clamp's squeeze. */
        const open = easeOutCubic(state.open ?? 1)
        const openScale = Math.max(0.0001, open) // never exactly 0: a zero matrix is non-invertible
        mainSphere.scale.setScalar(openScale)
        mainContour.scale.setScalar(openScale)
        mainSphere.visible = open > 0.02
        mainContour.visible = open > 0.02
        mainSpinner.visible = open > 0.99
        field.update(dt, {
          mass: open, // the well deepens as main opens
          time: t,
          lift: 1 - tip, // ridge height fades as the camera tips (see field-3d.js)
          // the sheet never rises above the ring's underside inside the harness footprint
          underHarness: { r: harness.dims.rOut * 1.06, y: seatY - harness.dims.k * 4.5 }
        })
        if (pointerIn) {
          rayc.setFromCamera(ndc, camera)
          if (rayc.ray.intersectPlane(groundPlane, hit)) field.setCursor(hit)
        }
        beam.update(t, camera)
        infinity.update(t, reduced ? 0 : firedWave ? FLOW_T : null, reduced)
        floaters.update(reduced ? 0 : t)
        setCopy(p, buildDone)

        px += (mx - px) * 0.05
        py += (my - py) * 0.05
        const dist = lerp(13.5, 10.4, tip)
        place(lerp(88, 17, tip) + py * 2.5 * tip, dist, lerp(seatY, seatY + 1, tip), px * 3.5 * tip)
        /* the end pose rises over the last stretch: the frame shift (down) eased back and past into a lift (up) */
        {
          const w = hero.clientWidth
          const h = hero.clientHeight
          if (w > 0 && h > 0) {
            camera.setViewOffset(w, h, 0, -shiftPx + END_LIFT * h * smoothstep(LIFT_FROM, LIFT_TO, p), w, h)
            camera.updateProjectionMatrix()
          }
        }
        field.setFade(dist * 0.8, dist * 2.7)
        renderer.render(scene, camera)
      }
      raf = requestAnimationFrame(frame)

      cleanupBuild = () => {
        cancelled = true
        cancelAnimationFrame(raf)
        hero.removeEventListener('pointermove', onMove)
        hero.removeEventListener('pointerleave', onLeave)
        release()
        live = null
        scene.remove(harness.group, field.mesh, beam.group, floaters.points, infinity.group)
        scene.traverse((o) => {
          o.geometry?.dispose?.()
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of mats) {
              m.map?.dispose?.()
              m.alphaMap?.dispose?.()
              m.dispose?.()
            }
          }
        })
      }
    })
    /* a build that throws must never surface as an unhandled rejection, nor leave the
       page scroll-locked behind a hero that will never finish building */
    building.catch(() => {
      release()
    })
    cleanupBuild = () => {
      cancelled = true
      release()
    }
  }

  /* theme change repaints IN PLACE. Materials capture token values at build time, so
     flipping data-theme alone leaves the 3D on the old palette — but rebuilding the scene
     replays the whole build animation and re-locks the scroll for a palette change, which
     is wrong. Each module owns a retheme() that re-reads the tokens and repaints its own
     colours, uniforms and label textures; geometry and animation state are untouched. */
  function applyTheme() {
    /* a half-applied theme (a preview frame mid-swap) keeps the current palette; the
       observer fires again once the rest of the tokens land */
    const next = readPalette(hero)
    if (!next) return
    ;({ bg, ink, sand, card, flow, fabricInk, fabricAlpha } = next)
    scene.background = new THREE.Color(bg)
    renderer.setClearColor(bg, 1)
    if (!live) return
    live.harness.retheme()
    live.field.retheme({ ink: fabricInk, surface: bg, opacity: fabricAlpha })
    live.beam.retheme({ ink, sand, card })
    live.floaters.retheme(fabricInk, fabricAlpha * FLOATER_ALPHA)
    live.infinity.retheme(flow)
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })

  build()

  return {
    applyTheme,
    dispose() {
      disposed = true
      cleanupBuild()
      resizeObserver.disconnect()
      themeObserver.disconnect()
      renderer.dispose()
    }
  }
}
