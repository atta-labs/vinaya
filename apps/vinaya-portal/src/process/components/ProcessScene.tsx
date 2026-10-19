'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { tokenHex } from '@/ui/lib/theme-color'
import type { SceneState, Stage } from '../types'

/**
 * The 3D scene. One prop in: the shared `SceneState`. It never decides
 * anything; it draws what the state says. Stage nodes sit on a curve that
 * closes back on itself (improve → upstream); task particles ride it; the
 * loop node has a Developer and two Reviewers in orbit inside a sandbox;
 * three rings around the gates node show Ring 0, 1 and 2.
 */
const P: Record<Stage, [number, number, number]> = {
  upstream: [-7, 0, 0],
  architect: [-5, 1.2, -1],
  planner: [-3, 0.4, -2.4],
  loop: [0, 0, -1.5],
  gates: [2.6, 0, -0.2],
  merge: [4.2, 0.3, 1.4],
  archive: [5.8, 1.3, 0.4],
  observed: [3.2, 2.8, -2.8],
  improve: [-2, 3.2, -3.6]
}
const order = Object.keys(P) as Stage[]

const token = (n: string) => new THREE.Color(tokenHex(n))

type Rig = {
  set: (s: SceneState) => void
  dispose: () => void
}

function build(canvas: HTMLCanvasElement): Rig {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  r.setPixelRatio(Math.min(devicePixelRatio, 2))
  const sc = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
  const hex = token
  const grey = () => token('--muted-foreground')

  const pts = order.map((k) => new THREE.Vector3(...P[k]))
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4)
  const ret = new THREE.CatmullRomCurve3(
    [pts[8] as THREE.Vector3, new THREE.Vector3(-6, 3, -2.4), pts[0] as THREE.Vector3],
    false
  )
  const line = (c: THREE.Curve<THREE.Vector3>, op: number) =>
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(c.getPoints(140)),
      new THREE.LineBasicMaterial({ color: grey(), transparent: true, opacity: op })
    )
  sc.add(line(curve, 0.9), line(ret, 0.35))
  const grid = new THREE.GridHelper(44, 44, token('--border'), token('--border'))
  grid.position.y = -2.2
  sc.add(grid)

  const nodeGeo = new THREE.SphereGeometry(0.22, 24, 24)
  const nodes = order.map((k, i) => {
    const s = new THREE.Mesh(nodeGeo, new THREE.MeshBasicMaterial({ color: grey() }))
    s.position.copy(pts[i] as THREE.Vector3)
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.38, 40),
      new THREE.MeshBasicMaterial({ color: grey(), side: THREE.DoubleSide, transparent: true, opacity: 0 })
    )
    ring.position.copy(s.position)
    sc.add(s, ring)
    return { k, s, ring }
  })

  const gateM = [0, 1, 2].map((i) => {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(0.45 + i * 0.24, 0.04, 10, 56),
      new THREE.MeshBasicMaterial({ color: grey(), transparent: true, opacity: 0.55 })
    )
    t.position.copy(pts[4] as THREE.Vector3)
    t.rotation.y = Math.PI / 2
    sc.add(t)
    return t
  })

  const loopG = new THREE.Group()
  loopG.position.copy(pts[3] as THREE.Vector3)
  sc.add(loopG)
  const sat = (col: THREE.Color, rad: number, a: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: col }))
    m.userData = { rad, a }
    loopG.add(m)
    return m
  }
  const sats = [sat(token('--chart-4'), 0.75, 0), sat(grey(), 0.95, 2.1), sat(grey(), 0.95, 4.2)]
  const orbit = new THREE.Mesh(
    new THREE.RingGeometry(0.73, 0.77, 48),
    new THREE.MeshBasicMaterial({ color: token('--chart-4'), side: THREE.DoubleSide, transparent: true, opacity: 0 })
  )
  orbit.rotation.x = Math.PI / 2
  loopG.add(orbit)
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, 1.4, 2.4)),
    new THREE.LineBasicMaterial({ color: grey(), transparent: true, opacity: 0 })
  )
  box.position.copy(pts[3] as THREE.Vector3)
  sc.add(box)
  const mile = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.5),
    new THREE.MeshBasicMaterial({ color: token('--chart-3'), transparent: true, opacity: 0, side: THREE.DoubleSide })
  )
  mile.position.copy(pts[1] as THREE.Vector3).add(new THREE.Vector3(0, 1.1, 0))
  sc.add(mile)

  const travG = new THREE.Group()
  sc.add(travG)
  const travGeo = new THREE.SphereGeometry(0.075, 10, 10)
  let trav: { m: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; i: number; ph: number }[] = []
  const setTasks = (n: number) => {
    if (trav.length === n) return
    travG.clear()
    trav = []
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(travGeo, new THREE.MeshBasicMaterial({ color: token('--chart-3') }))
      travG.add(m)
      trav.push({ m, i, ph: Math.random() * 6 })
    }
  }
  sc.fog = new THREE.Fog(token('--background'), 14, 32)

  let S: SceneState = {
    stage: 'upstream',
    tone: 'think',
    orbit: false,
    gates: [0, 0, 0],
    tasks: 0,
    done: 0,
    hot: false,
    milestone: false,
    closed: false
  }
  const T = { pos: new THREE.Vector3(-4, 3.5, 9), look: (pts[0] as THREE.Vector3).clone() }
  const cur = { pos: T.pos.clone(), look: T.look.clone() }

  const toneOf = (k: Stage) =>
    k === 'loop' || k === 'gates' || k === 'merge'
      ? '--chart-4'
      : k === 'archive' || k === 'improve'
        ? '--chart-2'
        : k === 'observed'
          ? '--primary'
          : S.hot
            ? '--destructive'
            : '--chart-3'

  function set(s: SceneState) {
    S = s
    const idx = Math.max(0, order.indexOf(s.stage))
    const p = pts[idx] as THREE.Vector3
    T.look.copy(p)
    T.pos.set(p.x - 2.2, p.y + 2.8, p.z + 6.4)
    nodes.forEach((n, j) => {
      const col = j <= idx ? hex(toneOf(n.k)) : grey()
      n.s.material.color.copy(col)
      n.ring.material.color.copy(col)
      n.ring.material.opacity = j === idx ? 1 : 0
    })
    if (sc.fog) sc.fog.color = token('--background')
    setTasks(s.tasks)
    orbit.material.opacity = s.orbit ? 0.9 : 0
    box.material.opacity = s.orbit ? 0.8 : 0
    mile.material.opacity = s.milestone ? 0.35 : 0
    ;(sats[0] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>).material.color.copy(
      s.hot ? hex('--destructive') : hex('--chart-4')
    )
    s.gates.forEach((v, i) => {
      const g = gateM[i] as THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>
      g.material.color.copy(v === 2 ? hex('--chart-2') : v === 1 ? hex('--chart-4') : grey())
      g.material.opacity = v ? 1 : 0.55
    })
    if (reduced) render(0, true)
  }

  let t = 0
  const loopU = order.indexOf('loop') / (order.length - 1)
  const archU = order.indexOf('archive') / (order.length - 1)
  const planU = order.indexOf('planner') / (order.length - 1)
  function render(dt: number, once = false) {
    t += dt
    const k = once ? 1 : 0.05
    cur.pos.lerp(T.pos, k)
    cur.look.lerp(T.look, k * 1.2)
    cam.position.copy(cur.pos)
    cam.lookAt(cur.look)
    for (const tr of trav) {
      const done = tr.i < S.done
      let u: number
      if (S.stage === 'planner' || S.stage === 'architect' || S.stage === 'upstream') u = planU - tr.i * 0.015
      else if (S.stage === 'loop')
        u = done ? archU : tr.i === S.done ? loopU + Math.sin(t * 1.5 + tr.ph) * 0.02 : planU + 0.04 - tr.i * 0.015
      else u = archU + (S.closed ? 0.02 : 0) - tr.i * 0.012
      u = Math.max(0, Math.min(1, u))
      tr.m.position.copy(curve.getPointAt(u)).add(new THREE.Vector3(0, 0.3 + Math.sin(t * 2 + tr.ph) * 0.05, 0))
      tr.m.material.color.copy(done || S.closed ? hex('--chart-2') : S.hot ? hex('--destructive') : hex('--chart-3'))
    }
    const sp = S.orbit ? 2.2 : 0.12
    for (const s of sats) {
      s.userData.a += sp * dt
      s.position.set(Math.cos(s.userData.a) * s.userData.rad, 0, Math.sin(s.userData.a) * s.userData.rad)
    }
    const n = nodes[Math.max(0, order.indexOf(S.stage))] as (typeof nodes)[number]
    const kk = 1 + Math.sin(t * 4) * 0.15
    n.ring.scale.set(kk, kk, kk)
    for (const x of nodes) x.ring.lookAt(cam.position)
    gateM.forEach((g, j) => {
      g.rotation.z += dt * (0.25 + j * 0.12) * (S.gates[j] === 1 ? 4 : 1)
    })
    mile.lookAt(cam.position)
    box.rotation.y += dt * 0.15
    r.render(sc, cam)
  }
  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    r.setSize(w, h, false)
    cam.aspect = w / h
    cam.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)
  resize()
  let raf = 0
  let last = performance.now()
  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    render(dt)
    raf = requestAnimationFrame(loop)
  }
  if (!reduced) raf = requestAnimationFrame(loop)
  else render(0, true)
  return {
    set,
    dispose: () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      r.dispose()
    }
  }
}

export function ProcessScene({ state, className }: { state: SceneState; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const rig = useRef<Rig | null>(null)
  useEffect(() => {
    if (!canvas.current) return
    rig.current = build(canvas.current)
    return () => rig.current?.dispose()
  }, [])
  useEffect(() => {
    rig.current?.set(state)
  }, [state])
  return (
    <canvas
      ref={canvas}
      className={className ?? 'block h-full w-full'}
      aria-label='The Vinaya process, drawn in three dimensions'
    />
  )
}
