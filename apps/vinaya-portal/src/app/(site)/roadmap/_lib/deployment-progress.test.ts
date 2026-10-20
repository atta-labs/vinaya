import { describe, expect, it } from 'bun:test'
import { computeTrackFrame } from './deployment-progress'

type TrackFrameGeometry = Parameters<typeof computeTrackFrame>[0]
type TrackFrameHistory = Parameters<typeof computeTrackFrame>[1]

describe('computeTrackFrame', () => {
  // The full per-frame computation `DeploymentTrack.tsx`'s scroll effect actually calls —
  // exercising this, not just the smaller pure helpers in isolation, is what lets these
  // tests catch the regression the designer-handoff contract exists to prevent: the beam's
  // velocity/history state (the one thing genuinely carried frame-to-frame) leaking into
  // the beam's position or a card's stage.
  const baseGeometry: TrackFrameGeometry = {
    reduced: false,
    trackHeight: 2000,
    trackTop: 100,
    line: 500,
    spurReach: 110,
    cardOffsets: [
      { top: 800, height: 200 },
      { top: 1400, height: 200 }
    ]
  }

  it('computes deployed position and every card stage from geometry alone — varying carried history changes nothing but the velocity target', () => {
    // Same current-frame geometry every time; only the carried history differs, as if this
    // frame were reached by a slow approach, a fast approach, or no prior frame at all. A
    // buggy implementation that blended history into position (the exact regression this
    // split guards against) would make `deployed`/`cardStages` differ across these — the
    // correct implementation cannot, since `history` never reaches that part of the return
    // value.
    const histories: TrackFrameHistory[] = [
      { lastDeployed: null, velTarget: 0 },
      { lastDeployed: 0, velTarget: 0 },
      { lastDeployed: 9999, velTarget: 1 },
      { lastDeployed: 401, velTarget: 0.5 }
    ]

    const results = histories.map((history) => computeTrackFrame(baseGeometry, history))
    const reference = results[0]!
    const rest = results.slice(1)

    for (const result of rest) {
      expect(result.deployed).toBe(reference.deployed)
      expect(result.cardStages).toEqual(reference.cardStages)
      expect(result.installDoneAt).toBe(reference.installDoneAt)
    }
  })

  it('does let history change the velocity target — the one output allowed to carry state', () => {
    // A large jump from the previous frame's deployed position reads as fast motion; the
    // point of this test is to confirm the history argument does something (it drives
    // `velTarget`), so the previous test's "nothing changes" result isn't just history being
    // silently ignored altogether.
    const noJump = computeTrackFrame(baseGeometry, { lastDeployed: null, velTarget: 0 })
    const bigJump = computeTrackFrame(baseGeometry, { lastDeployed: 0, velTarget: 0 })
    expect(bigJump.velTarget).toBeGreaterThan(noJump.velTarget)
  })

  it('reproduces the same deployed position and card stages at a revisited scroll position, regardless of the history that led there', () => {
    // Same `trackTop` (the same real scroll position) visited twice, fed drastically
    // different carried history each time — one resembling a slow approach from above, the
    // other a fast approach from below, as scrolling back up through this point would
    // produce. Position and every card's stage must still match exactly; only the cosmetic
    // velocity target may differ.
    const revisited: TrackFrameGeometry = { ...baseGeometry, trackTop: -300 }
    // `revisited`'s own deployed position works out to 800px (see `computeDeployedPx`); one
    // history has the previous frame only 10px away (a slow approach), the other 800px away
    // (a fast, near-instant jump) — different enough that the resulting velocity target
    // actually differs, without both saturating at the same clamp ceiling.
    const arrivedSlowlyFromAbove = computeTrackFrame(revisited, { lastDeployed: 790, velTarget: 0.05 })
    const arrivedFastFromBelow = computeTrackFrame(revisited, { lastDeployed: 0, velTarget: 0.05 })

    expect(arrivedFastFromBelow.deployed).toBe(arrivedSlowlyFromAbove.deployed)
    expect(arrivedFastFromBelow.cardStages).toEqual(arrivedSlowlyFromAbove.cardStages)
    expect(arrivedFastFromBelow.velTarget).not.toBe(arrivedSlowlyFromAbove.velTarget)
  })

  it('threading history frame-to-frame through a realistic forward-then-backward scroll still rewinds every card exactly', () => {
    // Simulates how `DeploymentTrack.tsx` actually drives this function: each call's
    // history comes from the PREVIOUS call's own result, not a hand-picked value. Walk
    // `trackTop` from far below the track up past it (scrolling down) and then back
    // (scrolling up) through the same positions, threading history correctly each step, and
    // assert every revisited position reproduces the exact same card stages.
    const trackTops = [900, 700, 500, 300, 150, 50, -50, -150, -300, -500]

    function run(path: number[]) {
      let history: TrackFrameHistory = { lastDeployed: null, velTarget: 0 }
      const framesByTrackTop = new Map<number, ReturnType<typeof computeTrackFrame>>()
      for (const trackTop of path) {
        const frame = computeTrackFrame({ ...baseGeometry, trackTop }, history)
        framesByTrackTop.set(trackTop, frame)
        history = { lastDeployed: frame.deployed, velTarget: frame.velTarget }
      }
      return framesByTrackTop
    }

    const forward = run(trackTops)
    const backward = run([...trackTops].reverse())

    for (const trackTop of trackTops) {
      expect(backward.get(trackTop)?.deployed).toBe(forward.get(trackTop)?.deployed)
      expect(backward.get(trackTop)?.cardStages).toEqual(forward.get(trackTop)?.cardStages)
    }
  })
})
