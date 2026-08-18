import { describe, expect, it } from 'vitest'
import { isPrincipal, isWaiverLabelActorVerified, PRINCIPAL_ALLOWLIST, WAIVER_LABEL } from './waiver-label'

/**
 * `isPrincipal` is the single membership predicate every allowlist consumer
 * shares — the waiver check and the review gate both route through it, so the
 * two can never disagree about whether a login is a principal. It was reachable
 * only indirectly through those consumers; these pin it directly, since a change
 * here silently moves both.
 */
describe('isPrincipal (shared allowlist membership predicate)', () => {
  it('a null login is never a principal — an unresolvable actor is not a trusted one', () => {
    expect(isPrincipal(null, PRINCIPAL_ALLOWLIST)).toBe(false)
  })

  it('an exact match is a principal', () => {
    expect(isPrincipal('daniboomerang', PRINCIPAL_ALLOWLIST)).toBe(true)
  })

  it('a login absent from the allowlist is not a principal', () => {
    expect(isPrincipal('drive-by-account', PRINCIPAL_ALLOWLIST)).toBe(false)
  })

  it.each([
    ['Alice', 'alice'],
    ['alice', 'Alice'],
    ['ALICE', 'aLiCe']
  ])('matches %j against a configured %j — GitHub logins are case-insensitive (PR #862)', (login, configured) => {
    expect(isPrincipal(login, [configured])).toBe(true)
  })

  it('case-insensitivity does not widen trust — a different login sharing a prefix is still rejected', () => {
    expect(isPrincipal('alice-bot', ['Alice'])).toBe(false)
    expect(isPrincipal('alice', ['Alice-bot'])).toBe(false)
  })

  it('an empty allowlist trusts nobody — fail closed, never fail open', () => {
    expect(isPrincipal('daniboomerang', [])).toBe(false)
  })

  it('an empty-string login is not a principal, even against an allowlist containing one', () => {
    // Defensive: `''` is what a careless `?? ''` upstream would hand in place of
    // the `null` the type already models. It must not become a match.
    expect(isPrincipal('', PRINCIPAL_ALLOWLIST)).toBe(false)
  })

  it('scans the whole allowlist, not just its first entry', () => {
    expect(isPrincipal('carol', ['alice', 'bob', 'carol'])).toBe(true)
  })
})

describe('isWaiverLabelActorVerified (actor-verified waiver label)', () => {
  it('label absent → false, regardless of actor', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: ['vinaya/tier:1'],
        labelActor: 'daniboomerang',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  it('label present, actor null → false', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: null,
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  it('label present, actor not in allowlist → false', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: 'some-agent-bot',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  it('label present, actor in allowlist → true', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: 'daniboomerang',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(true)
  })

  it('a different label present (e.g. vinaya/waiver:review) never verifies vinaya/waiver:docs', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: ['vinaya/waiver:review'],
        labelActor: 'daniboomerang',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  it('label present, actor an empty string → false (an unnamed actor is not a principal)', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: '',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  it('label present, actor a principal, but the allowlist is empty → false', () => {
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: 'daniboomerang',
        principalAllowlist: []
      })
    ).toBe(false)
  })

  it('honours the label case-insensitively on the ACTOR only — never on the label string itself', () => {
    // The actor is a GitHub login (case-insensitive); the label is code-owned
    // vocabulary from `labels.ts` and must match byte-for-byte. A near-miss
    // label an agent could invent must not waive anything.
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor: 'DaniBoomerang',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(true)
    expect(
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL.toUpperCase()],
        labelActor: 'daniboomerang',
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    ).toBe(false)
  })

  /**
   * The trap the design exists to prevent: honouring is an actor-verified forge
   * EVENT, never a parseable string. No body text, no commit trailer, no label
   * name an agent can write is sufficient on its own — only the pairing of
   * label presence with a principal actor on the labeling event.
   */
  it('label presence alone is never sufficient — the only true case pairs it with a principal actor', () => {
    const withActor = (labelActor: string | null) =>
      isWaiverLabelActorVerified({
        label: WAIVER_LABEL,
        labels: [WAIVER_LABEL],
        labelActor,
        principalAllowlist: PRINCIPAL_ALLOWLIST
      })
    // Every actor an agent could produce for itself:
    expect(withActor(null)).toBe(false)
    expect(withActor('github-actions[bot]')).toBe(false)
    expect(withActor('claude[bot]')).toBe(false)
    expect(withActor('some-agent-bot')).toBe(false)
    // Only the principal's own labeling event:
    expect(withActor('daniboomerang')).toBe(true)
  })
})
