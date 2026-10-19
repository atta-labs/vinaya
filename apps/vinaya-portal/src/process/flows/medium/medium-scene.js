import * as THREE from 'three'
import { alphaAt, coverageMask } from '@/ui/lib/mask-canvas'
import { clamp01 } from '@/ui/lib/math'
import { tokenHex } from '@/ui/lib/theme-color'

/**
 * Medium work as one scroll-driven descent: the one Epic on the tracker's board
 * → its tranche table, the tasks settled in dependency waves → the branch graph,
 * a lane per task rising from the integration branch, each wave tested together
 * and merged to main → the closure (the tranche archived, the Epic done, line by
 * line) → the Log's report, with where each wave's time went → the Improver's
 * findings → the new Epic they produce, with its Why.
 *
 * Copied from Complex work's life-cycle scene (`src/process/lifecycle/lifecycle-scene.js`):
 * the token reader, the flat materials, the panels, the labels, the camera that
 * only goes down are that scene's; the altitudes are Medium work's. No milestone:
 * the middle is a branch graph, so the reader sees agents running side by side
 * and landing on main.
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

export function mountMediumScene({ canvas, labelLayer, track, labelClass, story, archive }) {
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
    merged: tokenHex('--success'),
    // an agent at work: a lane while its agent builds, the integration branch
    build: tokenHex('--chart-5')
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
    mainInk: '--foreground',
    integrationFill: '--chart-5'
  }
  /* Live colour slots: the review and security nodes change state mid-run, so their
     materials are lerped between these every frame rather than pinned to one token. */
  const COL = {
    primary: new THREE.Color(C.primary),
    destructive: new THREE.Color(C.destructive),
    success: new THREE.Color(C.merged),
    muted: new THREE.Color(C.muted),
    build: new THREE.Color(C.build)
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
    // the branch graph's two rails: main, and the integration branch above it
    mainInk: flat('mainRail', C.foreground, 0.85),
    integrationFill: flat('integrationRail', C.build, 0.75)
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
    COL.build.setHex(tokenHex('--chart-5'))
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
  const plane = (w, h, m, x = 0, y = 0, z = 0, name = '') => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m)
    p.position.set(x, y, z)
    p.name = name
    return p
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
    hot: tokenHex('--destructive'),
    think: tokenHex('--chart-3'),
    exec: tokenHex('--chart-4'),
    build: tokenHex('--chart-5')
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

  /* ── Medium work's own panels ─────────────────────────────────────────── */

  // the one Epic, large and alone on the board: its key, its name, the marks of the products it touches
  function drawEpic(ctx, W, H, s, u, c) {
    const col = s.fresh ? c.ok : c.pr
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 1)
    ctx.fill()
    if (s.lit) {
      ctx.fillStyle = rgba(col, 0.06 * s.lit)
      ctx.fill()
    }
    ctx.lineWidth = 5
    ctx.strokeStyle = s.lit ? rgba(col, 0.35 + 0.5 * s.lit) : rgba(c.fg, 0.22)
    ctx.stroke()
    const pad = 0.16 * u
    ctx.textAlign = 'left'
    ctx.font = mono(0.08 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`${story.epic.key} · ${story.tracker.unit}`, pad, pad + 0.04 * u)
    ctx.font = sans(0.3 * u, 500)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(story.epic.name, pad, H * 0.47)
    const is = 0.22 * u
    story.epic.products.forEach((name, i) => {
      icon(ctx, name, pad + i * (is + 0.12 * u), H - pad - is, is, s.lit ? col : c.fg)
    })
  }

  /* The tranche, as the Planner writes it: one table, its tasks settled into three
     wave columns, the dependency edges between the waves, the one task that runs
     after another (the same file) indented under it. Rows appear as they are written. */
  function drawTranche(ctx, W, H, s, u, c) {
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.3)
    ctx.stroke()
    const pad = 0.1 * u
    const hh = TR.head * u
    ctx.textAlign = 'left'
    ctx.font = sans(0.1 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(story.tranche.id, pad, hh / 2)
    ctx.textAlign = 'right'
    ctx.font = mono(0.065 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`standalone · base ${story.tranche.base} · ${TASKS.length} tasks`, W - pad, hh / 2)
    ctx.beginPath()
    ctx.moveTo(pad / 2, hh)
    ctx.lineTo(W - pad / 2, hh)
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(c.fg, 0.14)
    ctx.stroke()
    const cw = (W - pad) / 3
    story.waves.forEach((wv, w) => {
      const x0 = pad / 2 + w * cw
      const a = s.cols
      if (w > 0) {
        ctx.beginPath()
        ctx.moveTo(x0, hh + 0.06 * u)
        ctx.lineTo(x0, H - 0.06 * u)
        ctx.lineWidth = 2
        ctx.strokeStyle = rgba(c.fg, 0.1 * a)
        ctx.stroke()
        // the dependency edge: this wave runs after the one before it
        const is = 0.1 * u
        icon(ctx, 'arrow', x0 - is / 2, hh + TR.waveHead * u * 0.55 - is / 2, is, c.mu, 0.8 * a)
      }
      ctx.textAlign = 'left'
      ctx.font = mono(0.062 * u)
      ctx.fillStyle = rgba(c.exec, 0.95 * a)
      ctx.fillText(wv.name, x0 + 0.1 * u, hh + TR.waveHead * u * 0.55)
      wv.tasks.forEach((t, k) => {
        if (t.g >= s.rows) return
        const y = hh + TR.waveHead * u + (k + 0.5) * TR.row * u
        const ind = t.after ? 0.08 * u : 0
        if (t.after) {
          ctx.beginPath()
          ctx.moveTo(x0 + 0.1 * u + 0.02 * u, y - 0.06 * u)
          ctx.lineTo(x0 + 0.1 * u + 0.02 * u, y + 0.06 * u)
          ctx.lineWidth = 4
          ctx.strokeStyle = rgba(c.fg, 0.8)
          ctx.stroke()
        }
        ctx.font = mono(0.058 * u)
        ctx.fillStyle = rgba(c.mu, 0.95)
        ctx.fillText(`#${t.n}`, x0 + 0.1 * u + ind, y)
        ctx.font = sans(0.07 * u, 500)
        ctx.fillStyle = rgba(c.fg, 0.95)
        const tx = x0 + 0.1 * u + ind + 0.24 * u
        ctx.fillText(ellipsize(ctx, t.title, x0 + cw - 0.06 * u - tx), tx, y)
      })
    })
  }

  // the branch graph's head: the tranche on the left, how its agents stand on the right
  function drawExecHead(ctx, W, H, s, u, c) {
    ctx.font = mono(0.07 * u)
    ctx.textAlign = 'left'
    ctx.fillStyle = rgba(c.fg, 0.95)
    ctx.fillText(`${story.tranche.id} · base ${story.tranche.base}`, 0, H / 2)
    ctx.textAlign = 'right'
    const onMain = `${s.main} of ${TASKS.length} on main`
    ctx.fillStyle = rgba(c.ok, 0.95)
    ctx.fillText(onMain, W, H / 2)
    const mw = ctx.measureText(onMain).width
    const agents = `● ${s.running} running${s.waiting ? ` · ${s.waiting} waiting` : ''}`
    ctx.fillStyle = rgba(c.build, s.running || s.waiting ? 0.95 : 0.45)
    ctx.fillText(agents, W - mw - 0.2 * u, H / 2)
  }

  // the Epic at the closure: its name and key, and its state, which flips to done
  function drawEpicRow(ctx, W, H, s, u, c) {
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    if (s.flash) {
      ctx.fillStyle = rgba(c.ok, s.flash * 0.16)
      ctx.fill()
    }
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(s.done ? c.ok : c.fg, s.done ? 0.7 : 0.25)
    ctx.stroke()
    const pad = 0.1 * u
    ctx.textAlign = 'left'
    ctx.font = sans(0.1 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(story.epic.name, pad, H / 2)
    const nw = ctx.measureText(story.epic.name).width
    ctx.font = mono(0.065 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`· ${story.epic.key}`, pad + nw + 0.06 * u, H / 2)
    chip(ctx, s.done ? 'done' : 'in progress', W - pad, H / 2, H * 0.5, s.done ? c.ok : c.pr, {
      filled: s.done,
      flash: s.flash
    })
  }

  // the tranche at the closure: all merged, then archived
  function drawTrancheRow(ctx, W, H, s, u, c) {
    const done = s.archived
    rrect(ctx, 3, 3, W - 6, H - 6, 0.04 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    if (s.flash) {
      ctx.fillStyle = rgba(c.ok, s.flash * 0.16)
      ctx.fill()
    }
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(done ? c.ok : c.fg, done ? 0.8 : 0.3)
    ctx.stroke()
    const pad = 0.1 * u
    ctx.textAlign = 'left'
    ctx.font = mono(0.075 * u)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(`${story.tranche.id} · ${TASKS.length} of ${TASKS.length} merged`, pad, H / 2)
    chip(ctx, done ? 'archived' : 'active', W - pad, H / 2, H * 0.5, done ? c.ok : c.pr, {
      filled: done,
      flash: s.flash
    })
  }

  /* Where the time goes, per wave: when each wave starts, how long its agents work,
     and, hatched, how long they sit idle waiting on the wave's slowest task. */
  function drawGantt(ctx, W, H, _s, u, c) {
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
    ctx.fillText('WHERE THE TIME GOES · PER WAVE', pad, 0.14 * u)
    const x0 = pad + 0.42 * u
    const bw = W - pad - x0
    const bh = 0.075 * u
    story.waveTime.forEach((wt, i) => {
      const y = 0.3 * u + i * 0.15 * u
      ctx.font = mono(0.06 * u)
      ctx.fillStyle = rgba(c.mu, 0.95)
      ctx.fillText(`wave ${i + 1}`, pad, y)
      // the run's whole length, faint, so the waits read against it
      rrect(ctx, x0, y - bh / 2, bw, bh, bh / 2)
      ctx.fillStyle = rgba(c.mu, 0.1)
      ctx.fill()
      const xs = x0 + (bw * wt.lead) / 100
      const ww = (bw * wt.work) / 100
      const wi = (bw * wt.idle) / 100
      rrect(ctx, xs, y - bh / 2, ww, bh, 2)
      ctx.fillStyle = rgba(c.fg, 0.9)
      ctx.fill()
      hatch(ctx, xs + ww, y - bh / 2, wi, bh, c.hot)
    })
    // the legend
    const ly = H - 0.13 * u
    ctx.font = sans(0.075 * u, 500)
    rrect(ctx, pad, ly - 0.03 * u, 0.12 * u, 0.06 * u, 2)
    ctx.fillStyle = rgba(c.fg, 0.9)
    ctx.fill()
    ctx.fillStyle = rgba(c.fg, 0.95)
    const a = 'agents working'
    ctx.fillText(a, pad + 0.18 * u, ly)
    const lx = pad + 0.18 * u + ctx.measureText(a).width + 0.3 * u
    hatch(ctx, lx, ly - 0.03 * u, 0.12 * u, 0.06 * u, c.hot)
    ctx.fillStyle = rgba(c.hot, 0.95)
    ctx.fillText(
      `idle, waiting on the wave's slowest task · ${story.stats.find((st) => st.hot)?.value ?? ''}`,
      lx + 0.18 * u,
      ly
    )
  }
  // diagonal stripes in a rectangle: idle time
  function hatch(ctx, x, y, w, h, col) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.strokeStyle = rgba(col, 0.9)
    ctx.lineWidth = Math.max(2, h * 0.14)
    for (let k = -h; k < w + h; k += h * 0.45) {
      ctx.beginPath()
      ctx.moveTo(x + k, y + h)
      ctx.lineTo(x + k + h, y)
      ctx.stroke()
    }
    ctx.restore()
    ctx.strokeStyle = rgba(col, 0.7)
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, w, h)
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
    ctx.fillText(s.kept ? 'what shipped and why' : 'when the tranche closes', W - 0.08 * u, H / 2)
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
    ctx.fillText('DELIVERY REPORT', pad, 0.14 * u)
    ctx.font = sans(0.14 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    ctx.fillText(s.title, pad, 0.33 * u)
    ctx.textAlign = 'right'
    ctx.font = sans(0.075 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.95)
    const rest = ` of ${s.total} tasks merged`
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
    ctx.strokeStyle = rgba(s.hot ? c.hot : c.fg, s.hot ? 0.6 : 0.2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = mono(0.052 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(s.label.toUpperCase(), pad, 0.13 * u)
    ctx.font = sans(0.2 * u, 600)
    ctx.fillStyle = rgba(s.hot ? c.hot : c.fg, 0.97)
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
    const rest = ' improvements found'
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
    ctx.fillText(`From the ${story.epic.name} report`, pad, 0.34 * u)
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
     TRAVEL[i] is the camera's leg INTO altitude i; between legs it holds. */
  const TRAVEL = [null, [0.08, 0.12], [0.3, 0.34], [0.7, 0.73], [0.805, 0.835], [0.855, 0.88], [0.92, 0.935]]
  const CUE_LIT = [0.01, 0.05] // the Epic lights as the reader arrives
  const CUE_HEAD = [0.81, 0.83] // the report: its head…
  const CUE_TILE = (k) => [0.82 + 0.007 * k, 0.835 + 0.007 * k] // …its figures…
  const CUE_TIME = [0.84, 0.855] // …where each wave's time goes
  const CUE_LEARN = [0.85, 0.87] // the Improver reads the report…
  const CUE_FIND = (k) => [0.875 + 0.012 * k, 0.89 + 0.012 * k] // …one finding and its change at a time
  const CUE_NEXT = [0.905, 0.925] // back upstream: the tracker again
  const CUE_NEW = [0.94, 0.96] // the first change, approved: a new Epic in the tracker
  const CUE_WHYCARD = [0.945, 0.965] // the report that justifies it

  const BOX_X = 0.1
  const BOX_W = 4.4
  const LEFT = BOX_X - BOX_W / 2 - 0.08
  const RIGHT = BOX_X + BOX_W / 2 + 0.08
  // the tracker's board, in world units: wide and tall enough that the Epic reads at a glance
  const DASH = { w: 4.5, h: 2.55, head: 0.42, side: 0.55 }
  const DASH_W = DASH.w
  const DASH_H = DASH.h

  // every task, in the order the Planner writes them: its wave, its place in it, its slot overall
  const TASKS = story.waves.flatMap((wv, w) => wv.tasks.map((t, k) => ({ ...t, w, k })))
  TASKS.forEach((t, g) => {
    t.g = g
    // the wave's own copy, which drawTranche reads
    story.waves[t.w].tasks[t.k].g = g
  })

  /* ── 01 · UPSTREAM — the tracker's board, one Epic on it ─────────────────── */
  const PRODUCT_Y = 6.75
  const dash = panel('dashboard', DASH_W, DASH_H, drawDashboard, 400)
  dash.set({})
  dash.mesh.position.set(BOX_X, PRODUCT_Y, 0)
  graph.add(dash.mesh)
  const contentX0 = BOX_X - DASH_W / 2 + DASH.side + 0.16
  const contentW = DASH_W - DASH.side - 0.32
  const contentH = DASH_H - DASH.head - 0.32
  const epic = panel('epic', contentW, contentH, drawEpic, 400)
  epic.mesh.position.set(contentX0 + contentW / 2, PRODUCT_Y - DASH.head / 2, 0.01)
  epic.mesh.renderOrder = 2
  graph.add(epic.mesh)

  /* ── 02 · PLANNING — the Epic opens into one tranche table, in wave columns ── */
  const TR = { head: 0.24, waveHead: 0.22, row: 0.17 }
  const MAX_ROWS = Math.max(...story.waves.map((wv) => wv.tasks.length))
  const TR_H = TR.head + TR.waveHead + MAX_ROWS * TR.row + 0.12
  const TR_TOP = 4.3
  const TR_BOTTOM = TR_TOP - TR_H
  const table = panel('tranche', BOX_W, TR_H, drawTranche, 520)
  table.mesh.position.set(BOX_X, TR_TOP - TR_H / 2, 0)
  graph.add(table.mesh)

  // a fine vertical link between two altitudes, grown by a share
  function link(x, y0, y1, name) {
    const line = growTube([V(x, y0, 0), V(x, y1, 0)], 0.0032, M.flowFill, name, 40)
    graph.add(line)
    return (f) => {
      line.grow(f)
    }
  }
  const toTable = link(BOX_X, PRODUCT_Y - DASH_H / 2, TR_TOP, 'epicToTranche')

  /* ── 03 · EXECUTING — the branch graph: main on the floor, the integration
     branch just above it, a lane per task rising from it, wave by wave ────── */
  const INT_Y = 0.25
  const MAIN_Y = -0.1
  const EX_TOP = INT_Y + 2.0
  const EX_BOTTOM = MAIN_Y - 0.24
  const EX_L = BOX_X - BOX_W / 2 + 0.05
  const EX_R = BOX_X + BOX_W / 2 - 0.05
  const toGraph = link(BOX_X, TR_BOTTOM, EX_TOP + 0.06, 'trancheToGraph')
  const LANE_GAP = 0.3
  const WAVE_GAP = 0.62
  // #516, which waits for #515, stands tallest in its wave, so its label clears its neighbours
  const LANE_H = [1.05, 1.3, 1.18, 1.12, 0.98, 1.38, 1.08, 1.0, 1.18, 1.05, 1.3, 1.12]
  const spanW = (TASKS.length - story.waves.length) * LANE_GAP + (story.waves.length - 1) * WAVE_GAP
  {
    let x = BOX_X - spanW / 2
    TASKS.forEach((t, g) => {
      if (g > 0) x += TASKS[g - 1].w === t.w ? LANE_GAP : WAVE_GAP
      t.x = x
      t.top = INT_Y + (LANE_H[g % LANE_H.length] ?? 1.1)
    })
  }
  const waveX = story.waves.map((_, w) => {
    const ts = TASKS.filter((t) => t.w === w)
    return (ts[0].x + ts[ts.length - 1].x) / 2
  })

  const exHead = panel('graphHead', BOX_W, 0.2, drawExecHead)
  exHead.mesh.position.set(BOX_X, EX_TOP - 0.1, 0)
  graph.add(exHead.mesh)

  // main: the floor, a solid rail; the integration branch: a dashed rail just above it
  const mainMat = M.mainInk
  const intMat = M.integrationFill
  const mainRail = growTube([V(EX_L, MAIN_Y, 0), V(EX_R, MAIN_Y, 0)], 0.011, mainMat, 'main', 80)
  graph.add(mainRail)
  const DASH_N = 46
  const dashes = Array.from({ length: DASH_N }, (_, i) => {
    const step = (EX_R - EX_L) / DASH_N
    const d = plane(step * 0.55, 0.012, intMat, EX_L + (i + 0.3) * step, INT_Y, 0, `integration_${i}`)
    graph.add(d)
    return d
  })

  /* Each task's lane: rises from the integration rail to its sandbox node; two
     reviewer dots under the node; the lane's colour is its state — muted while it
     waits, the build colour while its agent works, success once it lands. Each lane owns
     its materials, so one can turn red while its neighbours turn green. */
  const ringGeo = circleStroke(0.055, 32)
  const lanes = TASKS.map((t) => {
    const mats = {
      lane: flat(`lane_${t.n}`, C.build, 0.9),
      ring: stroke(`ring_${t.n}`, C.build, 0.9),
      fill: flat(`fill_${t.n}`, C.merged, 0.9),
      r1: flat(`reviewerA_${t.n}`, C.muted, 0.6),
      r2: flat(`reviewerB_${t.n}`, C.muted, 0.6)
    }
    const tubeM = growTube([V(t.x, INT_Y, 0), V(t.x, t.top, 0)], 0.009, mats.lane, `lane_${t.n}`, 40)
    graph.add(tubeM)
    const node = new THREE.Group()
    node.name = `sandbox_${t.n}`
    node.position.set(t.x, t.top, 0.006)
    node.add(dot(0.055, M.paper, 'sandboxFace'))
    node.add(path(ringGeo, mats.ring, 'sandboxRing'))
    const fill = dot(0.04, mats.fill, 'sandboxLanded')
    fill.position.z = 0.002
    node.add(fill)
    graph.add(node)
    const r1 = dot(0.022, mats.r1, 'reviewerA')
    const r2 = dot(0.022, mats.r2, 'reviewerB')
    r1.position.set(t.x - 0.05, t.top - 0.16, 0.004)
    r2.position.set(t.x + 0.05, t.top - 0.16, 0.004)
    graph.add(r1, r2)
    return { t, mats, tube: tubeM, node, fill, r1, r2 }
  })

  // each wave, tested together, lands on main: a drop from the integration rail and one merge node
  const waveMerges = story.waves.map((wv, w) => {
    const x = waveX[w]
    const drop = growTube([V(x, INT_Y, 0.002), V(x, MAIN_Y, 0.002)], 0.009, M.mergedFill, `waveDrop_${w}`, 30)
    graph.add(drop)
    const pending = path(circleStroke(0.07, 32), M.soft, `wavePending_${w}`)
    pending.position.set(x, MAIN_Y, 0.008)
    graph.add(pending)
    const node = dot(0.07, M.mergedFill, `waveMerge_${w}`)
    node.position.set(x, MAIN_Y, 0.012)
    graph.add(node)
    return { wv, drop, pending, node }
  })

  /* ── 04 · CLOSING — main with its twelve merges; the tranche archived; the
     Epic done; the retrospective kept. Nothing above it: no milestone ──────── */
  const CL_TOP = EX_BOTTOM - 0.7
  const ROW_H = 0.34
  const RETRO_H = 0.36
  const epicRow = panel('epicRow', 2.4, ROW_H, drawEpicRow)
  epicRow.mesh.position.set(BOX_X - BOX_W / 2 + 1.2, CL_TOP - ROW_H / 2, 0)
  graph.add(epicRow.mesh)
  const trRow = panel('trancheRow', BOX_W, ROW_H, drawTrancheRow)
  const TR_ROW_Y = CL_TOP - ROW_H - 0.14 - ROW_H / 2
  trRow.mesh.position.set(BOX_X, TR_ROW_Y, 0)
  graph.add(trRow.mesh)
  const CL_RAIL_Y = TR_ROW_Y - ROW_H / 2 - 0.36
  const clRail = tube([V(EX_L, CL_RAIL_Y, 0), V(EX_R, CL_RAIL_Y, 0)], 0.011, mainMat, 'mainClosed')
  graph.add(clRail)
  const commitsOnMain = TASKS.map((t, i) => {
    const d = dot(0.045, M.mergedFill, `commit_${t.n}`)
    d.position.set(EX_L + 0.2 + (i * (EX_R - EX_L - 0.4)) / (TASKS.length - 1), CL_RAIL_Y, 0.004)
    graph.add(d)
    return d
  })
  const retro = panel('retro', BOX_W - 0.3, RETRO_H, drawRetro)
  retro.set({})
  const RETRO_Y = CL_RAIL_Y - 0.36 - RETRO_H / 2
  retro.mesh.position.set(BOX_X, RETRO_Y, 0)
  graph.add(retro.mesh)
  const CL_BOTTOM = RETRO_Y - RETRO_H / 2
  const toClosing = link(waveX[waveX.length - 1], MAIN_Y - 0.07, CL_TOP, 'mainToClosing')

  // the closing order, one unit per typed line: the divider, the Issues, the tranche, the Epic, the record
  const ISSUES_UNIT = 1
  const TRANCHE_UNIT = 2
  const EPIC_UNIT = 3
  const RECORD_UNIT = 4
  const UN = 5
  const closedAt = Array.from({ length: UN }, () => -1) // when each unit closed, for its one flash
  let uEased = 0
  let uShown = -1
  const FLASH_MS = 900

  /* ── 05 · REPORT — what the Log says about the delivery ────────────────────── */
  const REPORT_W = BOX_W
  const REPORT_TOP = CL_BOTTOM - 0.7
  const HEAD_H = 0.62
  const STAT_H = 1.0
  const TIME_H = 0.86
  const GAP = 0.1
  const STAT_W = (REPORT_W - GAP * 3) / 4
  const toReport = link(BOX_X, CL_BOTTOM, REPORT_TOP, 'closingToReport')
  const reportHead = panel('reportHead', REPORT_W, HEAD_H, drawReportHead)
  reportHead.set({ title: story.epic.name, done: TASKS.length, total: TASKS.length })
  reportHead.mesh.position.set(BOX_X, REPORT_TOP - HEAD_H / 2, 0)
  graph.add(reportHead.mesh)
  const statsY = REPORT_TOP - HEAD_H - GAP - STAT_H / 2
  const stats = story.stats.slice(0, 4).map((st, i) => {
    const pl = panel(`stat_${i}`, STAT_W, STAT_H, drawStat)
    pl.set(st)
    pl.home = V(BOX_X - REPORT_W / 2 + STAT_W / 2 + i * (STAT_W + GAP), statsY, 0)
    graph.add(pl.mesh)
    return pl
  })
  const time = panel('waveTime', REPORT_W, TIME_H, drawGantt)
  time.set({})
  time.home = V(BOX_X, statsY - STAT_H / 2 - GAP - TIME_H / 2, 0)
  graph.add(time.mesh)
  const REPORT_BOTTOM = time.home.y - TIME_H / 2

  /* ── 06 · SELF-IMPROVEMENT — the Improver reads the report, says what to change ── */
  const LEARN_TOP = REPORT_BOTTOM - 0.7
  const LEARN_HEAD = 0.46
  const FIND_H = 1.2
  const FIND_GAP = 0.12
  const findings = story.findings.slice(0, 3)
  const FIND_W = (REPORT_W - 0.24 - FIND_GAP * (findings.length - 1)) / findings.length
  const LEARN_BOTTOM = LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H - 0.12
  const learnFrame = path(roundRectStroke(REPORT_W, LEARN_TOP - LEARN_BOTTOM, 0.12), M.aiInk, 'improverFrame')
  learnFrame.position.set(BOX_X, (LEARN_TOP + LEARN_BOTTOM) / 2, -0.01)
  graph.add(learnFrame)
  const learnHead = panel('improverHead', REPORT_W - 0.08, LEARN_HEAD, drawImproverHead)
  learnHead.set({ count: story.findings.length })
  learnHead.mesh.position.set(BOX_X, LEARN_TOP - LEARN_HEAD / 2 - 0.03, 0.002)
  graph.add(learnHead.mesh)
  const findPanels = findings.map((f, i) => {
    const pl = panel(`finding_${i}`, FIND_W, FIND_H, drawFinding)
    pl.set(f)
    pl.home = V(
      BOX_X - REPORT_W / 2 + 0.12 + FIND_W / 2 + i * (FIND_W + FIND_GAP),
      LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H / 2,
      0
    )
    graph.add(pl.mesh)
    return pl
  })
  const toLearn = link(BOX_X, REPORT_BOTTOM, LEARN_TOP, 'toImprover')

  /* ── 07 · BACK UPSTREAM — the board again: the new Epic and its Why ─────────── */
  const NEXT_Y = LEARN_BOTTOM - 0.7 - DASH_H / 2
  const nextDash = panel('nextDashboard', DASH_W, DASH_H, drawDashboard, 400)
  nextDash.set({ target: 'From the Log' })
  nextDash.mesh.position.set(BOX_X, NEXT_Y, 0)
  graph.add(nextDash.mesh)
  const contentY = NEXT_Y - DASH.head / 2
  const CARD_W = contentW * 0.44
  const newCard = panel('newEpic', CARD_W, contentH, drawProduct)
  newCard.mesh.position.set(contentX0 + CARD_W / 2, contentY, 0.01)
  newCard.mesh.renderOrder = 2
  graph.add(newCard.mesh)
  const WHY_W = contentW - CARD_W - 0.14
  const whyCard = panel('whyCard', WHY_W, contentH, drawWhy)
  whyCard.set({})
  whyCard.mesh.position.set(contentX0 + CARD_W + 0.14 + WHY_W / 2, contentY, 0.01)
  whyCard.mesh.renderOrder = 2
  graph.add(whyCard.mesh)
  const toNext = link(BOX_X, LEARN_BOTTOM, NEXT_Y + DASH_H / 2, 'toTracker')

  /* ── labels: DOM spans placed by projection, one altitude each ─────────── */
  const ALT = { upstream: 0, planning: 1, executing: 2, closing: 3, report: 4, improve: 5, next: 6 }
  const anchor = (x, y, z = 0) => {
    const o = new THREE.Object3D()
    o.position.set(x, y, z)
    graph.add(o)
    return o
  }
  const WAVE_LABEL_Y = INT_Y + 1.7
  const LABELS = [
    ...TASKS.map((t) => ({
      text: `#${t.n}`,
      obj: anchor(t.x, t.top + 0.12),
      alt: [ALT.executing],
      tone: 'ink',
      cls: 'tiny',
      gate: `label_${t.n}`
    })),
    // a task that runs after another names it while it waits, in place of its number
    ...TASKS.filter((t) => t.after).map((t) => ({
      text: `#${t.n} · after #${t.after}`,
      obj: anchor(t.x, t.top + 0.12),
      alt: [ALT.executing],
      tone: 'muted',
      cls: 'tiny',
      gate: `wait_${t.n}`
    })),
    ...story.waves.map((wv, w) => ({
      text: wv.name,
      obj: anchor(waveX[w], WAVE_LABEL_Y),
      alt: [ALT.executing],
      tone: 'muted'
    })),
    { text: 'main', obj: anchor(EX_L, MAIN_Y - 0.13), alt: [ALT.executing], tone: 'ink', align: 'left', gate: 'rails' },
    // between the first two waves' drops to main, where no line crosses it
    {
      text: story.tranche.integration,
      obj: anchor(waveX[0] + 0.1, INT_Y - 0.11),
      alt: [ALT.executing],
      tone: 'muted',
      cls: 'tiny',
      align: 'left',
      gate: 'rails'
    },
    {
      text: `main · ${TASKS.length} merges · no milestone branch to fold back`,
      obj: anchor(EX_L, CL_RAIL_Y - 0.15),
      alt: [ALT.closing],
      tone: 'ink',
      cls: 'tiny',
      align: 'left'
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

  /* ── camera: one descent through seven framed altitudes ───────────────────
     Each altitude is a box in the drawing; the camera looks at it from one fixed
     direction, from the distance that fits it in the view. Between the legs it
     holds; on a leg it eases from one box to the next. Every box sits lower than
     the one before, so the camera only ever goes down. */
  const DIR = V(0.09, 0.16, 1).normalize()
  const FILL_W = 0.88
  const FILL_H = 0.82
  const BOXES = [
    [
      BOX_X - DASH_W / 2 - 0.08,
      BOX_X + DASH_W / 2 + 0.08,
      PRODUCT_Y - DASH_H / 2 - 0.08,
      PRODUCT_Y + DASH_H / 2 + 0.08
    ],
    [LEFT, RIGHT, TR_BOTTOM - 0.1, TR_TOP + 0.1],
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
     on and how far along. `alt` is continuous: 2.5 is halfway from 2 to 3. */
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
  const archiveOf = (v) => (pinned === undefined ? clamp01(archive?.() ?? 0) : clamp01((v - 0.7) / 0.1))
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

  /* What a task's lane shows at v: a pure function of v. `rise` its lane drawn up,
     `waiting` risen but its agent not started, `reject` sent back, `approve` both
     reviewers green, `land` merged into the integration branch. */
  function laneState(t, v) {
    const rise = win(v, t.rise)
    const approve = win(v, t.approve)
    const reject = t.reject ? win(v, t.reject) * (1 - approve) : 0
    const land = win(v, t.land)
    const waiting = rise > 0.5 && v < t.build ? 1 : 0
    return { rise, waiting, reject, approve, land }
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

    // 01 · upstream: the board, the Epic lit as the reader arrives
    dash.show(lift(1, ALT.upstream))
    epic.set({ lit: +win(p, CUE_LIT).toFixed(2) })
    epic.show(lift(1, ALT.upstream))
    M.soft.opacity = 0.24 + 0.3 * w(ALT.executing)

    // 02 · planning: the link down on the leg, the columns on "three waves", the rows as the Issues are written
    toTable(alt >= 1 ? 1 : win(p, TRAVEL[1]))
    const colsF = win(p, story.plan.waves)
    const rowsF = clamp01((p - story.plan.rows[0]) / (story.plan.rows[1] - story.plan.rows[0]))
    table.set({ cols: Math.round(colsF * 10) / 10, rows: Math.floor(rowsF * TASKS.length + 1e-4) })
    table.show(win(p, [TRAVEL[1][0], TRAVEL[1][1] + 0.02]) * lift(1, ALT.planning))

    // 03 · executing: the rails drawn on the leg, then every lane from its own cues
    const railF = alt >= 2 ? 1 : win(p, TRAVEL[2])
    toGraph(railF)
    mainRail.grow(railF)
    dashes.forEach((d, i) => {
      d.visible = railF * DASH_N > i
    })
    gates.rails = railF
    const wE = W[ALT.executing]
    const base = 0.3 + wE * 0.65
    mainMat.opacity = 0.3 + 0.55 * w(ALT.executing, ALT.closing)
    intMat.opacity = 0.25 + 0.5 * wE
    let running = 0
    let waiting = 0
    lanes.forEach(({ t: tk, mats, tube: tb, node, fill, r1, r2 }) => {
      const s = laneState(tk, p)
      tb.grow(s.rise)
      const pop = smooth(clamp01((s.rise - 0.7) / 0.3))
      node.visible = pop > 0.02
      node.scale.setScalar(Math.max(0.001, pop))
      r1.visible = r2.visible = pop > 0.02 && !s.waiting
      // its state's colour: muted while it waits, the build colour while its agent works, success once it lands
      cMix.copy(s.waiting ? COL.muted : COL.build).lerp(COL.success, s.land)
      mats.lane.color.copy(cMix)
      mats.ring.color.copy(cMix)
      mats.lane.opacity = base * (s.waiting ? 0.6 : 1)
      mats.ring.opacity = base
      fill.visible = s.land > 0.02
      fill.scale.setScalar(Math.max(0.001, s.land))
      mats.fill.opacity = base
      // the two reviewers: muted until they read, then their verdicts; one sends #515 back once
      mats.r1.color.copy(COL.muted).lerp(COL.destructive, s.reject).lerp(COL.success, s.approve)
      mats.r2.color.copy(COL.muted).lerp(COL.success, Math.max(s.approve, s.reject))
      mats.r1.opacity = mats.r2.opacity = base * (0.55 + 0.45 * Math.max(s.approve, s.reject))
      if (s.rise > 0.5 && s.land < 0.5) {
        if (s.waiting) waiting++
        else running++
      }
      gates[`label_${tk.n}`] = tk.after ? pop * (1 - s.waiting) : pop
      gates[`wait_${tk.n}`] = pop * s.waiting
    })
    let onMain = 0
    waveMerges.forEach(({ wv, drop, pending, node }) => {
      const mf = win(p, wv.merge)
      drop.grow(mf)
      pending.visible = railF > 0.9 && mf < 0.98
      node.visible = mf > 0.6
      node.scale.setScalar(Math.max(0.001, smooth(clamp01((mf - 0.6) / 0.4))))
      if (mf >= 0.99) onMain += wv.tasks.length
    })
    exHead.set({ running, waiting, main: onMain })
    exHead.show(railF * lift(1, ALT.executing))
    M.mergedFill.opacity = 0.3 + 0.65 * w(ALT.executing, ALT.closing)
    M.paper.opacity = 0.3 + wE * 0.55

    // 04 · closing: one unit per closing line typed whole, never on a fraction of it
    const lastMerge = story.waves[story.waves.length - 1].merge
    toClosing(win(p, [lastMerge[1], TRAVEL[3][1]]))
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
    epicRow.set({ done: shown > EPIC_UNIT, flash: +flashOf(EPIC_UNIT, ms).toFixed(2) })
    epicRow.show(lc)
    trRow.set({ archived: shown > TRANCHE_UNIT, flash: +flashOf(TRANCHE_UNIT, ms).toFixed(2) })
    trRow.show(lc)
    const issuesFlash = flashOf(ISSUES_UNIT, ms)
    commitsOnMain.forEach((d) => {
      d.scale.setScalar(1 + issuesFlash * 0.6)
    })
    retro.set({ kept: shown > RECORD_UNIT, flash: +flashOf(RECORD_UNIT, ms).toFixed(2) })
    retro.show(lc)

    // 05 · report: the link down, the head, the figures one by one, where each wave's time goes
    toReport(win(p, [TRAVEL[4][0] - 0.01, TRAVEL[4][1]]))
    const rise = (pl, f, alts) => {
      pl.mesh.position.copy(pl.home ?? pl.mesh.position).add(tmp.set(0, -0.12 * (1 - f), 0))
      pl.show(f * alts)
    }
    reportHead.show(win(p, CUE_HEAD) * lift(1, ALT.report))
    stats.forEach((pl, i) => {
      rise(pl, win(p, CUE_TILE(i)), lift(1, ALT.report))
    })
    rise(time, win(p, CUE_TIME), lift(1, ALT.report))

    // 06 · self-improvement: the link down, the Improver's card, its findings one by one
    const learnF = win(p, CUE_LEARN)
    toLearn(learnF)
    learnFrame.visible = learnF > 0.002
    M.aiInk.opacity = learnF * (0.25 + 0.45 * w(ALT.improve))
    learnHead.show(learnF * lift(1, ALT.improve))
    findPanels.forEach((pl, i) => {
      rise(pl, win(p, CUE_FIND(i)), lift(1, ALT.improve))
    })

    // 07 · back upstream: the link down, the board, the new Epic lit, its Why beside it
    const nextF = win(p, CUE_NEXT)
    const newF = win(p, CUE_NEW)
    toNext(nextF)
    nextDash.show(nextF * lift(1, ALT.next))
    newCard.set({ name: story.proposal, icon: 'wrench', lit: +newF.toFixed(2), fresh: true })
    newCard.show(nextF * lift(1, ALT.next))
    whyCard.show(win(p, CUE_WHYCARD) * lift(1, ALT.next))
    M.flowFill.opacity = 0.25 + 0.4 * w(0, 1, 2, 3, 4, 5, 6)
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
