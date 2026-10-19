import * as THREE from 'three'
import { alphaAt, coverageMask, drawnMask } from '@/ui/lib/mask-canvas'
import { clamp01 } from '@/ui/lib/math'
import { tokenHex } from '@/ui/lib/theme-color'

/**
 * Hot issue as one scroll-driven descent: main, red, one CI run in five
 * failing → the hot Issue, written by the Principal with their agent, and its
 * branch forked by `vinaya hot start` → the camera drops onto that one lane:
 * a commit through the Ring 0 hooks, a push, the pull request, CI's Ring 1,
 * the review once (code above, security below, in parallel), the Principal's
 * merge, main green again → the closure (the Issue closed, the run ended, the
 * retrospective kept) → the Log's report and the month around this fix → the
 * Improver's one finding → the new Project it produces, with its Why.
 *
 * Cut down from Medium work's scene (`flows/medium/medium-scene.js`), itself
 * copied from Complex work's: the token reader, the flat materials, the panels,
 * the labels, the camera that only goes down are that scene's; the altitudes are
 * Hot issue's. Narrow on purpose: one card, one lane, one merge, much air.
 *
 * Inputs: `story` (what to draw and when: story.ts), `archive()` (0..1 through
 * the closing lines) and `track`, whose rectangle encodes the walk's progress.
 * Every weight below is a pure function of that progress (and of `archive`), so
 * scrolling back replays the same frames; the camera only eases.
 *
 * Stays `.js`: three ships its own types. Every DOM read lives inside this
 * factory, never at module scope (it would throw under SSR).
 */
/* a soft round point's alpha from its centre to its edge */
const POINT_FALLOFF = [
  [0, 1],
  [0.6, 0.8],
  [1, 0]
]

