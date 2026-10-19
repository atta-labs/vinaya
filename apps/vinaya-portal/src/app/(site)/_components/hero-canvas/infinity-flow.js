import { smoothstep } from '@/ui/lib/math'

/* The infinity: a subtle current that leaves the north-east column with the shock wave and
   traces a figure-eight around the harness. Outside the ring it is a few hairline strands
   with bright packets running along them (orange → red → green); inside the ring it is never
   drawn — it never crosses main — and the columns carry it instead, charging as it passes.

   Plan view: screen-up is world −z, so the screen angle `deg` lands at (cos, 0, −sin), the
   same mapping harness-model.js's plates use. Runs on the scene clock, not the scroll. */

const SAMPLES = 900
const PACKETS = 3
const SPEED = 0.07 // loops per second for the packets
const DRAW = 0.32 // loops per second while the current is first drawn out
const CHARGE_S = 0.7 // the north-east column fills before anything leaves it
const COLUMN_DEG = [45, 135, 225, 315]
const LOBE = 2.6 // lemniscate half-width in ring radii
const SQUASH = 1.28 // fattens the lobes vertically, like the sketch

const STRANDS = [
  { a: 1, ys: 1, rot: 0, width: 1.4, phase: 0, alpha: 1 },
  { a: 0.988, ys: 0.975, rot: 0.006, width: 1.0, phase: 0.04, alpha: 0.7 },
  { a: 1.01, ys: 1.02, rot: -0.005, width: 0.8, phase: 0.08, alpha: 0.5 }
]

const hexRGB = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]
const toHex = (h) => (typeof h === 'number' ? h : Number.parseInt(String(h).replace('#', ''), 16))

function sampleStrand({ a, ys, rot }, rOut) {
  const A = a * LOBE * rOut
  const pts = []
  let len = 0
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  for (let i = 0; i <= SAMPLES; i++) {
    const t = Math.PI / 2 - 2 * Math.PI * (i / SAMPLES)
    const d = 1 + Math.sin(t) ** 2
    const x0 = (A * Math.cos(t)) / d
    const y0 = ((A * Math.sin(t) * Math.cos(t)) / d) * ys * SQUASH
    // plan XY (y = screen-up) → world x, z = −y
    const x = x0 * c - y0 * s
    const z = -(x0 * s + y0 * c)
    if (i > 0) len += Math.hypot(x - pts[i - 1].x, z - pts[i - 1].z)
    pts.push({ x, z, len, r: Math.hypot(x, z), deg: ((Math.atan2(-z, x) * 180) / Math.PI + 360) % 360 })
  }
  for (const p of pts) p.u = p.len / len
  return pts
}

const columnOf = (deg) => {
  for (let i = 0; i < 4; i++) if (Math.abs(((deg - COLUMN_DEG[i] + 540) % 360) - 180) < 20) return i
  return -1
}

