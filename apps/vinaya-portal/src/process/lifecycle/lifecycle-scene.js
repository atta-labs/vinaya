import * as THREE from 'three'
import { alphaAt, coverageMask, drawnMask } from '@/ui/lib/mask-canvas'
import { tokenHex } from '@/ui/lib/theme-color'
import { clamp01 } from '@/ui/lib/math'

/**
 * Complex work's life cycle as one scroll-driven descent: product Projects →
 * the milestone container of planned work → its tranches → one task's run and
 * merge → the closure (the milestone comes down onto the archive shelf and
 * closes, line by line) → the Log's stats and conclusions → the new Project they
 * produce, whose line runs back up to the product altitude.
 *
 * Grown from the attalabs portal's life-cycle scene
 * (`apps/vinaya-portal/web/src/app/(site)/life-cycle/_lib/lifecycle-scene.js`):
 * the token reader, the flat materials, the labels and the task's branch are
 * that scene's; the altitudes around them are this lab's. The look is the
 * portal's: flat diagram objects in space, thin lines, mono labels, shadcn
 * tokens read at runtime, a camera that only ever goes down.
 *
 * Inputs: `story` (what to draw: lifecycle/story.ts), `archive()` (0..1 through
 * the Archivist's closing lines) and `track`, whose rectangle encodes the walk's
 * progress. Every weight below is a pure function of that progress (and of
 * `archive`), so scrolling back replays the same frames; the camera only eases.
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

export function mountLifecycleScene({ canvas, labelLayer, track, labelClass, story, archive }) {
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
    aiInk: '--primary'
  }
  /* Live colour slots: the review and security nodes change state mid-run, so their
     materials are lerped between these every frame rather than pinned to one token. */
  const COL = {
    primary: new THREE.Color(C.primary),
    destructive: new THREE.Color(C.destructive),
    success: new THREE.Color(C.merged)
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
    aiInk: stroke('improverFrame', C.primary, 0.6)
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
  const mono = (px, w = 500) => `${w} ${Math.round(px)}px ${fontVar('--font-mono', 'ui-monospace, monospace')}`
  const sans = (px, w = 500) => `${w} ${Math.round(px)}px ${fontVar('--font-sans', 'ui-sans-serif, system-ui, sans-serif')}`
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
    ctx.font = mono(h * 0.5)
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
    ctx.fillText(s.target ?? story.target, 0.36 * u + tw + 0.26 * u, hh / 2)
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
    wrap(ctx, s.name, W - pad * 2, 2)
      .reverse()
      .forEach((l, i) => {
        ctx.fillText(l, pad, H - pad - 0.06 * u - i * 0.155 * u)
      })
  }

  const ROW_STATE = {
    open: ['open', 'mu'],
    flight: ['in flight', 'pr'],
    merged: ['merged', 'ok'],
    closed: ['closed', 'ok']
  }
  // one task of a part: its Issue number, its title, its state
  function drawRow(ctx, W, H, s, u, c) {
    const pad = 0.035 * u
    rrect(ctx, 2, 2, W - 4, H - 4, 0.025 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    if (s.flash) {
      ctx.fillStyle = rgba(c.ok, s.flash * 0.2)
      ctx.fill()
    }
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(s.st === 'flight' ? c.pr : c.fg, s.st === 'flight' ? 0.7 : 0.2)
    ctx.stroke()
    const yc = H / 2
    const [label, tone] = ROW_STATE[s.st]
    const chipW = chip(ctx, label, W - pad, yc, H * 0.56, c[tone], { filled: s.st === 'closed', flash: s.flash })
    ctx.textAlign = 'left'
    ctx.font = mono(0.05 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText(`#${s.n}`, pad, yc)
    const x = pad + 0.155 * u
    ctx.font = sans(0.064 * u, 500)
    ctx.fillStyle = rgba(c.fg, 0.95)
    ctx.fillText(ellipsize(ctx, s.title, W - pad - chipW - 0.03 * u - x), x, yc)
  }

  const TABLE_STATE = { planned: ['planned', 'mu'], active: ['active', 'pr'], archived: ['archived', 'ok'] }
  // the rest of a part's tasks, as one line: how many, and the state they share
  function drawMore(ctx, W, H, s, u, c) {
    const pad = 0.035 * u
    const [label, tone] = ROW_STATE[s.st]
    const chipW = chip(ctx, label, W - pad, H / 2, H * 0.56, c[tone], { filled: s.st === 'closed', flash: s.flash })
    ctx.textAlign = 'left'
    ctx.font = sans(0.064 * u, 600)
    ctx.fillStyle = rgba(c.mu, 0.97)
    ctx.fillText(`+ ${s.n} more tasks`, pad + 0.155 * u, H / 2)
    ctx.beginPath()
    ctx.moveTo(pad, 2)
    ctx.lineTo(W - pad - chipW - 0.03 * u, 2)
    ctx.lineWidth = 2
    ctx.setLineDash([6, 6])
    ctx.strokeStyle = rgba(c.fg, 0.15)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /* A part of the milestone: one card for its whole life. Its name across the top; in
     the milestone its body shows the marks of the Projects it is made from; once
     planned, the marks give way to its tasks (rows are panels of their own, in front)
     and its state shows on the right. */
  function drawTable(ctx, W, H, s, u, c) {
    const done = s.st === 'archived'
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
    const hh = HEAD * u
    const pad = 0.06 * u
    let cw = 0
    if (s.chip) {
      const [label, tone] = TABLE_STATE[s.st]
      cw = chip(ctx, label, W - pad, hh / 2 + 0.01 * u, hh * 0.5, c[tone], { filled: done, flash: s.flash }) + 0.03 * u
    }
    ctx.textAlign = 'left'
    ctx.font = sans(0.085 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(ellipsize(ctx, s.name, W - pad * 2 - cw), pad, hh / 2 + 0.01 * u)
    ctx.beginPath()
    ctx.moveTo(pad / 2, hh + 0.01 * u)
    ctx.lineTo(W - pad / 2, hh + 0.01 * u)
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(c.fg, 0.14)
    ctx.stroke()
    if (s.marks > 0) {
      const is = 0.24 * u
      const gap = 0.12 * u
      const n = s.icons.length
      let x = (W - (n * is + (n - 1) * gap)) / 2
      const y = hh + (H - hh - is) / 2
      for (const name of s.icons) {
        icon(ctx, name, x, y, is, c.pr, 0.95 * s.marks)
        x += is + gap
      }
    }
  }

  /* The milestone's bar, like the tracker's: a flag and its name on the left, its
     state on the right, a hairline under it. Done turns the flag and the state success. */
  function drawMilestone(ctx, W, H, s, u, c) {
    const pad = 0.1 * u
    const is = 0.17 * u
    if (s.flash) {
      rrect(ctx, 2, 2, W - 4, H - 6, 0.04 * u)
      ctx.fillStyle = rgba(c.ok, s.flash * 0.14)
      ctx.fill()
    }
    icon(ctx, 'flag', pad, (H - is) / 2, is, s.done ? c.ok : c.pr)
    ctx.textAlign = 'left'
    ctx.font = sans(0.11 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.96)
    ctx.fillText(s.name, pad + is + 0.06 * u, H / 2)
    chip(ctx, s.done ? 'done' : 'active', W - pad, H / 2, 0.1 * u, s.done ? c.ok : c.pr, { filled: s.done, flash: s.flash })
    ctx.beginPath()
    ctx.moveTo(0, H - 2)
    ctx.lineTo(W, H - 2)
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(c.fg, 0.14)
    ctx.stroke()
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
    ctx.fillText(s.kept ? 'what shipped and why' : 'when the milestone closes', W - 0.08 * u, H / 2)
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
    ctx.fillText('MILESTONE REPORT', pad, 0.14 * u)
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
      ctx.fillText(l, pad, 0.6 * u + i * 0.085 * u)
    })
  }

  // where the time goes: one bar, two parts, and what each part is
  function drawTime(ctx, W, H, s, u, c) {
    const pad = 0.12 * u
    rrect(ctx, 3, 3, W - 6, H - 6, 0.05 * u)
    ctx.fillStyle = rgba(c.card, 0.97)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = rgba(c.fg, 0.2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = mono(0.07 * u)
    ctx.fillStyle = rgba(c.mu, 0.95)
    ctx.fillText('WHERE THE TIME GOES', pad, 0.15 * u)
    const tones = [c.think, c.exec]
    const names = ['Developer writes the code', 'Reviewers check it']
    const by = 0.36 * u
    const bh = 0.09 * u
    let x = pad
    story.split.forEach((part, i) => {
      const w = ((W - pad * 2) * part.share) / 100
      rrect(ctx, x, by - bh / 2, Math.max(2, w - (i === 0 ? 4 : 0)), bh, bh / 2)
      ctx.fillStyle = rgba(tones[i % 2], 0.95)
      ctx.fill()
      x += w
    })
    let lx = pad
    ctx.font = sans(0.1 * u, 600)
    story.split.forEach((part, i) => {
      ctx.beginPath()
      ctx.arc(lx + 0.035 * u, 0.6 * u, 0.035 * u, 0, Math.PI * 2)
      ctx.fillStyle = rgba(tones[i % 2], 0.95)
      ctx.fill()
      const t = `${names[i] ?? part.label} · ${part.share}%`
      ctx.fillStyle = rgba(c.fg, 0.95)
      ctx.fillText(t, lx + 0.1 * u, 0.6 * u)
      lx += ctx.measureText(t).width + 0.35 * u
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
    ctx.font = sans(0.115 * u, 600)
    ctx.fillStyle = rgba(c.fg, 0.97)
    const change = wrap(ctx, s.change, W - pad * 2, 2)
    change.forEach((l, i) => {
      ctx.fillText(l, W / 2, H * 0.74 + (i - (change.length - 1) / 2) * 0.14 * u)
    })
  }

  // why the new Project is worth doing: the report's lines, as the tracker shows them
  function drawWhy(ctx, W, H, s, u, c) {
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
    ctx.fillText(`From the ${story.milestone} report`, pad, 0.34 * u)
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
  const TRAVEL = [null, [0.06, 0.12], [0.25, 0.3], [0.4, 0.45], [0.61, 0.655], [0.805, 0.835], [0.855, 0.88], [0.92, 0.935]]
  const CUE_FRAME = [0.035, 0.08] // the milestone container draws, before the leg brings it in
  const CUE_FLAG = [0.06, 0.095]
  const CUE_PART = (k) => [0.185 + 0.012 * k, 0.2 + 0.012 * k] // the parts, as the Architect names them
  const CUE_TABLES = [0.27, 0.31] // each part opens into its tranche…
  const CUE_ROW = (d) => [0.32 + 0.003 * d, 0.335 + 0.003 * d] // …and each part's tasks fill in as the Planner writes them
  const AT_FLIGHT = (k) => 0.41 + 0.0035 * k // waves of tasks: in flight, then merged
  const AT_MERGED = (k) => 0.44 + 0.0035 * k
  const TASK_P = [0.4, 0.6] // the one task's run: its drop from the tranche draws on the leg, then the run
  const CUE_HEAD = [0.81, 0.83] // the report: its head…
  const CUE_TILE = (k) => [0.82 + 0.007 * k, 0.835 + 0.007 * k] // …its figures…
  const CUE_TIME = [0.84, 0.855] // …where the time goes
  const CUE_LEARN = [0.85, 0.87] // the Improver reads the report…
  const CUE_FIND = (k) => [0.875 + 0.012 * k, 0.89 + 0.012 * k] // …one finding and its change at a time
  const CUE_NEXT = [0.905, 0.925] // back upstream: the tracker again, drawn before the camera leaves the Improver
  const CUE_WHYCARD = [0.945, 0.965] // the report that justifies the new Project
  const CUE_DROP_LINE = 0.64 // the merge's line reaches the milestone as the camera does
  const CUE_NEW = [0.94, 0.96] // the first change, approved: a new Project in the tracker

  const BOX_X = 0.1
  // the product dashboard's frame, in world units: wide and tall enough that a tile reads at a glance
  const DASH = { w: 4.5, h: 2.55, head: 0.42, side: 0.55 }
  const CUE_LIT = (k) => [0.004 + 0.006 * k, 0.014 + 0.006 * k] // each Project lights as it joins the deploy
  // columns shared by the milestone's code projects and its tranches
  const colX = (i, n) => 0.1 + (i - (n - 1) / 2) * 1.95
  const colX3 = (i) => 0.1 + (i - 1) * 1.4

  /* ── 01 · PRODUCT — the tracker's dashboard, the deploy's Projects in it ──── */
  const PRODUCT_Y = 6.75
  const DASH_W = DASH.w
  const DASH_H = DASH.h
  const productG = new THREE.Group()
  productG.name = 'product'
  graph.add(productG)
  const dash = panel('dashboard', DASH_W, DASH_H, drawDashboard, 400)
  dash.set({})
  dash.mesh.position.set(BOX_X, PRODUCT_Y, 0)
  productG.add(dash.mesh)
  // the tiles: three across, two down, in the dashboard's content area
  const TILE_GAP = 0.14
  const gridX0 = BOX_X - DASH_W / 2 + DASH.side + 0.16
  const gridW = DASH_W - DASH.side - 0.32
  const gridY0 = PRODUCT_Y + DASH_H / 2 - DASH.head - 0.16
  const gridH = DASH_H - DASH.head - 0.32
  const TILE_W = (gridW - TILE_GAP * 2) / 3
  const TILE_H = (gridH - TILE_GAP) / 2
  const products = story.projects.slice(0, 6).map((pr, i) => {
    const pl = panel(`project_${i}`, TILE_W, TILE_H, drawProduct)
    pl.mesh.position.set(gridX0 + TILE_W / 2 + (i % 3) * (TILE_W + TILE_GAP), gridY0 - TILE_H / 2 - Math.floor(i / 3) * (TILE_H + TILE_GAP), 0.01)
    pl.mesh.renderOrder = 2
    productG.add(pl.mesh)
    return { pl, pr }
  })

  /* ── 02 · MILESTONE — a container like the tracker's dashboard: its bar (flag, name,
     state) across the top, its parts right under it, nothing else ───────────── */
  const NP = story.tranches.length
  const PART_W = 1.3
  const colP = (i) => 0.1 + (i - (NP - 1) / 2) * 1.4
  const HEAD = 0.2
  const ROW_W = 1.2
  const ROW_H = 0.16
  const ROW_STEP = 0.18
  // a card shows its first rows and then how many more: fifty tasks do not fit one card
  const ROWS_SHOWN = 7
  const MAX_ROWS = Math.min(ROWS_SHOWN + 1, Math.max(...story.tranches.map((tr) => tr.tasks.length)))
  const TABLE_H = HEAD + 0.06 + MAX_ROWS * ROW_STEP
  const BAR_H = 0.34
  const RETRO_H = 0.36
  const BOX_TOP = 4.42
  const TABLE_TOP = BOX_TOP - BAR_H - 0.12
  const BOX = { x: 0.1, top: BOX_TOP, bottom: TABLE_TOP - TABLE_H - 0.12, w: 4.4 }
  const rowY = (ri) => TABLE_TOP - HEAD - 0.04 - ROW_H / 2 - ri * ROW_STEP
  /* Its lines in from each product Project: fine, vertical, one per Project, each
     standing over the part it goes into and stopping at the container's edge, with a
     dot at each end. They draw as the camera comes down, the tip just inside the
     frame, and reach the milestone after it is there. */
  const flowX = []
  story.tranches.forEach((tr, i) => {
    tr.projects.forEach((k, j) => {
      flowX[k] = colP(i) + (j - (tr.projects.length - 1) / 2) * 0.28
    })
  })
  const FLOW_TOP = PRODUCT_Y - DASH_H / 2
  const FLOW_END = BOX.top
  const flows = products.map((_, k) => {
    const x = flowX[k] ?? BOX.x
    const line = growTube([V(x, FLOW_TOP, 0), V(x, FLOW_END, 0)], 0.0032, M.flowFill, `flow_${k}`, 60)
    graph.add(line)
    return { line }
  })

  /* ── 03 · TRANCHES — each part opens into its tranche, its tasks as rows ──── */
  // the data both milestones draw: every task, every part
  const tasks = story.tranches.flatMap((tr, ti) => tr.tasks.map((t, ri) => ({ ...t, ti, ri })))
  tasks.forEach((t, k) => {
    t.k = k
    t.d = t.ti * ROWS_SHOWN + t.ri // its slot among the rows drawn
  })
  const shownTasks = tasks.filter((t) => t.ri < ROWS_SHOWN)
  const partsData = story.tranches.map((tr, ti) => ({
    id: tr.id,
    name: tr.part,
    // the products its features touch, each once
    icons: [...new Set(tr.projects.flatMap((k) => story.projects[k]?.products ?? []))],
    tasks: tasks.filter((t) => t.ti === ti)
  }))

  /* One milestone, drawn whole: its container, its bar, a card per part, a row per
     task. Built twice — once where it is thought and planned, once at the closure
     altitude, where the camera finds it waiting and watches it close. */
  function buildMilestone(name, y, retro = false) {
    const g = new THREE.Group()
    g.name = name
    g.position.y = y
    graph.add(g)
    const bottom = retro ? BOX.bottom - RETRO_H - 0.12 : BOX.bottom
    const frame = path(roundRectStroke(BOX.w, BOX.top - bottom, 0.12), M.frameInk, `${name}Container`)
    frame.position.set(BOX.x, (BOX.top + bottom) / 2, -0.01)
    g.add(frame)
    const bar = new THREE.Group()
    bar.position.set(BOX.x, BOX.top - BAR_H / 2 - 0.03, 0)
    g.add(bar)
    const banner = panel(`${name}Bar`, BOX.w - 0.14, BAR_H, drawMilestone)
    banner.mesh.position.set(0, 0, 0.002)
    bar.add(banner.mesh)
    const rows = shownTasks.map((t) => {
      const pl = panel(`${name}Task_${t.n}`, ROW_W, ROW_H, drawRow)
      pl.mesh.position.set(colP(t.ti), rowY(t.ri), 0.006)
      // drawn after their card's fill, so the rows are never seen through it
      pl.mesh.renderOrder = 2
      g.add(pl.mesh)
      return pl
    })
    // the rest of each part, as one line: how many more tasks it holds
    const more = partsData.map((pd, ti) => {
      if (pd.tasks.length <= ROWS_SHOWN) return null
      const pl = panel(`${name}More_${ti}`, ROW_W, ROW_H, drawMore)
      pl.mesh.position.set(colP(ti), rowY(ROWS_SHOWN), 0.006)
      pl.mesh.renderOrder = 2
      g.add(pl.mesh)
      return pl
    })
    const cards = partsData.map((_, ti) => {
      const pl = panel(`${name}Part_${ti}`, PART_W, TABLE_H, drawTable)
      pl.mesh.position.set(colP(ti), TABLE_TOP - TABLE_H / 2, 0)
      pl.mesh.renderOrder = 1
      g.add(pl.mesh)
      return pl
    })
    let retroPl = null
    if (retro) {
      retroPl = panel(`${name}Retro`, BOX.w - 0.3, RETRO_H, drawRetro)
      retroPl.set({})
      retroPl.mesh.position.set(BOX.x, BOX.bottom - RETRO_H / 2 - 0.02, 0.004)
      retroPl.mesh.renderOrder = 2
      g.add(retroPl.mesh)
    }
    return { g, frame, frameN: frame.geometry.attributes.position.count, bar, banner, rows, more, cards, retro: retroPl }
  }
  const plan = buildMilestone('milestone', 0)
  const T1 = { x: colP(0), bottom: TABLE_TOP - TABLE_H }

  /* ── 04 · TASK — a branch off the milestone: six stages, merged green ───── */
  const S = 0.76
  const BR = 0.5
  const LANE_A = 0.9
  const LANE_B = 0.1 // the task's lane, plus one above and one below
  const Z = 0.3
  const GIT_Y = 0.9 // the branch hangs this far up, close under its tranche
  const GIT_X = -1.12 // the branch sits left, so its Merged chip stands over the milestone below
  const LX = (T1.x - GIT_X) / S
  const LIVE_BOT = (T1.bottom - GIT_Y) / S
  const gitG = new THREE.Group()
  gitG.name = 'taskLifeCycle'
  gitG.scale.setScalar(S)
  gitG.position.y = GIT_Y
  gitG.position.x = GIT_X
  graph.add(gitG)

  /* The lane is constructed, not interpolated through sparse control points: a dead
     straight drop out from under the tranche's first row, one quarter-circle elbow,
     then a straight run through every commit to the merge. */
  function lanePath() {
    const z0 = 0.04
    const r = 0.26
    const yC = BR + r
    const pts = []
    for (let i = 0; i <= 26; i++) {
      const f = i / 26
      pts.push(V(LX, LIVE_BOT + (yC - LIVE_BOT) * f, z0 + (Z - z0) * smooth(f)))
    }
    for (let i = 1; i <= 16; i++) {
      const a = ((i / 16) * Math.PI) / 2
      pts.push(V(LX + r * (1 - Math.cos(a)), BR + r * (1 - Math.sin(a)), Z))
    }
    const xs = LX + r
    const xe = 3.5 // the lane runs right into the Merged chip (its left edge: 3.98 - 1.04 / 2)
    for (let i = 1; i <= 40; i++) pts.push(V(xs + (xe - xs) * (i / 40), BR, Z))
    return pts
  }
  const lane = new THREE.CatmullRomCurve3(lanePath(), false, 'centripetal')
  const laneMesh = tubeC(lane, 320, 0.0105, M.primaryFill, 'taskLane')
  gitG.add(laneMesh)
  const LANE_IDX = laneMesh.geometry.index.count
  // TubeGeometry walks the curve by arc length, so a draw range IS a distance along it
  const laneScan = lane.getSpacedPoints(500)
  const fracAtX = (x) => {
    for (let i = 0; i < laneScan.length; i++) if (laneScan[i].x >= x - 1e-6 && laneScan[i].y <= BR + 0.001) return i / (laneScan.length - 1)
    return 1
  }

  // review above, security below — the two that run at the same time: smoothstep
  // rise, long flat run, smoothstep return — the shape a branch draws in a git graph
  function spurPoints(y, x0, x1, rise) {
    const pts = []
    const n = 72
    for (let i = 0; i <= n; i++) {
      const x = x0 + (x1 - x0) * (i / n)
      const f = x < x0 + rise ? smooth((x - x0) / rise) : x > x1 - rise ? smooth((x1 - x) / rise) : 1
      pts.push(V(x, BR + (y - BR) * f, Z))
    }
    return pts
  }
  const reviewSpur = tubeC(new THREE.CatmullRomCurve3(spurPoints(LANE_A, 0.92, 2.08, 0.18), false, 'centripetal'), 160, 0.009, M.reviewFill, 'reviewSpur')
  const securitySpur = tubeC(new THREE.CatmullRomCurve3(spurPoints(LANE_B, 1.28, 2.46, 0.18), false, 'centripetal'), 160, 0.009, M.securityFill, 'securitySpur')
  gitG.add(reviewSpur, securitySpur)
  const SPUR_IDX = reviewSpur.geometry.index.count
  const SEC_IDX = securitySpur.geometry.index.count

  const STAGES = [
    { id: 'brief', p: V(0.1, BR, Z), ly: 0.17 },
    { id: 'develop', p: V(0.92, BR, Z), ly: -0.2 },
    { id: 'review', p: V(1.5, LANE_A, Z), ly: 0.17 },
    { id: 'security', p: V(1.87, LANE_B, Z), ly: -0.2 },
    { id: 'verify', p: V(2.75, BR, Z), ly: 0.17 }
  ]
  const commitRing = circleStroke(0.062, 28)
  const STAGE_MAT = { review: ['reviewFill', 'reviewStroke'], security: ['securityFill', 'securityStroke'] }
  /* The two checks wear their marks: code review an eye, security a shield, each in a
     ring that takes the check's colour (running, sent back, green). The mark is drawn
     white into a texture and tinted by its material, so the colour follows every frame. */
  const CHECK_ICON = { review: 'eye', security: 'shield' }
  const CHECK_R = 0.13
  const checkRing = circleStroke(CHECK_R, 40)
  const checkMarks = {}
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
  const commits = STAGES.map((s) => {
    const g = new THREE.Group()
    g.name = `commit_${s.id}`
    g.position.copy(s.p)
    const [f, st] = STAGE_MAT[s.id] || ['primaryFill', 'primaryStroke']
    if (CHECK_ICON[s.id]) {
      // a ring on the background colour, so the lane never shows through, the mark inside
      g.add(dot(CHECK_R, M.paper, 'checkFace'))
      g.add(path(checkRing, M[st], 'checkRing'))
      const mat = new THREE.MeshBasicMaterial({ map: markTexture(CHECK_ICON[s.id]), transparent: true, depthWrite: false, side: THREE.DoubleSide })
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(CHECK_R * 1.15, CHECK_R * 1.15), mat)
      mark.position.z = 0.002
      mark.name = `${s.id}Mark`
      g.add(mark)
      checkMarks[s.id] = mat
    } else {
      g.add(dot(0.062, M[f], 'commitDot'))
      g.add(path(commitRing, M[st], 'commitRing'))
    }
    gitG.add(g)
    return g
  })

  // the one pull request the whole branch lives on
  const prG = new THREE.Group()
  prG.name = 'pullRequest'
  gitG.add(prG)
  prG.add(path(geoFrom([V(0.1, LANE_B - 0.26, Z), V(0.1, LANE_B - 0.34, Z), V(2.75, LANE_B - 0.34, Z), V(2.75, LANE_B - 0.26, Z)]), M.soft, 'prBracket'))

  const mergeCommit = new THREE.Group()
  mergeCommit.name = 'mergeCommit'
  // a touch in front of the lane, so the tube's flat end cap is covered by the disc
  mergeCommit.position.set(3.22, BR, Z + 0.014)
  mergeCommit.add(dot(0.085, M.mergedFill, 'mergeDot'))
  mergeCommit.add(path(circleStroke(0.085, 32), M.mergedStroke, 'mergeRing'))
  gitG.add(mergeCommit)

  /* The merge resolves into the chip the product shows in its tables: a rounded
     outline, a check, and the word beside it. */
  const badge = new THREE.Group()
  badge.name = 'mergedChip'
  badge.position.set(3.98, BR, Z)
  gitG.add(badge)
  const CHIP_W = 1.04
  const CHIP_H = 0.38
  const CHK_X = -0.3
  badge.add(plane(CHIP_W - 0.03, CHIP_H - 0.03, M.paper, 0, 0, -0.004, 'chipFace'))
  badge.add(path(roundRectStroke(CHIP_W, CHIP_H, 0.105), M.mergedStroke, 'chipEdge'))
  badge.add(tube([V(CHK_X - 0.058, 0.004, 0), V(CHK_X - 0.014, -0.05, 0)], 0.013, M.mergedFill, 'checkShort'))
  badge.add(tube([V(CHK_X - 0.014, -0.05, 0), V(CHK_X + 0.074, 0.064, 0)], 0.013, M.mergedFill, 'checkLong'))

  const pulse = dot(0.028, M.pulseFill, 'inFlight')
  gitG.add(pulse)
  // the verdict coming back: a red dot travelling review → develop
  const reject = dot(0.03, M.rejectFill, 'changesRequested')
  reject.visible = false
  gitG.add(reject)

  /* The run the task makes, as a function of scroll (TASK_P): review sends it back
     once — nothing past the two spurs is drawn until it comes back green, so verify
     and merge cannot appear before the work has earned them. Windows are fractions
     of one run. */
  const CUE = {
    brief: [0.05, 0.11],
    develop: [0.17, 0.23],
    spurs: [0.24, 0.36],
    spursB: [0.27, 0.4],
    review: [0.33, 0.39],
    security: [0.36, 0.42],
    cleared: [0.42, 0.49],
    reject: [0.44, 0.5],
    rejectRun: [0.47, 0.56],
    refix: [0.56, 0.62],
    approve: [0.64, 0.7],
    verify: [0.74, 0.79],
    mergeDot: [0.81, 0.845],
    chip: [0.83, 0.87]
  }
  const at = (q, w) => smooth(clamp01((q - w[0]) / (w[1] - w[0])))
  // the drop from the tranche is drawn first, then the run; the last stretch holds
  const LANE_KEYS = [
    [0, 0],
    [0.11, fracAtX(0.1)],
    [0.23, fracAtX(0.92)],
    [0.36, fracAtX(2.46)],
    [0.7, fracAtX(2.46)],
    [0.78, fracAtX(2.75)],
    [0.84, 1],
    [1, 1]
  ]
  function laneFrac(q) {
    for (let i = 1; i < LANE_KEYS.length; i++) {
      if (q <= LANE_KEYS[i][0]) {
        const a = LANE_KEYS[i - 1]
        const b = LANE_KEYS[i]
        return a[1] + (b[1] - a[1]) * smooth(clamp01((q - a[0]) / (b[0] - a[0])))
      }
    }
    return 1
  }
  const reviewCol = new THREE.Color()
  const secCol = new THREE.Color()
  const gates = {}
  let lastLaneF = 0

  /* ── 05 · CLOSURE — the milestone, closing ─────────────────────────────────
     The camera just keeps going down and finds the milestone there, whole, on the
     altitude: it closes one unit per closing line typed on the left, in the log's
     order — each part's tasks closed, the part archived, the milestone done, the
     retrospective kept, as a row of its own. */
  const CLOSE_TOP = -1.0
  const DROP = BOX.top - CLOSE_TOP
  const closing = buildMilestone('milestoneClosing', -DROP, true)
  const CLOSE_BOTTOM = BOX.bottom - DROP - RETRO_H - 0.12

  // the closing order, one unit per typed line: each tranche's issues, then the
  // tranche; then the milestone; then the record
  const UNITS = ['divider'] // the log's '── the milestone closes ──' line, then one unit per line
  story.tranches.forEach((tr, ti) => {
    // a part's Issues close together, on one line, then the part archives on the next
    const tasksUnit = UNITS.length
    partsData[ti].tasks.forEach((t) => {
      t.unit = tasksUnit
    })
    UNITS.push(partsData[ti].tasks)
    partsData[ti].unit = UNITS.length
    UNITS.push(partsData[ti])
  })
  const MILESTONE_UNIT = UNITS.length
  UNITS.push('milestone')
  const RECORD_UNIT = UNITS.length
  UNITS.push('record')
  const UN = UNITS.length
  const closedAt = UNITS.map(() => -1) // when each unit closed, for its one flash
  let uEased = 0
  let uShown = -1
  let frameDone = false
  const FLASH_MS = 900

  // a fine vertical link between two altitudes, grown by a share
  function link(x, y0, y1, name, z0 = 0) {
    const line = growTube([V(x, y0, z0), V(x, y1, 0)], 0.0032, M.flowFill, name, 40)
    graph.add(line)
    return (f) => {
      line.grow(f)
    }
  }
  const REPORT_W = BOX.w

  /* ── 06 · REPORT — what the Log says about the milestone, as a report ──────── */
  const REPORT_TOP = CLOSE_BOTTOM - 0.7
  const HEAD_H = 0.62
  const STAT_H = 1.0
  const TIME_H = 0.8
  const GAP = 0.1
  const STAT_W = (REPORT_W - GAP * 3) / 4
  const reportHead = panel('reportHead', REPORT_W, HEAD_H, drawReportHead)
  reportHead.set({ title: story.target, done: tasks.length, total: tasks.length })
  reportHead.mesh.position.set(BOX.x, REPORT_TOP - HEAD_H / 2, 0)
  graph.add(reportHead.mesh)
  const statsY = REPORT_TOP - HEAD_H - GAP - STAT_H / 2
  const stats = story.stats.slice(0, 4).map((st, i) => {
    const pl = panel(`stat_${i}`, STAT_W, STAT_H, drawStat)
    pl.set(st)
    pl.home = V(BOX.x - REPORT_W / 2 + STAT_W / 2 + i * (STAT_W + GAP), statsY, 0)
    graph.add(pl.mesh)
    return pl
  })
  const time = panel('timeSplit', REPORT_W, TIME_H, drawTime)
  time.set({})
  time.home = V(BOX.x, statsY - STAT_H / 2 - GAP - TIME_H / 2, 0)
  graph.add(time.mesh)
  const REPORT_BOTTOM = time.home.y - TIME_H / 2

  /* ── 07 · SELF-IMPROVEMENT — the Improver reads the report, says what to change ── */
  const LEARN_TOP = REPORT_BOTTOM - 0.7
  const LEARN_HEAD = 0.46
  const FIND_H = 1.2
  const FIND_GAP = 0.12
  const findings = story.findings.slice(0, 3)
  const FIND_W = (REPORT_W - 0.24 - FIND_GAP * (findings.length - 1)) / findings.length
  const LEARN_BOTTOM = LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H - 0.12
  const learnFrame = path(roundRectStroke(REPORT_W, LEARN_TOP - LEARN_BOTTOM, 0.12), M.aiInk, 'operatorFrame')
  learnFrame.position.set(BOX.x, (LEARN_TOP + LEARN_BOTTOM) / 2, -0.01)
  graph.add(learnFrame)
  const learnHead = panel('operatorHead', REPORT_W - 0.08, LEARN_HEAD, drawImproverHead)
  learnHead.set({ count: story.findings.length })
  learnHead.mesh.position.set(BOX.x, LEARN_TOP - LEARN_HEAD / 2 - 0.03, 0.002)
  graph.add(learnHead.mesh)
  const findPanels = findings.map((f, i) => {
    const pl = panel(`finding_${i}`, FIND_W, FIND_H, drawFinding)
    pl.set(f)
    pl.home = V(BOX.x - REPORT_W / 2 + 0.12 + FIND_W / 2 + i * (FIND_W + FIND_GAP), LEARN_TOP - LEARN_HEAD - 0.06 - FIND_H / 2, 0)
    graph.add(pl.mesh)
    return pl
  })
  const toLearn = link(BOX.x, REPORT_BOTTOM, LEARN_TOP, 'toImprover')
  // from the merge straight down into the milestone it lands in, at the closure altitude
  graph.updateMatrixWorld(true)
  const MERGE_AT = gitG.localToWorld(V(3.98, BR - CHIP_H / 2, Z))
  const toClosing = link(MERGE_AT.x, MERGE_AT.y, CLOSE_TOP, 'mergeToMilestone', MERGE_AT.z)

  /* ── 08 · BACK UPSTREAM — the tracker again: the new Project and its report ──── */
  const NEXT_Y = LEARN_BOTTOM - 0.7 - DASH_H / 2
  const nextDash = panel('nextDashboard', DASH_W, DASH_H, drawDashboard, 400)
  nextDash.set({ target: 'From the Log' })
  nextDash.mesh.position.set(BOX.x, NEXT_Y, 0)
  graph.add(nextDash.mesh)
  const contentX0 = BOX.x - DASH_W / 2 + DASH.side + 0.16
  const contentW = DASH_W - DASH.side - 0.32
  const contentH = DASH_H - DASH.head - 0.32
  const contentY = NEXT_Y - DASH.head / 2
  const first = story.proposals[0]
  const CARD_W = contentW * 0.44
  const newCard = panel('newProject', CARD_W, contentH, drawProduct)
  newCard.set({ name: first?.title ?? '', icon: 'wrench', lit: 0, fresh: true })
  newCard.mesh.position.set(contentX0 + CARD_W / 2, contentY, 0.01)
  newCard.mesh.renderOrder = 2
  graph.add(newCard.mesh)
  const WHY_W = contentW - CARD_W - 0.14
  const whyCard = panel('whyCard', WHY_W, contentH, drawWhy)
  whyCard.set({})
  whyCard.mesh.position.set(contentX0 + CARD_W + 0.14 + WHY_W / 2, contentY, 0.01)
  whyCard.mesh.renderOrder = 2
  graph.add(whyCard.mesh)
  const toNext = link(BOX.x, LEARN_BOTTOM, NEXT_Y + DASH_H / 2, 'toTracker')

  /* ── labels: DOM spans placed by projection, one altitude each ─────────── */
  const ALT = { product: 0, milestone: 1, tranches: 2, task: 3, closure: 4, report: 5, improve: 6, next: 7 }
  const anchor = (parent, x, y, z = 0) => {
    const o = new THREE.Object3D()
    o.position.set(x, y, z)
    parent.add(o)
    return o
  }
  const LABELS = [
    ...STAGES.map((s, i) => ({ text: s.id, obj: commits[i], off: V(i === 0 ? 0.08 : 0, s.ly, 0), alt: [3], tone: 'ink', gate: s.id, align: i === 0 ? 'left' : undefined })),
    { text: 'one pull request', obj: prG, off: V(1.42, LANE_B - 0.5, Z), offNarrow: V(1.42, LANE_B - 0.66, Z), alt: [3], tone: 'muted', local: true, gate: 'develop' },
    { text: 'Merged', obj: badge, off: V(0.14, 0.005, 0), alt: [3], tone: 'merged', cls: 'chip', gate: 'chip' },
    { text: `approved · a new ${story.tracker.unit} in ${story.tracker.name}`, obj: anchor(graph, BOX.x, NEXT_Y - DASH_H / 2 - 0.12), alt: [7], tone: 'merged', gate: 'new' },
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
  const LEFT = BOX.x - BOX.w / 2 - 0.08
  const RIGHT = BOX.x + BOX.w / 2 + 0.08
  graph.updateMatrixWorld(true)
  const taskBox = (x0, x1 = 4.85) => {
    const a = gitG.localToWorld(V(x0, LANE_B - 0.8, Z))
    // past the Merged chip's right edge, so the mask's fade never touches it
    const b = gitG.localToWorld(V(x1, LANE_A + 0.3, Z))
    return [a.x, b.x, a.y, b.y]
  }
  const BOXES = [
    [BOX.x - DASH_W / 2 - 0.08, BOX.x + DASH_W / 2 + 0.08, PRODUCT_Y - DASH_H / 2 - 0.08, PRODUCT_Y + DASH_H / 2 + 0.08],
    [LEFT, RIGHT, BOX.bottom - 0.06, BOX.top + 0.08],
    [LEFT, RIGHT, T1.bottom - 0.5, TABLE_TOP + 0.3],
    null, // the task: fitted to its branch, wide or narrow
    [LEFT, RIGHT, CLOSE_BOTTOM - 0.08, CLOSE_TOP + 0.08],
    [LEFT, RIGHT, REPORT_BOTTOM - 0.08, REPORT_TOP + 0.08],
    [LEFT, RIGHT, LEARN_BOTTOM - 0.08, LEARN_TOP + 0.08],
    [BOX.x - DASH_W / 2 - 0.08, BOX.x + DASH_W / 2 + 0.08, NEXT_Y - DASH_H / 2 - 0.28, NEXT_Y + DASH_H / 2 + 0.08]
  ]
  // framed from just before develop to the Merged chip: the run, big, the merge in full view
  const TASK_WIDE = taskBox(0.6)
  const TASK_NARROW = taskBox(0.8)
  // as the run lands, the camera pans right until the Merged chip is centred: the merge is the point
  const MERGE_HALF = 2.5
  const TASK_MERGE = taskBox(3.98 - MERGE_HALF, 3.98 + MERGE_HALF)
  let taskPan = 0
  const taskBoxNow = []
  const narrow = () => camera.aspect < 0.8
  const boxOf = (i) => {
    if (i !== ALT.task) return BOXES[i]
    const from = narrow() ? TASK_NARROW : TASK_WIDE
    for (let k = 0; k < 4; k++) taskBoxNow[k] = from[k] + (TASK_MERGE[k] - from[k]) * taskPan
    return taskBoxNow
  }
  function fit(i, out) {
    const b = boxOf(i)
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
  const archiveOf = (v) => (pinned === undefined ? clamp01(archive?.() ?? 0) : clamp01((v - 0.655) / 0.145))
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
     snaps to the altitude that step ends on, fitted whole, every label on; nothing
     reads time or the pointer. */
  function fitComposed(v) {
    const a = Math.round(altitudeAt(v))
    fit(a, fa)
    cTgt.copy(fa.c)
    cPos.copy(cTgt).addScaledVector(DIR, fa.d)
    return fa.d
  }

  // what each task shows at p: a pure function of p and of the closing units typed whole
  function rowState(t, v, whole) {
    if (whole > t.unit) return 'closed'
    if (v >= AT_MERGED(t.k)) return 'merged'
    if (v >= AT_FLIGHT(t.k)) return 'flight'
    return 'open'
  }
  const flashOf = (i, ms) => (closedAt[i] < 0 ? 0 : clamp01(1 - (ms - closedAt[i]) / FLASH_MS))
  const tmp = new THREE.Vector3()
  const proj = new THREE.Vector3()

  if (document.fonts)
    document.fonts.ready.then(() => {
      if (!disposed)
        panels.forEach((pl) => {
          pl.redraw()
        })
    })

  function frame(ms) {
    const t = ms / 1000
    /* The app shell scrolls a nested container, never the document: progress is the
       stand-in track's offset against the canvas. */
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
    // the pan to the merge: a function of the task's own run, so it replays exactly on the way back
    taskPan = reduced ? 1 : smooth(clamp01((clamp01((p - TASK_P[0]) / (TASK_P[1] - TASK_P[0])) * 0.9 - 0.62) / 0.22))
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
    const W = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (reduced ? (Math.round(alt) === i ? 1 : 0.3) : altWeight(i, p)))
    const w = (...ix) => Math.max(...ix.map((i) => W[i]))
    const lift = (o, ...ix) => o * (0.3 + 0.7 * w(...ix))

    // 01 · product
    dash.show(lift(1, 0))
    products.forEach(({ pl, pr }, k) => {
      pl.set({ name: pr.name, icons: pr.products, lit: +win(p, CUE_LIT(k)).toFixed(2) })
      pl.show(lift(1, 0))
    })
    M.soft.opacity = 0.24 + 0.3 * w(0, 3)

    // 02 · milestone: lines in, the frame drawn round, the flag, the items one by one
    // the tip leads the camera down, a little above the frame's foot, never past its part
    const tipY = reduced ? -1e9 : cTgt.y - 0.7 * dist * TAN
    flows.forEach((f) => {
      // nothing before the reader scrolls on: the lines start with the camera's leg down,
      // and the tip never runs ahead of the frame
      const leg = win(p, TRAVEL[1])
      const g = alt >= 1 ? 1 : Math.min(leg, clamp01((FLOW_TOP - tipY) / (FLOW_TOP - FLOW_END)))
      f.line.grow(g)
    })
    const frameF = win(p, CUE_FRAME)
    const flagF = win(p, CUE_FLAG)
    // a unit closes once its line has typed whole, never on a fraction of it
    const shown = Math.floor(uEased + 1e-4)
    const msDone = shown > MILESTONE_UNIT
    if (shown !== uShown) {
      // a unit closing now flashes once; one jumped over (a fast scroll) closes quietly
      for (let i = 0; i < UN; i++) {
        if (i < shown && closedAt[i] < 0) closedAt[i] = shown - uShown === 1 && !reduced ? ms : ms - FLASH_MS
        if (i >= shown) closedAt[i] = -1
      }
      uShown = shown
    }
    M.frameInk.opacity = msDone ? 0.75 : 0.25 + 0.35 * w(1, 2, 4)
    // a done milestone's container turns success; read the token only when it flips
    if (msDone !== frameDone) {
      frameDone = msDone
      TOKEN_OF.frameInk = msDone ? '--success' : '--foreground'
      M.frameInk.color.setHex(tokenHex(TOKEN_OF.frameInk))
    }
    const tablesF = win(p, CUE_TABLES)

    /* both milestones, from one function of p: `upper` is the one thought and planned
       (drawn in, filled part by part), the lower one waits whole at the closure altitude */
    const drawMilestoneAt = (m, upper) => {
      const fF = upper ? frameF : 1
      m.frame.geometry.setDrawRange(0, Math.max(2, Math.round(m.frameN * fF)))
      m.frame.visible = fF > 0.002
      const lit = upper ? lift(1, 1, 2) : lift(1, 4)
      m.banner.set({ name: story.milestone, done: !upper && msDone, flash: upper ? 0 : +flashOf(MILESTONE_UNIT, ms).toFixed(2) })
      m.banner.show((upper ? flagF : 1) * lit)
      shownTasks.forEach((tk, i) => {
        const st = rowState(tk, p, upper ? 0 : shown)
        m.rows[i].set({ n: tk.n, title: tk.title, st, flash: upper ? 0 : +flashOf(tk.unit, ms).toFixed(2) })
        m.rows[i].show((upper ? win(p, CUE_ROW(tk.d)) : 1) * lit)
      })
      m.more.forEach((pl, i) => {
        if (!pl) return
        const pd = partsData[i]
        const last = pd.tasks[pd.tasks.length - 1]
        pl.set({ n: pd.tasks.length - ROWS_SHOWN, st: rowState(last, p, upper ? 0 : shown), flash: upper ? 0 : +flashOf(last.unit, ms).toFixed(2) })
        pl.show((upper ? win(p, CUE_ROW(i * ROWS_SHOWN + ROWS_SHOWN)) : 1) * lit)
      })
      partsData.forEach((pd, i) => {
        const archived = !upper && shown > pd.unit
        const active = p >= AT_FLIGHT(pd.tasks[0].k)
        const tf = upper ? tablesF : 1
        m.cards[i].set({
          name: pd.name,
          icons: pd.icons,
          // the marks give way to the rows, in tenths so the card repaints only a few times
          marks: Math.round((1 - tf) * 10) / 10,
          chip: tf > 0.5,
          st: archived ? 'archived' : active ? 'active' : 'planned',
          flash: upper ? 0 : +flashOf(pd.unit, ms).toFixed(2)
        })
        m.cards[i].show((upper ? win(p, CUE_PART(i)) : 1) * lit)
      })
    }
    drawMilestoneAt(plan, true)
    drawMilestoneAt(closing, false)

    // 04 · task: its own run, drawn by scroll through to the Merged chip
    const q = clamp01((p - TASK_P[0]) / (TASK_P[1] - TASK_P[0])) * 0.9
    const wK = W[3]
    const laneF = laneFrac(q)
    laneMesh.visible = q > 0.001
    laneMesh.geometry.setDrawRange(0, Math.max(6, Math.round(LANE_IDX * laneF)))
    reviewSpur.visible = at(q, CUE.spurs) > 0.002
    securitySpur.visible = at(q, CUE.spursB) > 0.002
    reviewSpur.geometry.setDrawRange(0, Math.max(6, Math.round(SPUR_IDX * at(q, CUE.spurs))))
    securitySpur.geometry.setDrawRange(0, Math.max(6, Math.round(SEC_IDX * at(q, CUE.spursB))))
    const rejectW = at(q, CUE.reject) * (1 - at(q, CUE.refix))
    const approveW = at(q, CUE.approve)
    reviewCol.copy(COL.primary).lerp(COL.destructive, rejectW).lerp(COL.success, approveW)
    M.reviewFill.color.copy(reviewCol)
    M.reviewStroke.color.copy(reviewCol)
    secCol.copy(COL.primary).lerp(COL.success, at(q, CUE.cleared))
    M.securityFill.color.copy(secCol)
    M.securityStroke.color.copy(secCol)
    checkMarks.review?.color.copy(reviewCol)
    checkMarks.security?.color.copy(secCol)
    const pops = STAGES.map((s) => at(q, CUE[s.id]))
    commits.forEach((c, i) => {
      // develop swells again when the fix lands
      const s = pops[i] * (i === 1 ? 1 + at(q, CUE.refix) * (1 - approveW) * 0.4 : 1)
      c.visible = s > 0.02
      c.scale.setScalar(Math.max(0.001, s))
    })
    const mg = at(q, CUE.mergeDot)
    const cg = at(q, CUE.chip)
    // the chip is the merge: no dot of its own
    mergeCommit.visible = false
    badge.visible = cg > 0.02
    badge.scale.setScalar(Math.max(0.001, cg))
    STAGES.forEach((s, i) => {
      gates[s.id] = pops[i]
    })
    gates.merge = mg
    gates.chip = cg
    prG.visible = pops[1] > 0.02
    const rr = at(q, CUE.rejectRun)
    reject.visible = rr > 0.04 && rr < 0.97 && !reduced
    if (reject.visible) reject.position.lerpVectors(STAGES[2].p, STAGES[1].p, rr)
    // a bright head rides the lane only while the lane is actually being drawn
    const grow = reduced ? 0 : clamp01((laneF - lastLaneF) * 900)
    lastLaneF = laneF
    M.pulseFill.opacity = grow * (0.35 + wK * 0.65)
    pulse.visible = grow > 0.02
    if (pulse.visible) pulse.position.copy(lane.getPointAt(Math.min(0.999, laneF)))
    M.primaryFill.opacity = 0.3 + wK * 0.6
    M.primaryStroke.opacity = 0.3 + wK * 0.55
    M.mergedFill.opacity = 0.3 + wK * 0.65
    M.mergedStroke.opacity = 0.3 + wK * 0.65
    M.paper.opacity = 0.3 + wK * 0.55

    // the merge's line down into the closing milestone, drawn once the merge has landed
    toClosing(win(p, [TASK_P[1] - 0.008, CUE_DROP_LINE]))

    // 05 · closure: the retrospective, once its line has typed
    closing.retro.set({ kept: shown > RECORD_UNIT, flash: +flashOf(RECORD_UNIT, ms).toFixed(2) })
    closing.retro.show(lift(1, 4))

    // 06 · report: the head, the figures one by one, where the time goes
    const rise = (pl, f, alts) => {
      pl.mesh.position.copy(pl.home ?? pl.mesh.position).add(tmp.set(0, -0.12 * (1 - f), 0))
      pl.show(f * alts)
    }
    reportHead.show(win(p, CUE_HEAD) * lift(1, 5))
    stats.forEach((pl, i) => {
      rise(pl, win(p, CUE_TILE(i)), lift(1, 5))
    })
    rise(time, win(p, CUE_TIME), lift(1, 5))

    // 07 · self-improvement: the link down, the Improver's card, its findings one by one
    const learnF = win(p, CUE_LEARN)
    toLearn(learnF)
    learnFrame.visible = learnF > 0.002
    M.aiInk.opacity = learnF * (0.25 + 0.45 * w(6))
    learnHead.show(learnF * lift(1, 6))
    findPanels.forEach((pl, i) => {
      rise(pl, win(p, CUE_FIND(i)), lift(1, 6))
    })

    // 08 · back upstream: the link down, the tracker, the new Project lit, the report beside it
    const nextF = win(p, CUE_NEXT)
    const newF = win(p, CUE_NEW)
    toNext(nextF)
    nextDash.show(nextF * lift(1, 7))
    newCard.set({ name: first?.title ?? '', icon: 'wrench', lit: +newF.toFixed(2), fresh: true })
    newCard.show(nextF * lift(1, 7))
    whyCard.show(win(p, CUE_WHYCARD) * lift(1, 7))
    M.flowFill.opacity = 0.25 + 0.4 * w(0, 1, 3, 4, 5, 6, 7)
    gates.flag = flagF
    gates.new = newF

    // ── labels
    scene.updateMatrixWorld(true)
    camera.updateMatrixWorld()
    LABELS.forEach((l) => {
      const off = l.offNarrow && narrow() ? l.offNarrow : l.off
      if (l.local) l.world.copy(off).applyMatrix4(l.obj.matrixWorld)
      else {
        l.obj.getWorldPosition(l.world)
        if (off) l.world.add(off)
      }
      proj.copy(l.world).project(camera)
      const g = l.gate ? (gates[l.gate] ?? 1) : 1
      const gate = g
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