export function mountHotScene({ canvas, labelLayer, track, labelClass, story, archive }) {
  let vw = 1
  let vh = 1
  let vTop = 0
  let vLeft = 0
  let disposed = false

  /* ── colour: shadcn tokens, resolved through a canvas (oklch included) ───── */
  const cssRoot = getComputedStyle(document.documentElement)
  const C = {
    background: tokenHex('--background'),
    foreground: tokenHex('--foreground'),
    muted: tokenHex('--muted-foreground'),
    primary: tokenHex('--primary'),
    destructive: tokenHex('--destructive'),
    merged: tokenHex('--success')
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setClearColor(C.background, 1)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(C.background, 9, 30)
  const FOV = 34
  const TAN = Math.tan((FOV * Math.PI) / 180 / 2)
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200)

  let seed = 20260827
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  const V = (x, y, z) => new THREE.Vector3(x, y, z)
  // 0..1 across a scroll window [from, to], eased
  const win = (v, w) => smooth(clamp01((v - w[0]) / (w[1] - w[0])))

  // flat = unlit basic materials, so a diagram reads as a diagram at any angle
  const flat = (name, color, opacity) =>
    new THREE.MeshBasicMaterial({ name, color, transparent: true, opacity, side: THREE.DoubleSide })
  const stroke = (name, color, opacity) => new THREE.LineBasicMaterial({ name, color, transparent: true, opacity })
  const TOKEN_OF = {
    ink: '--foreground',
    soft: '--muted-foreground',
    inkFill: '--foreground',
    mutedFill: '--muted-foreground',
    primaryStroke: '--primary',
    primaryFill: '--primary',
    mergedStroke: '--success',
    mergedFill: '--success',
    paper: '--background',
    rejectFill: '--destructive',
    pulseFill: '--primary',
    frameInk: '--foreground',
    flowFill: '--muted-foreground',
    shelfInk: '--muted-foreground',
    loopFill: '--primary',
    storyFill: '--muted-foreground',
    aiInk: '--primary',
    mainInk: '--foreground'
  }
  /* Live colour slots: the review and security nodes change state mid-run, so their
     materials are lerped between these every frame rather than pinned to one token. */
  const COL = {
    primary: new THREE.Color(C.primary),
    destructive: new THREE.Color(C.destructive),
    success: new THREE.Color(C.merged),
    muted: new THREE.Color(C.muted)
  }
  const M = {
    ink: stroke('foreground', C.foreground, 0.6),
    soft: stroke('mutedForeground', C.muted, 0.4),
    inkFill: flat('foregroundFill', C.foreground, 0.85),
    mutedFill: flat('mutedFill', C.muted, 0.5),
    primaryStroke: stroke('primaryStroke', C.primary, 0.85),
    primaryFill: flat('primaryFill', C.primary, 0.9),
    mergedStroke: stroke('chart2Stroke', C.merged, 0.9),
    mergedFill: flat('chart2Fill', C.merged, 0.9),
    paper: flat('paper', C.background, 0.82),
    reviewFill: flat('reviewFill', C.primary, 0.9),
    reviewStroke: stroke('reviewStroke', C.primary, 0.85),
    securityFill: flat('securityFill', C.primary, 0.9),
    securityStroke: stroke('securityStroke', C.primary, 0.85),
    rejectFill: flat('rejectFill', C.destructive, 0.9),
    pulseFill: flat('pulseFill', C.primary, 0.9),
    // the altitudes around the task
    frameInk: stroke('milestoneFrame', C.foreground, 0.5),
    flowFill: flat('productFlow', C.muted, 0.5),
    shelfInk: stroke('archiveShelf', C.muted, 0.5),
    loopFill: flat('loopBack', C.primary, 0.8),
    storyFill: flat('logThreads', C.muted, 0.5),
    aiInk: stroke('improverFrame', C.primary, 0.6),
    // main, the floor the lane leaves and lands on
    mainInk: flat('mainRail', C.foreground, 0.85)
  }

  /* Every panel of text is a canvas painted onto a plane: the only way to carry real
     words at this scale, and text painted into the surface stays in perspective. */
  const panels = []

  /* A theme switch must repaint the scene, not reload the page: re-read every token
     and push it back into the materials and the panels. */
  function applyTheme() {
    Object.entries(TOKEN_OF).forEach(([k, name]) => {
      M[k]?.color.setHex(tokenHex(name))
    })
    const bg = tokenHex('--background')
    renderer.setClearColor(bg, 1)
    scene.fog.color.setHex(bg)
    sphere.material.color.setHex(tokenHex('--muted-foreground'))
    COL.primary.setHex(tokenHex('--primary'))
    COL.destructive.setHex(tokenHex('--destructive'))
    COL.success.setHex(tokenHex('--success'))
    COL.muted.setHex(tokenHex('--muted-foreground'))
    panels.forEach((pl) => {
      pl.redraw()
    })
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-scheme', 'class']
  })

  /* ── geometry helpers ─────────────────────────────────────────────────── */
  const geoFrom = (pts) => new THREE.BufferGeometry().setFromPoints(pts)
  function circleStroke(r, n = 40) {
    const pts = []
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      pts.push(V(Math.cos(a) * r, Math.sin(a) * r, 0))
    }
    return geoFrom(pts)
  }
  function roundRectStroke(w, h, r, seg = 6) {
    const x = w / 2 - r
    const y = h / 2 - r
    const pts = []
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= seg; i++) {
        const a = a0 + (i / seg) * (Math.PI / 2)
        pts.push(V(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0))
      }
    }
    // start at the top-left corner's end so a draw range reveals it clockwise from there
    corner(-x, y, Math.PI / 2)
    corner(-x, -y, Math.PI)
    corner(x, -y, Math.PI * 1.5)
    corner(x, y, 0)
    pts.push(pts[0].clone())
    return geoFrom(pts)
  }
  const path = (geo, m, name) => {
    const o = new THREE.Line(geo, m)
    o.name = name
    return o
  }
  const tube = (pts, r, m, name) => {
    const o = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r, 6, false), m)
    o.name = name
    return o
  }
  // from a curve you already hold — dense enough to reveal by draw range
  const tubeC = (curve, segs, r, m, name) => {
    const o = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, r, 8, false), m)
    o.name = name
    return o
  }
  // a tube revealed from its start by a 0..1 share (TubeGeometry walks by arc length)
  function growTube(pts, r, m, name, segs = 160) {
    const o = tubeC(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), segs, r, m, name)
    const n = o.geometry.index.count
    o.grow = (f) => {
      o.visible = f > 0.002
      o.geometry.setDrawRange(0, Math.max(6, Math.round(n * f)))
    }
    o.grow(0)
    return o
  }
  const dot = (r, m, name) => {
    const o = new THREE.Mesh(new THREE.CircleGeometry(r, 28), m)
    o.name = name
    return o
  }

  /* ── panels: text painted to a canvas, mapped onto a plane ────────────── */
  const PPU = 620
  const fontVar = (name, fb) => cssRoot.getPropertyValue(name).trim() || fb
  /* No text under 14px at 1440: there the camera rests about 160px from a world unit, so no panel paints its
     type smaller than 0.09 of one. `redraw` sets the floor in the panel's own pixels before it draws. */
  const MIN_TEXT = 0.09
  let minPx = 0
  const mono = (px, w = 500) =>
    `${w} ${Math.round(Math.max(px, minPx))}px ${fontVar('--font-mono', 'ui-monospace, monospace')}`
  const sans = (px, w = 500) =>
    `${w} ${Math.round(Math.max(px, minPx))}px ${fontVar('--font-sans', 'ui-sans-serif, system-ui, sans-serif')}`
  const chan = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255]
  const rgba = (h, a) => `rgba(${chan(h)},${a})`
  const palette = () => ({
    fg: tokenHex('--foreground'),
    mu: tokenHex('--muted-foreground'),
    card: tokenHex('--card'),
    pr: tokenHex('--primary'),
    ok: tokenHex('--success'),
    heat: tokenHex('--destructive'),
    bad: tokenHex('--destructive'),
    think: tokenHex('--chart-3'),
    exec: tokenHex('--chart-4')
  })

  function panel(name, w, h, draw, ppu = PPU) {
    const cv = document.createElement('canvas')
    cv.width = Math.round(w * ppu)
    cv.height = Math.round(h * ppu)
    const ctx = cv.getContext('2d')
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const mat = new THREE.MeshBasicMaterial({
      name,
      map: tex,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
    mesh.name = name
    mesh.visible = false
    const pl = {
      mesh,
      mat,
      tex,
      state: {},
      key: null,
      redraw() {
        ctx.clearRect(0, 0, cv.width, cv.height)
        ctx.textBaseline = 'middle'
        minPx = MIN_TEXT * ppu
        draw(ctx, cv.width, cv.height, pl.state, ppu, palette())
        tex.needsUpdate = true
      },
      // repaint only when what it shows has changed
      set(state) {
        const k = JSON.stringify(state)
        if (k === pl.key) return
        pl.key = k
        pl.state = state
        pl.redraw()
      },
      show(o) {
        mat.opacity = o
        mesh.visible = o > 0.004
      }
    }
    panels.push(pl)
    return pl
  }

  // ── canvas drawing helpers (all sizes in px of the panel's own canvas)
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
  }
  function ellipsize(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text
    let t = text
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1)
    return `${t}…`
  }
  function wrap(ctx, text, max, lines) {
    const out = []
    let cur = ''
    for (const w of text.split(' ')) {
      const next = cur ? `${cur} ${w}` : w
      if (ctx.measureText(next).width > max && cur) {
        out.push(cur)
        cur = w
      } else cur = next
    }
    if (cur) out.push(cur)
    if (out.length > lines) {
      const rest = out.slice(lines - 1).join(' ')
      out.length = lines - 1
      out.push(ellipsize(ctx, rest, max))
    }
    return out
  }
  /** A status chip; `x` is its left edge, or its right edge when `right`. Returns its width. */
  function chip(ctx, text, x, yc, h, col, { filled = false, right = true, flash = 0 } = {}) {
    ctx.font = mono(h * 0.56)
    const w = ctx.measureText(text).width + h * 1.1
    const x0 = right ? x - w : x
    rrect(ctx, x0, yc - h / 2, w, h, h / 2)
    ctx.fillStyle = rgba(col, filled ? 0.22 + flash * 0.4 : 0.08 + flash * 0.3)
    ctx.fill()
    ctx.lineWidth = Math.max(1.5, h * 0.05)
    ctx.strokeStyle = rgba(col, filled ? 0.85 : 0.6)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = rgba(col, 0.98)
    ctx.fillText(text, x0 + w / 2, yc + 1)
    return w
  }
  // a brand mark (a 24 × 24 SVG path), drawn s px tall
  const markPath = story.tracker.mark ? new Path2D(story.tracker.mark) : null
  function mark(ctx, x, y, s, col) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(s / 24, s / 24)
    ctx.fillStyle = rgba(col, 0.95)
    if (markPath) ctx.fill(markPath)
    else ctx.fillRect(0, 0, 24, 24)
    ctx.restore()
  }

  /* Product marks: lucide outlines (ISC), 24 × 24, stroked in the tile's tone. */
  const ICONS = {
    phone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
    monitor: ['M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
    cloud: ['M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'],
    server: [
      'M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
      'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
      'M6 6h.01',
      'M6 18h.01'
    ],
    database: ['M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0', 'M3 5V19A9 3 0 0 0 21 19V5', 'M3 12A9 3 0 0 0 21 12'],
    dashboard: [
      'M4 3h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      'M15 3h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      'M15 12h5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
      'M4 16h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z'
    ],
    flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
    check: ['M20 6 9 17l-5-5'],
    arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
    arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
    shield: [
      'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'
    ],
    eye: [
      'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
      'M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0'
    ],
    wrench: [
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'
    ]
  }
  function icon(ctx, name, x, y, s, col, alpha = 0.95) {
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(s / 24, s / 24)
    ctx.lineWidth = 1.8
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = rgba(col, alpha)
    for (const d of ICONS[name] ?? ICONS.dashboard) ctx.stroke(new Path2D(d))
    ctx.restore()
  }

  /* The product side as the reader knows it: their tracker's dashboard — its mark and
     name, a sidebar, the deploy's one target — holding the Projects as tiles. */
  function drawDashboard(ctx, W, H, s, u, c) {
    const r = 0.06 * u
    rrect(ctx, 2, 2, W - 4, H - 4, r)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.25)
    ctx.stroke()
    const hh = DASH.head * u
    const sw = DASH.side * u
    // the bar: the tracker's mark and name, then the target
    mark(ctx, 0.14 * u, hh / 2 - 0.07 * u, 0.14 * u, c.fg)
    ctx.textAlign = 'left'
    ctx.font = sans(0.12 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.95)
    ctx.fillText(story.tracker.name, 0.36 * u, hh / 2)
    ctx.font = sans(0.12 * u, 500)
    ctx.fillStyle = rgba(c.mu, 0.95)
    const tw = ctx.measureText(story.tracker.name).width
    ctx.font = sans(0.12 * u, 600)
    ctx.fillStyle = rgba(c.mu, 0.6)
    ctx.fillText('/', 0.36 * u + tw + 0.1 * u, hh / 2)
    ctx.fillStyle = rgba(c.fg, 0.95)
    ctx.fillText(s.target ?? story.board, 0.36 * u + tw + 0.26 * u, hh / 2)
    ctx.beginPath()
    ctx.moveTo(0, hh)
    ctx.lineTo(W, hh)
    ctx.moveTo(sw, hh)
    ctx.lineTo(sw, H)
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(c.fg, 0.14)
    ctx.stroke()
    // the sidebar: wordless nav, the Projects entry lit
    for (let i = 0; i < 4; i++) {
      const y = hh + 0.24 * u + i * 0.2 * u
      rrect(ctx, 0.12 * u, y - 0.035 * u, sw - 0.24 * u, 0.07 * u, 0.035 * u)
      ctx.fillStyle = i === 1 ? rgba(c.pr, 0.55) : rgba(c.mu, 0.22)
      ctx.fill()
    }
  }
  // one Project: its mark and its name, nothing else; lit once it is in the deploy
  function drawProduct(ctx, W, H, s, u, c) {
    const col = s.fresh ? c.ok : c.pr
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 1)
    ctx.fill()
    if (s.lit) {
      ctx.fillStyle = rgba(col, 0.08 * s.lit)
      ctx.fill()
    }
    ctx.lineWidth = 4
    ctx.strokeStyle = s.lit ? rgba(col, 0.35 + 0.5 * s.lit) : rgba(c.fg, 0.22)
    ctx.stroke()
    const pad = 0.1 * u
    // the marks of the products it touches, small, in a row; the feature's name, large, below
    ;(s.icons ?? [s.icon]).forEach((name, i) => {
      icon(ctx, name, pad + i * 0.26 * u, pad, 0.19 * u, s.lit ? col : c.fg)
    })
    ctx.textAlign = 'left'
    ctx.font = sans(0.13 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    wrap(ctx, s.name, W - pad * 2, 3)
      .reverse()
      .forEach((l, i) => {
        ctx.fillText(l, pad, H - pad - 0.06 * u - i * 0.155 * u)
      })
  }

  /* ── Hot issue's own panels ───────────────────────────────────────────── */

  /* The hot Issue, as the agent writes it: its number and the hot label, its title, then
     its brief, the single-fix profile, one row at a time as the line types. */
  function drawIssue(ctx, W, H, s, u, c) {
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 1)
    ctx.fill()
    ctx.lineWidth = 5
    ctx.strokeStyle = rgba(c.heat, 0.75)
    ctx.stroke()
    const pad = 0.14 * u
    ctx.textAlign = 'left'
    ctx.font = mono(0.07 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`#${story.issue.n} · Issue`, pad, pad + 0.03 * u)
    chip(ctx, 'vinaya/hot', W - pad, pad + 0.03 * u, 0.13 * u, c.heat, { filled: true })
    // the chip centres its text: back to the left edge for the title and the brief
    ctx.textAlign = 'left'
    ctx.font = sans(0.19 * u, 500)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(story.issue.title, pad, 0.42 * u)
    const y0 = 0.68 * u
    const rh = 0.2 * u
    story.brief.forEach((row, i) => {
      if (i >= s.rows) return
      const y = y0 + i * rh
      ctx.font = mono(0.06 * u)
      ctx.fillStyle = rgba(c.mu, 0.95)
      ctx.fillText(row.label.toUpperCase(), pad, y)
      ctx.font = sans(0.085 * u, 500)
      ctx.fillStyle = rgba(c.fg, 0.95)
      ctx.fillText(ellipsize(ctx, row.value, W - pad * 2 - 0.72 * u), pad + 0.72 * u, y)
    })
  }

  // main's state, under main: red while one CI run in five fails, green once the fix lands
  function drawMainState(ctx, _W, H, s, _u, c) {
    const col = s.green ? c.ok : c.bad
    chip(ctx, s.green ? 'main green · 0 failures' : 'CI · 1 run in 5 fails', 2, H / 2, H * 0.8, col, {
      filled: s.green,
      right: false,
      flash: s.flash
    })
  }

  // the Issue at the closure: its title and number, and its state, which flips to closed
  function drawIssueRow(ctx, W, H, s, u, c) {
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    if (s.flash) {
      ctx.fillStyle = rgba(c.ok, s.flash * 0.16)
      ctx.fill()
    }
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(s.closed ? c.ok : c.fg, s.closed ? 0.7 : 0.25)
    ctx.stroke()
    const pad = 0.1 * u
    ctx.textAlign = 'left'
    ctx.font = sans(0.1 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(story.issue.title, pad, H / 2)
    const nw = ctx.measureText(story.issue.title).width
    ctx.font = mono(0.065 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`· #${story.issue.n} · hot`, pad + nw + 0.06 * u, H / 2)
    chip(ctx, s.closed ? 'closed' : 'open', W - pad, H / 2, H * 0.5, s.closed ? c.ok : c.heat, {
      filled: s.closed,
      flash: s.flash
    })
  }

  // the hot run's identity: minted by hot start, ended when both verdicts are posted
  function drawRunRow(ctx, W, H, s, u, c) {
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(s.ended ? c.ok : c.fg, s.ended ? 0.7 : 0.25)
    ctx.stroke()
    const pad = 0.1 * u
    ctx.textAlign = 'left'
    ctx.font = mono(0.095 * u)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(`run ${story.issue.run} · run_started → ${s.ended ? 'run_ended · 9 min' : '…'}`, pad, H / 2)
    chip(ctx, s.ended ? 'ended' : 'running', W - pad, H / 2, H * 0.5, s.ended ? c.ok : c.pr, { filled: s.ended })
  }

  /* The last 30 days of hot fixes: one mark per fix on a day axis, the ones in the
     same place as this one in the hot colour, this one ringed. Three is a pattern. */
  function drawMonth(ctx, W, H, _s, u, c) {
    const pad = 0.12 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = mono(0.065 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText('HOT FIXES · LAST 30 DAYS', pad, 0.14 * u)
    const x0 = pad
    const x1 = W - pad
    const y = H * 0.55
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.mu, 0.4)
    ctx.stroke()
    for (let d = 0; d <= 30; d += 5) {
      const x = x0 + ((x1 - x0) * d) / 30
      ctx.beginPath()
      ctx.moveTo(x, y - 0.03 * u)
      ctx.lineTo(x, y + 0.03 * u)
      ctx.stroke()
    }
    const last = story.month[story.month.length - 1]
    story.month.forEach((m) => {
      const x = x0 + ((x1 - x0) * m.day) / 30
      ctx.beginPath()
      ctx.arc(x, y, 0.045 * u, 0, Math.PI * 2)
      ctx.fillStyle = m.here ? rgba(c.heat, 0.95) : rgba(c.mu, 0.55)
      ctx.fill()
      if (m === last) {
        ctx.beginPath()
        ctx.arc(x, y, 0.085 * u, 0, Math.PI * 2)
        ctx.lineWidth = 3
        ctx.strokeStyle = rgba(c.heat, 0.9)
        ctx.stroke()
      }
    })
    ctx.font = sans(0.075 * u, 500)
    ctx.fillStyle = rgba(c.heat, 0.95)
    ctx.fillText(`● apps/cli tests · ${story.month.filter((m) => m.here).length} fixes`, pad, H - 0.13 * u)
    ctx.textAlign = 'right'
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`○ this one · #${story.issue.n}`, W - pad, H - 0.13 * u)
  }

  // the retrospective: there from the start, pending, then kept — one line, large
  function drawRetro(ctx, W, H, s, u, c) {
    const col = s.kept ? c.ok : c.mu
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    if (s.flash) {
      ctx.fillStyle = rgba(c.ok, s.flash * 0.16)
      ctx.fill()
    }
    ctx.lineWidth = 3
    if (!s.kept) ctx.setLineDash([10, 8])
    ctx.strokeStyle = rgba(col, s.kept ? 0.7 : 0.35)
    ctx.stroke()
    ctx.setLineDash([])
    const is = 0.15 * u
    icon(ctx, 'check', 0.08 * u, (H - is) / 2, is, col, s.kept ? 0.95 : 0.5)
    ctx.textAlign = 'left'
    ctx.font = sans(0.1 * u, 600)
    ctx.fillStyle = rgba(s.kept ? c.fg : c.mu, s.kept ? 0.96 : 0.8)
    ctx.fillText(s.kept ? 'Retrospective kept' : 'Retrospective', 0.08 * u + is + 0.06 * u, H / 2)
    ctx.textAlign = 'right'
    ctx.font = sans(0.08 * u, 500)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(s.kept ? 'what shipped and why' : 'when the Issue closes', W - 0.08 * u, H / 2)
  }

  // the report's head: what it reports on, and how much of it shipped
  function drawReportHead(ctx, W, H, s, u, c) {
    const pad = 0.12 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = mono(0.055 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText('HOT RUN REPORT', pad, 0.14 * u)
    ctx.font = sans(0.14 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(s.title, pad, 0.33 * u)
    ctx.textAlign = 'right'
    ctx.font = sans(0.075 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.95)
    const rest = ` of ${s.total} merged`
    ctx.font = sans(0.075 * u, 400)
    const rw = ctx.measureText(rest).width
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(rest, W - pad, 0.33 * u)
    ctx.font = sans(0.075 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(String(s.done), W - pad - rw, 0.33 * u)
    const by = H - 0.12 * u
    const bh = 0.04 * u
    rrect(ctx, pad, by - bh / 2, W - pad * 2, bh, bh / 2)
    ctx.fillStyle = rgba(c.mu, 0.25)
    ctx.fill()
    rrect(ctx, pad, by - bh / 2, (W - pad * 2) * (s.done / s.total), bh, bh / 2)
    ctx.fillStyle = rgba(c.ok, 0.95)
    ctx.fill()
  }

  // one stat of the report: what it counts, the figure, one line on where it comes from
  function drawStat(ctx, W, H, s, u, c) {
    const pad = 0.09 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(s.hot ? c.heat : c.fg, s.hot ? 0.6 : 0.2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = mono(0.052 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(s.label.toUpperCase(), pad, 0.13 * u)
    ctx.font = sans(0.2 * u, 600)
    ctx.fillStyle = rgba(s.hot ? c.heat : c.fg, 0.97)
    ctx.fillText(s.value, pad, 0.36 * u)
    ctx.font = sans(0.062 * u, 400)
    ctx.fillStyle = rgba(c.mu, 0.95)
    wrap(ctx, s.detail, W - pad * 2, 2).forEach((l, i) => {
      ctx.fillText(l, pad, 0.6 * u + i * 0.11 * u)
    })
  }

  // the Improver's card head: the eye that watches every run, and its name
  function drawImproverHead(ctx, W, H, s, u, c) {
    const is = 0.2 * u
    icon(ctx, 'eye', 0.12 * u, (H - is) / 2, is, c.pr)
    ctx.textAlign = 'left'
    ctx.font = sans(0.13 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText('Improver', 0.12 * u + is + 0.08 * u, H / 2)
    // what it found, large, in the other corner
    ctx.textAlign = 'right'
    ctx.font = sans(0.13 * u, 600)
    const rest = s.count === 1 ? ' improvement found' : ' improvements found'
    const rw = ctx.measureText(rest).width
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(rest, W - 0.12 * u, H / 2)
    ctx.fillStyle = rgba(c.pr, 0.97)
    ctx.fillText(String(s.count), W - 0.12 * u - rw, H / 2)
  }

  // one finding of the report, and under it the change it asks for: centred, large
  function drawFinding(ctx, W, H, s, u, c) {
    const pad = 0.1 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = rgba(c.fg, 0.18)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.font = sans(0.088 * u, 400)
    ctx.fillStyle = rgba(c.mu, 0.97)
    const found = wrap(ctx, s.found, W - pad * 2, 2)
    found.forEach((l, i) => {
      ctx.fillText(l, W / 2, H * 0.22 + (i - (found.length - 1) / 2) * 0.11 * u)
    })
    const is = 0.15 * u
    icon(ctx, 'arrowDown', (W - is) / 2, H * 0.47 - is / 2, is, c.pr)
    ctx.font = sans(0.1 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    const change = wrap(ctx, s.change, W - pad * 2, 3)
    change.forEach((l, i) => {
      ctx.fillText(l, W / 2, H * 0.74 + (i - (change.length - 1) / 2) * 0.125 * u)
    })
  }

  // why the new Project is worth doing: the report's lines, as the tracker shows them
  function drawWhy(ctx, W, H, _s, u, c) {
    const pad = 0.1 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 1)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.22)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = sans(0.14 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText('Why', pad, 0.2 * u)
    ctx.font = sans(0.075 * u, 400)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`From the #${story.issue.n} report`, pad, 0.34 * u)
    story.why.forEach((line, i) => {
      const y = 0.58 * u + i * 0.36 * u
      icon(ctx, 'check', pad, y - 0.07 * u, 0.14 * u, c.ok)
      ctx.font = sans(0.1 * u, 600)
      ctx.fillStyle = rgba(c.fg, 0.96)
      wrap(ctx, line, W - pad * 2 - 0.2 * u, 2).forEach((l, j) => {
        ctx.fillText(l, pad + 0.2 * u, y + j * 0.12 * u)
      })
    })
  }

  const graph = new THREE.Group()
  graph.name = 'lifeCycle'
  scene.add(graph)

  /* ── the forge it all lives in: one big sparse sphere of points ─────────── */
  const SPH_N = 1500
  const SPH_R = 9.2
  const sph = new Float32Array(SPH_N * 3)
  for (let i = 0; i < SPH_N; i++) {
    const u = rnd()
    const v = rnd()
    const th = 2 * Math.PI * u
    const ph = Math.acos(2 * v - 1)
    sph[i * 3] = SPH_R * Math.sin(ph) * Math.cos(th)
    sph[i * 3 + 1] = SPH_R * Math.cos(ph)
    sph[i * 3 + 2] = SPH_R * Math.sin(ph) * Math.sin(th)
  }
  const sphGeo = new THREE.BufferGeometry()
  sphGeo.setAttribute('position', new THREE.BufferAttribute(sph, 3))
  const sphere = new THREE.Points(
    sphGeo,
    new THREE.PointsMaterial({
      color: C.muted,
      size: 0.03,
      // a soft round point: square sprites read as stray boxes when the camera passes close
      map: (() => {
        const cv = coverageMask(32, 32, (x, y) => alphaAt(POINT_FALLOFF, Math.hypot(x - 16, y - 16) / 16))
        return new THREE.CanvasTexture(cv)
      })(),
      alphaTest: 0.05,
      depthWrite: false,
      transparent: true,
      opacity: 0.24,
      sizeAttenuation: true,
      fog: false
    })
  )
  sphere.name = 'forgeSphere'
  sphere.position.set(0.4, 0, -2.4)
  scene.add(sphere)

  /* ── the scroll windows (progress.ts sets the stage windows around them) ──
     TRAVEL[i] is the camera's leg INTO altitude i; between legs it holds. The first
     leg is a drop onto the lane, at the commit: the gates are what Executing reads. */
  const C0 = story.cue
  const TRAVEL = [
    null,
    [C0.commit[0] - 0.01, C0.commit[0] + 0.03],
    [0.72, 0.75],
    [0.805, 0.835],
    [0.855, 0.88],
    [0.92, 0.935]
  ]
  const CUE_HEAD = [0.81, 0.83] // the report: its head…
  const CUE_TILE = (k) => [0.82 + 0.007 * k, 0.835 + 0.007 * k] // …its figures…
  const CUE_MONTH = [0.84, 0.855] // …the month around this fix
  const CUE_LEARN = [0.85, 0.87] // the Improver reads the report…
  const CUE_FIND = [0.875, 0.895] // …its one finding and the change it asks for
  const CUE_NEXT = [0.905, 0.925] // back upstream: the tracker again
  const CUE_NEW = [0.94, 0.96] // the change, approved: a new Project in the tracker
  const CUE_WHYCARD = [0.945, 0.965] // the report that justifies it

  const BOX_X = 0.1
  const BOX_W = 4.4
  const LEFT = BOX_X - BOX_W / 2 - 0.08
  const RIGHT = BOX_X + BOX_W / 2 + 0.08
  // the tracker's board, in world units, as Medium work's
  const DASH = { w: 4.5, h: 2.55, head: 0.42, side: 0.55 }
  const DASH_W = DASH.w
  const DASH_H = DASH.h

  // a fine vertical link between two altitudes, grown by a share
  function link(x, y0, y1, name) {
    const line = growTube([V(x, y0, 0), V(x, y1, 0)], 0.0032, M.flowFill, name, 40)
    graph.add(line)
    return (f) => {
      line.grow(f)
    }
  }

  /* ── 01 · PAIRING — main, red; the hot Issue; its branch, forked by hot start ── */
  const CARD_W = 3.0
  const CARD_H = 1.62
  const CARD_TOP = 4.1
  const card = panel('hotIssue', CARD_W, CARD_H, drawIssue, 520)
  card.mesh.position.set(BOX_X, CARD_TOP - CARD_H / 2, 0)
  graph.add(card.mesh)

  /* ── 02 · EXECUTING — one lane off main, through every gate, back onto main ──── */
  const MAIN_Y = 0.55
  const LANE_Y = 1.55
  const EX_L = BOX_X - BOX_W / 2 + 0.05
  const EX_R = BOX_X + BOX_W / 2 - 0.05
  const FORK_X = -1.35
  const RISE = 0.35
  const MERGE_X = 2.05
  // a label's width apart, so the gates' names never meet
  const X = { commit: -0.45, push: 0.15, ci: 0.75, rev0: 1.0, rev1: 1.55, end: MERGE_X - RISE }
  const mainMat = M.mainInk
  const mainRail = tube([V(EX_L, MAIN_Y, 0), V(EX_R, MAIN_Y, 0)], 0.011, mainMat, 'main')
  graph.add(mainRail)
  // the red mark on main: the failing test, until the fix lands on it
  const FAIL_X = -1.75
  const failMat = flat('mainFailing', C.destructive, 0.9)
  const failDot = dot(0.055, failMat, 'mainFailing')
  failDot.position.set(FAIL_X, MAIN_Y, 0.008)
  graph.add(failDot)
  const mainState = panel('mainState', 1.5, 0.17, drawMainState)
  mainState.mesh.position.set(EX_L + 0.75, MAIN_Y - 0.2, 0)
  graph.add(mainState.mesh)

  /* The lane is constructed, not interpolated: a smoothstep rise off main, a dead
     straight run through every gate, a smoothstep drop back onto main. */
  function lanePath() {
    const pts = []
    for (let i = 0; i <= 24; i++) {
      const f = i / 24
      pts.push(V(FORK_X + RISE * f, MAIN_Y + (LANE_Y - MAIN_Y) * smooth(f), 0.004))
    }
    for (let i = 1; i <= 60; i++) pts.push(V(FORK_X + RISE + (X.end - FORK_X - RISE) * (i / 60), LANE_Y, 0.004))
    for (let i = 1; i <= 24; i++) {
      const f = i / 24
      pts.push(V(X.end + RISE * f, LANE_Y - (LANE_Y - MAIN_Y) * smooth(f), 0.004))
    }
    return pts
  }
  const laneMat = flat('hotLane', C.primary, 0.9)
  const laneCurve = new THREE.CatmullRomCurve3(lanePath(), false, 'centripetal')
  const lane = tubeC(laneCurve, 320, 0.0105, laneMat, 'hotLane')
  graph.add(lane)
  const LANE_IDX = lane.geometry.index.count
  // TubeGeometry walks the curve by arc length, so a draw range IS a distance along it
  const laneScan = laneCurve.getSpacedPoints(500)
  const fracAtX = (x) => {
    for (let i = 0; i < laneScan.length; i++)
      if (laneScan[i].x >= x - 1e-6 && laneScan[i].y >= LANE_Y - 0.001) return i / (laneScan.length - 1)
    return 1
  }
  /* How far the lane is drawn at v: to the lane's start on hot start, then to each gate
     as its line types, then down onto main on the merge. */
  const LANE_STOPS = [
    [C0.fork, fracAtX(FORK_X + RISE)],
    [C0.fix, fracAtX(X.commit - 0.2)],
    [C0.commit, fracAtX(X.commit)],
    [C0.push, fracAtX(X.push)],
    [C0.ci, fracAtX(X.ci)],
    [C0.review, fracAtX(X.rev0)],
    [C0.approve, fracAtX(X.end)],
    [C0.merge, 1]
  ]
  function laneAt(v) {
    let f = 0
    let prev = 0
    for (const [w, to] of LANE_STOPS) {
      if (v < w[0]) break
      f = prev + (to - prev) * win(v, w)
      prev = to
    }
    return f
  }

  // the pair: the Principal and the agent, beside the branch they share; each lights as they speak
  const PAIR_Y = LANE_Y + 0.5
  const pairMats = { you: flat('pairYou', C.muted, 0.8), agent: flat('pairAgent', C.muted, 0.8) }
  const pairDots = {
    you: dot(0.06, pairMats.you, 'pairYou'),
    agent: dot(0.06, pairMats.agent, 'pairAgent')
  }
  pairDots.you.position.set(-1.15, PAIR_Y, 0.006)
  pairDots.agent.position.set(-0.75, PAIR_Y, 0.006)
  graph.add(pairDots.you, pairDots.agent)

  /* A gate on the lane: a commit dot in a ring that takes the gate's colour —
     muted until its hook starts, primary while it runs, success once green. Each
     gate owns its materials, so one can run while the one before is green. */
  function gate(x, name, r = 0.1) {
    const g = new THREE.Group()
    g.name = name
    g.position.set(x, LANE_Y, 0.01)
    const ring = stroke(`${name}Ring`, C.muted, 0.9)
    const fill = flat(`${name}Fill`, C.primary, 0.9)
    g.add(dot(r, M.paper, `${name}Face`))
    g.add(path(circleStroke(r, 36), ring, `${name}Ring`))
    g.add(dot(r * 0.5, fill, `${name}Dot`))
    graph.add(g)
    return { g, ring, fill }
  }
  const gCommit = gate(X.commit, 'commit')
  const gPush = gate(X.push, 'push')
  const gCi = gate(X.ci, 'ci', 0.13)

  // the review, once: the code reviewer above, the security reviewer below, in parallel, then back onto the lane
  function spurPoints(y, x0, x1) {
    const pts = []
    const n = 72
    const rise = 0.18
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n
      const a = smooth(clamp01((x - x0) / rise))
      const b = smooth(clamp01((x1 - x) / rise))
      pts.push(V(x, LANE_Y + (y - LANE_Y) * Math.min(a, b), 0.003))
    }
    return pts
  }
  const UP_Y = LANE_Y + 0.34
  const DOWN_Y = LANE_Y - 0.34
  const reviewMats = { code: flat('codeReview', C.primary, 0.9), security: flat('securityReview', C.primary, 0.9) }
  const spurs = {
    code: growTube(spurPoints(UP_Y, X.rev0, X.rev1), 0.008, reviewMats.code, 'codeReviewSpur', 120),
    security: growTube(spurPoints(DOWN_Y, X.rev0, X.rev1), 0.008, reviewMats.security, 'securityReviewSpur', 120)
  }
  graph.add(spurs.code, spurs.security)
  /* The two checks wear their marks: code review an eye, security a shield, each in a
     ring that takes the check's colour. The mark is drawn white into a texture and
     tinted by its material, so the colour follows every frame. */
  function markTexture(name) {
    const cv = drawnMask(128, 128, (x) => {
      x.scale(128 / 24, 128 / 24)
      x.lineWidth = 1.9
      x.lineCap = 'round'
      x.lineJoin = 'round'
      for (const d of ICONS[name]) x.stroke(new Path2D(d))
    })
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }
  const CHECK_R = 0.13
  const checks = Object.fromEntries(
    [
      ['code', 'eye', UP_Y],
      ['security', 'shield', DOWN_Y]
    ].map(([k, iconName, y]) => {
      const g = new THREE.Group()
      g.name = `${k}Check`
      g.position.set((X.rev0 + X.rev1) / 2, y, 0.01)
      const ring = stroke(`${k}CheckRing`, C.primary, 0.9)
      const mat = new THREE.MeshBasicMaterial({
        map: markTexture(iconName),
        color: C.primary,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      })
      g.add(dot(CHECK_R, M.paper, 'checkFace'))
      g.add(path(circleStroke(CHECK_R, 40), ring, 'checkRing'))
      const markMesh = new THREE.Mesh(new THREE.PlaneGeometry(CHECK_R * 1.15, CHECK_R * 1.15), mat)
      markMesh.position.z = 0.002
      g.add(markMesh)
      graph.add(g)
      return [k, { g, ring, mat }]
    })
  )

  // the one pull request the branch lives on: a bracket under the lane, from the first commit to the merge
  const PR_Y = LANE_Y - 0.58
  const prBracket = path(
    geoFrom([V(X.commit, PR_Y + 0.08, 0), V(X.commit, PR_Y, 0), V(X.end, PR_Y, 0), V(X.end, PR_Y + 0.08, 0)]),
    M.soft,
    'prBracket'
  )
  graph.add(prBracket)

  // the Principal's merge onto main
  const mergeNode = new THREE.Group()
  mergeNode.name = 'merge'
  mergeNode.position.set(MERGE_X, MAIN_Y, 0.014)
  mergeNode.add(dot(0.085, M.mergedFill, 'mergeDot'))
  mergeNode.add(path(circleStroke(0.085, 32), M.mergedStroke, 'mergeRing'))
  graph.add(mergeNode)
  const EX_TOP = PAIR_Y + 0.3
  const EX_BOTTOM = MAIN_Y - 0.32

  /* ── 03 · CLOSING — the Issue closed, the run ended, the retrospective kept ─────── */
  const CL_TOP = EX_BOTTOM - 0.7
  const ROW_H = 0.34
  const RETRO_H = 0.36
  const issueRow = panel('issueRow', BOX_W, ROW_H, drawIssueRow)
  issueRow.mesh.position.set(BOX_X, CL_TOP - ROW_H / 2, 0)
  graph.add(issueRow.mesh)
  const runRow = panel('runRow', BOX_W, ROW_H, drawRunRow)
  const RUN_Y = CL_TOP - ROW_H - 0.14 - ROW_H / 2
  runRow.mesh.position.set(BOX_X, RUN_Y, 0)
  graph.add(runRow.mesh)
  const retro = panel('retro', BOX_W - 0.3, RETRO_H, drawRetro)
  retro.set({})
  const RETRO_Y = RUN_Y - ROW_H / 2 - 0.3 - RETRO_H / 2
  retro.mesh.position.set(BOX_X, RETRO_Y, 0)
  graph.add(retro.mesh)
  const CL_BOTTOM = RETRO_Y - RETRO_H / 2
  const toClosing = link(MERGE_X, MAIN_Y - 0.09, CL_TOP, 'mergeToClosing')

  // the closing order, one unit per typed line: the divider, the Issue closed, the record
  const ISSUE_UNIT = 1
  const RECORD_UNIT = 2
  const UN = 3
  const closedAt = Array.from({ length: UN }, () => -1) // when each unit closed, for its one flash
  let uEased = 0
  let uShown = -1
  const FLASH_MS = 900
  let mergedAt = -1

  /* ── 04 · REPORT — what the Log says about the hot run ─────────────────────── */
  const REPORT_W = BOX_W
  const REPORT_TOP = CL_BOTTOM - 0.7
  const HEAD_H = 0.62
  const STAT_H = 1.0
  const MONTH_H = 0.86
  const GAP = 0.1
  const STAT_W = (REPORT_W - GAP * 2) / 3
  const toReport = link(BOX_X, CL_BOTTOM, REPORT_TOP, 'closingToReport')
  const reportHead = panel('reportHead', REPORT_W, HEAD_H, drawReportHead)
  reportHead.set({ title: `Hot fix #${story.issue.n}`, done: 1, total: 1 })
  reportHead.mesh.position.set(BOX_X, REPORT_TOP - HEAD_H / 2, 0)
  graph.add(reportHead.mesh)
  const statsY = REPORT_TOP - HEAD_H - GAP - STAT_H / 2
  const stats = story.stats.slice(0, 3).map((st, i) => {
    const pl = panel(`stat_${i}`, STAT_W, STAT_H, drawStat)
    pl.set(st)
    pl.home = V(BOX_X - REPORT_W / 2 + STAT_W / 2 + i * (STAT_W + GAP), statsY, 0)
    graph.add(pl.mesh)
    return pl
  })
  const month = panel('month', REPORT_W, MONTH_H, drawMonth)
  month.set({})
  month.home = V(BOX_X, statsY - STAT_H / 2 - GAP - MONTH_H / 2, 0)
  graph.add(month.mesh)
  const REPORT_BOTTOM = month.home.y - MONTH_H / 2

  /* ── 05 · SELF-IMPROVEMENT — the Improver reads the report, finds one thing ──── */
  const LEARN_TOP = REPORT_BOTTOM - 0.7
  const LEARN_HEAD = 0.46
  const FIND_H = 1.2
  const FIND_W = 2.6
  const LEARN_BOTTOM = LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H - 0.12
  const learnFrame = path(roundRectStroke(REPORT_W, LEARN_TOP - LEARN_BOTTOM, 0.12), M.aiInk, 'improverFrame')
  learnFrame.position.set(BOX_X, (LEARN_TOP + LEARN_BOTTOM) / 2, -0.01)
  graph.add(learnFrame)
  const learnHead = panel('improverHead', REPORT_W - 0.08, LEARN_HEAD, drawImproverHead)
  learnHead.set({ count: 1 })
  learnHead.mesh.position.set(BOX_X, LEARN_TOP - LEARN_HEAD / 2 - 0.03, 0.002)
  graph.add(learnHead.mesh)
  const findPanel = panel('finding', FIND_W, FIND_H, drawFinding)
  findPanel.set(story.finding)
  findPanel.home = V(BOX_X, LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H / 2, 0)
  graph.add(findPanel.mesh)
  const toLearn = link(BOX_X, REPORT_BOTTOM, LEARN_TOP, 'toImprover')

  /* ── 06 · BACK UPSTREAM — the tracker again: the new Project and its Why ─────── */
  const NEXT_Y = LEARN_BOTTOM - 0.7 - DASH_H / 2
  const nextDash = panel('nextDashboard', DASH_W, DASH_H, drawDashboard, 400)
  nextDash.set({ target: 'From the Log' })
  nextDash.mesh.position.set(BOX_X, NEXT_Y, 0)
  graph.add(nextDash.mesh)
  const contentX0 = BOX_X - DASH_W / 2 + DASH.side + 0.16
  const contentW = DASH_W - DASH.side - 0.32
  const contentH = DASH_H - DASH.head - 0.32
  const contentY = NEXT_Y - DASH.head / 2
  const NEW_W = contentW * 0.44
  const newCard = panel('newProject', NEW_W, contentH, drawProduct)
  newCard.mesh.position.set(contentX0 + NEW_W / 2, contentY, 0.01)
  newCard.mesh.renderOrder = 2
  graph.add(newCard.mesh)
  const WHY_W = contentW - NEW_W - 0.14
  const whyCard = panel('whyCard', WHY_W, contentH, drawWhy)
  whyCard.set({})
  whyCard.mesh.position.set(contentX0 + NEW_W + 0.14 + WHY_W / 2, contentY, 0.01)
  whyCard.mesh.renderOrder = 2
  graph.add(whyCard.mesh)
  const toNext = link(BOX_X, LEARN_BOTTOM, NEXT_Y + DASH_H / 2, 'toTracker')

  /* ── labels: DOM spans placed by projection, one altitude each ─────────── */
  const ALT = { pairing: 0, executing: 1, closing: 2, report: 3, improve: 4, next: 5 }
  const anchor = (x, y, z = 0) => {
    const o = new THREE.Object3D()
    o.position.set(x, y, z)
    graph.add(o)
    return o
  }
  const EX = [ALT.pairing, ALT.executing]
  const LABELS = [
    { text: 'main', obj: anchor(EX_L, MAIN_Y + 0.12), alt: EX, tone: 'ink', align: 'left' },
    // the two names stand outside the pair, so they never meet
    { text: 'you', obj: anchor(-1.26, PAIR_Y), alt: EX, tone: 'ink', cls: 'tiny', align: 'right', gate: 'pair' },
    { text: story.agent, obj: anchor(-0.64, PAIR_Y), alt: EX, tone: 'ink', cls: 'tiny', align: 'left', gate: 'pair' },
    {
      text: story.issue.branch,
      obj: anchor(FORK_X + RISE + 0.04, LANE_Y + 0.13),
      alt: EX,
      tone: 'muted',
      cls: 'tiny',
      align: 'left',
      gate: 'fork'
    },
    {
      text: `run ${story.issue.run}`,
      obj: anchor(FORK_X - 0.06, (MAIN_Y + LANE_Y) / 2),
      alt: EX,
      tone: 'muted',
      cls: 'tiny',
      align: 'right',
      gate: 'fork'
    },
    {
      text: 'edits tmp.test.ts',
      obj: anchor(FORK_X + RISE + 0.04, LANE_Y - 0.2),
      alt: EX,
      tone: 'muted',
      cls: 'tiny',
      align: 'left',
      gate: 'fix'
    },
    // the gates' names: short, one row under the lane, and under them the ring each belongs to
    { text: 'commit', obj: anchor(X.commit, LANE_Y - 0.22), alt: EX, tone: 'ink', cls: 'tiny', gate: 'commit' },
    { text: 'push', obj: anchor(X.push, LANE_Y - 0.22), alt: EX, tone: 'ink', cls: 'tiny', gate: 'push' },
    { text: 'CI', obj: anchor(X.ci, LANE_Y - 0.22), alt: EX, tone: 'ink', cls: 'tiny', gate: 'ci' },
    {
      text: 'Ring 0 · hooks',
      obj: anchor((X.commit + X.push) / 2, LANE_Y - 0.37),
      alt: EX,
      tone: 'muted',
      cls: 'tiny',
      gate: 'push'
    },
    { text: 'Ring 1', obj: anchor(X.ci, LANE_Y - 0.37), alt: EX, tone: 'muted', cls: 'tiny', gate: 'ci' },
    {
      text: 'review · once, on demand',
      obj: anchor((X.rev0 + X.rev1) / 2, UP_Y + 0.25),
      alt: EX,
      tone: 'ink',
      cls: 'tiny',
      gate: 'review'
    },
    {
      text: `pull request #${story.issue.pr}`,
      obj: anchor(X.commit, PR_Y - 0.11),
      alt: EX,
      tone: 'muted',
      cls: 'tiny',
      align: 'left',
      gate: 'pr'
    },
    {
      text: 'merged by the Principal',
      obj: anchor(MERGE_X + 0.12, MAIN_Y - 0.2),
      alt: EX,
      tone: 'merged',
      cls: 'tiny',
      align: 'right',
      gate: 'merge'
    },
    {
      text: `approved · a new ${story.tracker.unit} in ${story.tracker.name}`,
      obj: anchor(BOX_X, NEXT_Y - DASH_H / 2 - 0.12),
      alt: [ALT.next],
      tone: 'merged',
      gate: 'new'
    }
  ]
  LABELS.forEach((l) => {
    const el = document.createElement('span')
    el.className = labelClass(l.tone, l.cls)
    el.textContent = l.text
    labelLayer.appendChild(el)
    l.el = el
    l.world = new THREE.Vector3()
  })

  /* ── camera: one descent through six framed altitudes ─────────────────────
     Each altitude is a box in the drawing; the camera looks at it from one fixed
     direction, from the distance that fits it in the view. Between the legs it
     holds; on a leg it eases from one box to the next. Every box sits lower than
     the one before, so the camera only ever goes down: the first leg drops from
     the Issue and its branch onto the lane alone. */
  const DIR = V(0.09, 0.16, 1).normalize()
  const FILL_W = 0.88
  const FILL_H = 0.82
  const BOXES = [
    [LEFT, RIGHT, EX_BOTTOM - 0.04, CARD_TOP + 0.08],
    [LEFT, RIGHT, EX_BOTTOM - 0.06, EX_TOP + 0.06],
    [LEFT, RIGHT, CL_BOTTOM - 0.08, CL_TOP + 0.08],
    [LEFT, RIGHT, REPORT_BOTTOM - 0.08, REPORT_TOP + 0.08],
    [LEFT, RIGHT, LEARN_BOTTOM - 0.08, LEARN_TOP + 0.08],
    [BOX_X - DASH_W / 2 - 0.08, BOX_X + DASH_W / 2 + 0.08, NEXT_Y - DASH_H / 2 - 0.28, NEXT_Y + DASH_H / 2 + 0.08]
  ]
  function fit(i, out) {
    const b = BOXES[i]
    out.c.set((b[0] + b[1]) / 2, (b[2] + b[3]) / 2, 0)
    out.d = Math.max((b[3] - b[2]) / 2 / (TAN * FILL_H), (b[1] - b[0]) / 2 / (TAN * camera.aspect * FILL_W))
    return out
  }
  const fa = { c: new THREE.Vector3(), d: 1 }
  const fb = { c: new THREE.Vector3(), d: 1 }
  const cTgt = new THREE.Vector3()
  const cPos = new THREE.Vector3()

  /* Where the camera is along the descent: the altitude it holds, or the leg it is
     on and how far along. `alt` is continuous: 1.5 is halfway from 1 to 2. */
  function altitudeAt(v) {
    for (let i = TRAVEL.length - 1; i >= 1; i--) {
      const [s, e] = TRAVEL[i]
      if (v >= e) return i
      if (v >= s) return i - 1 + smooth((v - s) / (e - s))
    }
    return 0
  }

  /* Labels hand off with an OVERLAP: an arriving altitude's labels are fully legible
     by the middle of the leg, and the leaving altitude's only start to fade there,
     so no scroll position has neither. Pure functions of p, never of direction. */
  function altWeight(i, v) {
    const into = TRAVEL[i]
    const out = TRAVEL[i + 1]
    const arrive = into ? smooth(clamp01((v - into[0]) / ((into[1] - into[0]) / 2))) : 1
    const leave = out ? 1 - smooth(clamp01((v - (out[0] + out[1]) / 2) / ((out[1] - out[0]) / 2))) : 1
    return arrive * leave
  }

  // ?lifecycle=0.42 pins the scene at one progress: a deep link, and how it is inspected
  // (re-read when the query changes, so replaceState can step through the altitudes)
  let search = null
  let pinned
  const readPin = () => {
    if (location.search === search) return
    search = location.search
    const raw = new URLSearchParams(search).get('lifecycle')
    pinned = raw === null ? undefined : clamp01(+raw)
  }
  readPin()
  const archiveOf = (v) => (pinned === undefined ? clamp01(archive?.() ?? 0) : clamp01((v - 0.72) / 0.08))
  let target = pinned ?? 0
  let p = target
  let px = 0
  let py = 0
  let mx = 0
  let my = 0
  const onPointerMove = (e) => {
    px = ((e.clientX - vLeft) / vw - 0.5) * 2
    py = ((e.clientY - vTop) / vh - 0.5) * 2
  }
  addEventListener('pointermove', onPointerMove, { passive: true })

  function resize() {
    const r = canvas.getBoundingClientRect()
    vw = Math.max(1, Math.round(r.width))
    vh = Math.max(1, Math.round(r.height))
    vLeft = r.left
    vTop = r.top
    renderer.setSize(vw, vh, false)
    camera.aspect = vw / vh
    camera.updateProjectionMatrix()
  }
  addEventListener('resize', resize)
  // the pane resizes with the app shell, not only with the window
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas)
  resize()

  /* ── reduced motion: one composed, static frame per step ─────────────────
     The walk hands a reduced-motion reader each step finished, so the camera
     snaps to the altitude that step ends on, fitted whole, every label on. */
  function fitComposed(v) {
    fit(Math.round(altitudeAt(v)), fa)
    cTgt.copy(fa.c)
    cPos.copy(cTgt).addScaledVector(DIR, fa.d)
    return fa.d
  }

  const flashOf = (i, ms) => (closedAt[i] < 0 ? 0 : clamp01(1 - (ms - closedAt[i]) / FLASH_MS))
  const tmp = new THREE.Vector3()
  const proj = new THREE.Vector3()
  const cMix = new THREE.Color()
  const gates = {}

  if (document.fonts)
    document.fonts.ready.then(() => {
      if (!disposed)
        panels.forEach((pl) => {
          pl.redraw()
        })
    })

  /* A gate's state at v, a pure function of v: 0 before its hook starts, 0..1 while
     it runs, then 1 → 2 as it turns green over the end of its span. */
  const gateAt = (v, sp) => (v < sp[0] ? 0 : v < sp[1] ? 1 : 2)
  function paintGate(gt, v, sp, show, base) {
    gt.g.visible = show > 0.02
    gt.g.scale.setScalar(Math.max(0.001, show))
    const st = gateAt(v, sp)
    cMix.copy(st === 0 ? COL.muted : st === 1 ? COL.primary : COL.success)
    gt.ring.color.copy(cMix)
    gt.fill.color.copy(cMix)
    gt.ring.opacity = base
    gt.fill.opacity = base
  }

  function frame(ms) {
    const t = ms / 1000
    /* Progress is the stand-in track's offset against the canvas. */
    const cr = canvas.getBoundingClientRect()
    vLeft = cr.left
    vTop = cr.top
    readPin()
    if (pinned !== undefined) target = pinned
    else {
      const r = track.getBoundingClientRect()
      target = clamp01((vTop - r.top) / Math.max(1, r.height - vh))
    }
    p = reduced ? target : p + (target - p) * 0.07
    const units = archiveOf(target) * UN
    uEased = reduced ? units : uEased + (units - uEased) * 0.07
    // the easing never quite lands: snap the last hundredth, so the final unit always closes
    if (Math.abs(units - uEased) < 0.01) uEased = units

    // ── camera
    const alt = altitudeAt(p)
    let dist
    if (reduced) dist = fitComposed(p)
    else {
      const i0 = Math.floor(alt)
      const i1 = Math.min(BOXES.length - 1, i0 + 1)
      const f = alt - i0
      fit(i0, fa)
      fit(i1, fb)
      cTgt.lerpVectors(fa.c, fb.c, f)
      dist = fa.d + (fb.d - fa.d) * f
      mx += (px - mx) * 0.05
      my += (py - my) * 0.05
      cPos.copy(cTgt).addScaledVector(DIR, dist)
      // a little parallax off the pointer; never enough to lift the camera back an altitude
      cPos.x += mx * 0.18 * (dist / 6)
      cPos.y -= my * 0.12 * (dist / 6)
    }
    camera.position.copy(cPos)
    camera.lookAt(cTgt)
    scene.fog.near = dist * 0.75
    scene.fog.far = dist * 2.6
    sphere.position.y = cTgt.y * 0.55
    if (!reduced) {
      sphere.rotation.y = t * 0.02
      sphere.rotation.x = Math.sin(t * 0.05) * 0.12
    }

    // ── contrast per altitude: present, just no longer the thing being read
    const W = BOXES.map((_, i) => (reduced ? (Math.round(alt) === i ? 1 : 0.3) : altWeight(i, p)))
    const w = (...ix) => Math.max(...ix.map((i) => W[i]))
    const lift = (o, ...ix) => o * (0.3 + 0.7 * w(...ix))
    const wEx = w(ALT.pairing, ALT.executing)
    const base = 0.3 + 0.65 * wEx

    // 01 · pairing: main red from the start; the Issue as it is written; the pair as they speak; the fork
    mainMat.opacity = 0.3 + 0.55 * wEx
    card.set({ rows: Math.floor(clamp01((p - C0.rows[0]) / (C0.rows[1] - C0.rows[0])) * story.brief.length + 1e-4) })
    card.show(win(p, C0.card) * lift(1, ALT.pairing))
    const firstWord = story.speakers[0]?.span[0] ?? 0
    gates.pair = win(p, [firstWord, firstWord + 0.01])
    for (const who of ['you', 'agent']) {
      // lit while their line types, a moment after, then back to rest
      const speaking = story.speakers.some((sp) => sp.who === who && p >= sp.span[0] && p <= sp.span[1] + 0.004)
      const m = pairMats[who]
      m.color.copy(speaking ? COL.primary : COL.muted)
      m.opacity = base * (speaking ? 1 : 0.6) * gates.pair
      pairDots[who].visible = gates.pair > 0.02
      pairDots[who].scale.setScalar(speaking && !reduced ? 1.25 + 0.15 * Math.sin(t * 8) : 1)
    }
    const forkF = win(p, C0.fork)
    gates.fork = forkF
    gates.fix = win(p, C0.fix) * (1 - win(p, C0.commit))

    // 02 · executing: the lane drawn gate by gate, each gate's colour its state, the review once, the merge
    const laneF = laneAt(p)
    lane.visible = laneF > 0.002
    lane.geometry.setDrawRange(0, Math.max(6, Math.round(LANE_IDX * laneF)))
    const mergeF = win(p, C0.merge)
    laneMat.color.copy(COL.primary).lerp(COL.success, mergeF)
    laneMat.opacity = base
    const pop = (sp) => smooth(clamp01((p - sp[0]) / Math.max(1e-4, (sp[1] - sp[0]) * 0.5)))
    paintGate(gCommit, p, C0.ring0Commit, pop(C0.commit), base)
    paintGate(gPush, p, C0.ring0Push, pop(C0.push), base)
    paintGate(gCi, p, C0.ci, pop(C0.ci), base)
    gates.commit = pop(C0.commit)
    gates.push = pop(C0.push)
    gates.ci = pop(C0.ci)
    const revF = win(p, C0.review)
    const okF = win(p, C0.approve)
    for (const k of ['code', 'security']) {
      spurs[k].grow(revF)
      cMix.copy(COL.primary).lerp(COL.success, okF)
      reviewMats[k].color.copy(cMix)
      reviewMats[k].opacity = base
      const ck = checks[k]
      const cp = smooth(clamp01((revF - 0.4) / 0.6))
      ck.g.visible = cp > 0.02
      ck.g.scale.setScalar(Math.max(0.001, cp))
      ck.ring.color.copy(cMix)
      ck.mat.color.copy(cMix)
      ck.ring.opacity = base
      ck.mat.opacity = base
    }
    gates.review = revF
    const prF = win(p, C0.pr)
    prBracket.visible = prF > 0.02
    M.soft.opacity = (0.24 + 0.3 * wEx) * prF
    gates.pr = prF
    mergeNode.visible = mergeF > 0.5
    mergeNode.scale.setScalar(Math.max(0.001, smooth(clamp01((mergeF - 0.5) / 0.5))))
    gates.merge = mergeF
    // main turns green when the fix lands on it: the red mark goes, the state flips once
    const green = mergeF >= 0.99
    if (green && mergedAt < 0) mergedAt = reduced ? ms - FLASH_MS : ms
    if (!green) mergedAt = -1
    failMat.color.copy(COL.destructive).lerp(COL.success, mergeF)
    failMat.opacity = base
    mainState.set({ green, flash: green ? +clamp01(1 - (ms - mergedAt) / FLASH_MS).toFixed(2) : 0 })
    mainState.show(lift(1, ALT.pairing, ALT.executing))
    M.mergedFill.opacity = 0.3 + 0.65 * w(ALT.executing, ALT.closing)
    M.paper.opacity = 0.3 + wEx * 0.55

    // 03 · closing: one unit per closing line typed whole, never on a fraction of it
    toClosing(win(p, [C0.merge[1], TRAVEL[2][1]]))
    const shown = Math.floor(uEased + 1e-4)
    if (shown !== uShown) {
      // a unit closing now flashes once; one jumped over (a fast scroll) closes quietly
      for (let i = 0; i < UN; i++) {
        if (i < shown && closedAt[i] < 0) closedAt[i] = shown - uShown === 1 && !reduced ? ms : ms - FLASH_MS
        if (i >= shown) closedAt[i] = -1
      }
      uShown = shown
    }
    const lc = lift(1, ALT.closing)
    issueRow.set({ closed: shown > ISSUE_UNIT, flash: +flashOf(ISSUE_UNIT, ms).toFixed(2) })
    issueRow.show(lc)
    runRow.set({ ended: p >= C0.approve[1] })
    runRow.show(lc)
    retro.set({ kept: shown > RECORD_UNIT, flash: +flashOf(RECORD_UNIT, ms).toFixed(2) })
    retro.show(lc)

    // 04 · report: the link down, the head, the figures one by one, the month around this fix
    toReport(win(p, [TRAVEL[3][0] - 0.01, TRAVEL[3][1]]))
    const rise = (pl, f, alts) => {
      pl.mesh.position.copy(pl.home ?? pl.mesh.position).add(tmp.set(0, -0.12 * (1 - f), 0))
      pl.show(f * alts)
    }
    reportHead.show(win(p, CUE_HEAD) * lift(1, ALT.report))
    stats.forEach((pl, i) => {
      rise(pl, win(p, CUE_TILE(i)), lift(1, ALT.report))
    })
    rise(month, win(p, CUE_MONTH), lift(1, ALT.report))

    // 05 · self-improvement: the link down, the Improver's card, its one finding
    const learnF = win(p, CUE_LEARN)
    toLearn(learnF)
    learnFrame.visible = learnF > 0.002
    M.aiInk.opacity = learnF * (0.25 + 0.45 * w(ALT.improve))
    learnHead.show(learnF * lift(1, ALT.improve))
    rise(findPanel, win(p, CUE_FIND), lift(1, ALT.improve))

    // 06 · back upstream: the link down, the board, the new Project lit, its Why beside it
    const nextF = win(p, CUE_NEXT)
    const newF = win(p, CUE_NEW)
    toNext(nextF)
    nextDash.show(nextF * lift(1, ALT.next))
    newCard.set({ name: story.proposal, icon: 'wrench', lit: +newF.toFixed(2), fresh: true })
    newCard.show(nextF * lift(1, ALT.next))
    whyCard.show(win(p, CUE_WHYCARD) * lift(1, ALT.next))
    M.flowFill.opacity = 0.25 + 0.4 * w(0, 1, 2, 3, 4, 5)
    gates.new = newF

    // ── labels
    scene.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    LABELS.forEach((l) => {
      l.obj.getWorldPosition(l.world)
      proj.copy(l.world).project(camera)
      const gate = l.gate ? (gates[l.gate] ?? 1) : 1
      const on = (reduced ? (l.alt.includes(Math.round(alt)) ? 1 : 0) : w(...l.alt)) * gate * (proj.z < 1 ? 1 : 0)
      l.el.style.opacity = String(on)
      if (on > 0.01) {
        const ax = l.align === 'left' ? '0' : l.align === 'right' ? '-100%' : '-50%'
        l.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * vw}px, ${(-proj.y * 0.5 + 0.5) * vh}px) translate(${ax}, -50%)`
      }
    })

    renderer.render(scene, camera)
    schedule()
  }

  /* Paint one frame synchronously before scheduling: a document that loads while
     hidden gets no rAF callbacks at all. */
  let queued = false
  let raf = 0
  function schedule() {
    if (queued || disposed || document.hidden) return
    queued = true
    raf = requestAnimationFrame((ms) => {
      queued = false
      frame(ms)
    })
  }
  frame(performance.now())
  const onVisibility = () => {
    if (!document.hidden) schedule()
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    /* App Router remounts on client navigation and StrictMode double-invokes effects
       in dev — without this, two renderers, two rAF loops, two label layers. */
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      themeObserver.disconnect()
      resizeObserver.disconnect()
      removeEventListener('resize', resize)
      removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisibility)
      renderer.dispose()
      scene.traverse((o) => {
        o.geometry?.dispose?.()
        if (o.material && !Object.values(M).includes(o.material)) o.material.dispose?.()
      })
      Object.values(M).forEach((m) => {
        m.dispose()
      })
      panels.forEach((pl) => {
        pl.tex.dispose()
        pl.mat.dispose()
      })
      sphere.material.dispose()
      labelLayer.replaceChildren()
    }
  }
}