export function buildInfinityFlow(THREE, { dims, seatY, dishDepth, dishR, colors }) {
  const { rOut, rIn, k, gripR } = dims
  const group = new THREE.Group()
  group.name = 'infinity-flow'

  /* a hair above the fabric's well (field-3d.js: −dishDepth·e^(−1.35(d/dishR)²)), never
     below the ring's top face where it leaves the harness */
  const ringTop = seatY + 0.05
  const heightAt = (r) =>
    Math.max(-dishDepth * Math.exp(-1.35 * (r / dishR) ** 2) + 0.07, ringTop - 0.25 * smoothstep(rOut, rOut * 1.3, r))

  const shared = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uPr: { value: 1 },
    uTime: { value: 0 },
    uHead: { value: 0 },
    uBorn: { value: 0 },
    uROut: { value: rOut },
    uC1: { value: new THREE.Vector3() },
    uC2: { value: new THREE.Vector3() },
    uC3: { value: new THREE.Vector3() }
  }

  const strands = STRANDS.map((cfg, si) => {
    const pts = sampleStrand(cfg, rOut)
    const n = pts.length
    const pos = new Float32Array(n * 2 * 3)
    const next = new Float32Array(n * 2 * 3)
    const side = new Float32Array(n * 2)
    const uu = new Float32Array(n * 2)
    const rr = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      const q = pts[i === n - 1 ? 1 : i + 1]
      for (let j = 0; j < 2; j++) {
        const o = i * 2 + j
        pos.set([p.x, heightAt(p.r), p.z], o * 3)
        next.set([q.x, heightAt(q.r), q.z], o * 3)
        side[o] = j ? 1 : -1
        uu[o] = p.u
        rr[o] = p.r
      }
    }
    const index = []
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('nextPos', new THREE.BufferAttribute(next, 3))
    geo.setAttribute('side', new THREE.BufferAttribute(side, 1))
    geo.setAttribute('u', new THREE.BufferAttribute(uu, 1))
    geo.setAttribute('rad', new THREE.BufferAttribute(rr, 1))
    geo.setIndex(index)
    const mat = new THREE.ShaderMaterial({
      name: `infinity-strand-${si}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        ...shared,
        uWidth: { value: cfg.width },
        uPhase: { value: cfg.phase },
        uAlpha: { value: cfg.alpha },
        uExit: { value: 0 }
      },
      vertexShader: `
        uniform vec2 uRes; uniform float uWidth; uniform float uPr;
        attribute vec3 nextPos; attribute float side; attribute float u; attribute float rad;
        varying float vU; varying float vR; varying float vSide;
        void main() {
          vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 n = projectionMatrix * modelViewMatrix * vec4(nextPos, 1.0);
          vec2 a = c.xy / c.w * uRes * 0.5;
          vec2 b = n.xy / n.w * uRes * 0.5;
          vec2 d = b - a;
          d = length(d) < 1e-5 ? vec2(1.0, 0.0) : normalize(d);
          vec2 nrm = vec2(-d.y, d.x);
          // half-width in device px, plus a px of falloff on each side
          c.xy += nrm * side * (uWidth * 0.5 + 1.0) * uPr * 2.0 / uRes * c.w;
          gl_Position = c;
          vU = u; vR = rad; vSide = side;
        }`,
      fragmentShader: `
        uniform float uTime; uniform float uHead; uniform float uBorn; uniform float uPhase;
        uniform float uAlpha; uniform float uExit; uniform float uROut;
        uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
        varying float vU; varying float vR; varying float vSide;
        vec3 ramp(float x) {
          float s = fract(x) * 3.0;
          if (s < 1.0) return mix(uC1, uC2, s);
          if (s < 2.0) return mix(uC2, uC3, s - 1.0);
          return mix(uC3, uC1, s - 2.0);
        }
        void main() {
          float edge = clamp((vR - uROut * 1.02) / (uROut * 0.2), 0.0, 1.0);
          if (edge <= 0.0) discard; // never drawn inside the ring: the columns carry it there
          float rel = fract(vU - uExit);
          float I = 0.12;
          if (uBorn < 0.5) {
            if (rel > uHead) discard;
            float d = uHead - rel;
            I += max(0.0, 1.0 - d / 0.07) * 1.3;
          }
          for (int k = 0; k < ${PACKETS}; k++) {
            float f = 1.0 - fract(vU - uTime * ${SPEED.toFixed(3)} - uPhase - float(k) / ${PACKETS}.0);
            if (f < 0.24) { float q = 1.0 - f / 0.24; I += q * q * q * 1.1; }
          }
          float soft = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
          float a = min(1.0, I * uAlpha * edge) * soft;
          if (a <= 0.003) discard;
          gl_FragColor = vec4(ramp(vU + uTime * 0.03), a);
        }`
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = 6
    mesh.visible = false
    group.add(mesh)
    const exit = pts.find((p) => p.u > 0 && p.r > rOut).u
    mat.uniforms.uExit.value = exit
    // u → sample lookup, for where a packet head is inside the harness
    const lut = new Int32Array(1001)
    for (let b = 0, i = 0; b <= 1000; b++) {
      while (i < n - 1 && pts[i].u < b / 1000) i++
      lut[b] = i
    }
    return { cfg, pts, mesh, mat, exit, lut }
  })

  const lead = strands[0]
  /* Inside the ring the infinity is carried by the columns: on each shaft's top face, the
     same three hairlines as outside, close together, running the same flow — each column
     point takes the loop position (u) the infinity has where it passes that column, so the
     packets slide from the strands into the column and out again without a seam. Nothing
     static: the faint base and the soft packets are the outside strands' own. */
  const outer = rIn - 1 * k
  const colTop = seatY + 0.049
  const LANE = 1.7 * k
  const columns = COLUMN_DEG.map((deg, ci) => {
    const inside = lead.pts.filter((p) => p.r < rIn && p.r > gripR * 0.9 && columnOf(p.deg) === ci)
    const near = (r) => inside.reduce((m, p) => (Math.abs(p.r - r) < Math.abs(m.r - r) ? p : m))
    const u0 = near(gripR).u
    const u1 = near(outer).u
    const len = outer - gripR
    const geo = new THREE.PlaneGeometry(len, 10 * k, 1, 1)
    geo.rotateX(-Math.PI / 2)
    geo.translate(gripR + len / 2, 0, 0)
    const mat = new THREE.ShaderMaterial({
      name: `column-current-${deg}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: shared.uTime,
        uHead: shared.uHead,
        uBorn: shared.uBorn,
        uC1: shared.uC1,
        uC2: shared.uC2,
        uC3: shared.uC3,
        uExit: { value: lead.exit },
        uU0: { value: u0 },
        uU1: { value: u1 },
        uFill: { value: 0 },
        uStart: { value: ci === 0 ? 1 : 0 },
        uIn: { value: gripR },
        uOut: { value: outer }
      },
      vertexShader: `
        varying vec2 vP;
        void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3;
        uniform float uTime; uniform float uHead; uniform float uBorn; uniform float uExit;
        uniform float uU0; uniform float uU1; uniform float uFill; uniform float uStart;
        uniform float uIn; uniform float uOut;
        varying vec2 vP;
        vec3 ramp(float x) {
          float s = fract(x) * 3.0;
          if (s < 1.0) return mix(uC1, uC2, s);
          if (s < 2.0) return mix(uC2, uC3, s - 1.0);
          return mix(uC3, uC1, s - 2.0);
        }
        void main() {
          float s = (vP.x - uIn) / (uOut - uIn);
          float u = mix(uU0, uU1, s);
          float boost = 0.0;
          if (uBorn < 0.5) {
            if (uStart > 0.5) {
              // the north-east column fills from main outward before the current leaves it
              if (uHead <= 0.0) {
                if (s > uFill) discard;
                boost = max(0.0, 1.0 - (uFill - s) / 0.35) * 1.1;
              }
            } else {
              float rel = fract(u - uExit);
              if (rel > uHead) discard;
              boost = max(0.0, 1.0 - (uHead - rel) / 0.07) * 1.3;
            }
          }
          float ends = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.88, 1.0, s));
          float aa = fwidth(vP.y);
          vec3 col = vec3(0.0);
          float alpha = 0.0;
          for (int i = 0; i < 3; i++) {
            float fi = float(i);
            float phase = fi * 0.04;
            float weight = 1.0 - fi * 0.25;
            float y = (fi - 1.0) * ${LANE.toFixed(4)};
            float line = 1.0 - smoothstep(aa * 0.15, aa * 1.1, abs(vP.y - y));
            float I = 0.24 + boost; // a touch above the strands: the columns hold the charge
            for (int k = 0; k < ${PACKETS}; k++) {
              float f = 1.0 - fract(u - uTime * ${SPEED.toFixed(3)} - phase - float(k) / ${PACKETS}.0);
              if (f < 0.24) { float q = 1.0 - f / 0.24; I += q * q * q * 1.1; }
            }
            float a = line * min(1.0, I * weight) * ends;
            col += ramp(u + uTime * 0.03) * a;
            alpha += a;
          }
          if (alpha <= 0.003) discard;
          gl_FragColor = vec4(col / alpha, min(1.0, alpha));
        }`
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = colTop
    mesh.rotation.y = (deg * Math.PI) / 180 // local +x → (cos, 0, −sin)
    mesh.renderOrder = 7
    mesh.visible = false
    group.add(mesh)
    return { mesh, mat }
  })

  function retheme(next) {
    const [c1, c2, c3] = [next.warning, next.destructive, next.success].map((h) => hexRGB(toHex(h)))
    shared.uC1.value.set(...c1)
    shared.uC2.value.set(...c2)
    shared.uC3.value.set(...c3)
  }
  retheme(colors)

  /* t: scene seconds; start: when the current is released (null = not yet) */
  function update(t, start) {
    if (start == null || t < start) {
      group.visible = false
      return
    }
    group.visible = true
    const age = t - start
    const charge0 = Math.min(1, age / CHARGE_S)
    const head = Math.max(0, (age - CHARGE_S) * DRAW)
    const born = head >= 1
    for (const s of strands) s.mesh.visible = head > 0
    shared.uTime.value = t
    shared.uHead.value = Math.min(1, head)
    shared.uBorn.value = born ? 1 : 0

    for (const col of columns) {
      col.mat.uniforms.uFill.value = charge0
      col.mesh.visible = true
    }
  }

  function setResolution(w, h, pr) {
    shared.uRes.value.set(w * pr, h * pr)
    shared.uPr.value = pr
  }

  return { group, update, retheme, setResolution }
}
