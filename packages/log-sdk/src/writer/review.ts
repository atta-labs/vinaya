import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../contract/catalogue.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

export type ReviewVerdicts = {
  seats: readonly { seat: string; verdict: string }[]
  blockingCount: number
  findings: readonly { id: string; severity: string; place: string; blocking: boolean }[]
}

export type FindingsCompared = {
  open: readonly string[]
  resolved: readonly string[]
  new: readonly string[]
  recurring: readonly string[]
}

export function reviewVerdicts(core: WriterCore, detail: ReviewVerdicts): void {
  emitEvent(
    core,
    E.reviewVerdicts,
    {
      [A.seats]: detail.seats.map(({ seat }) => seat),
      [A.verdicts]: detail.seats.map(({ verdict }) => verdict),
      [A.blockingCount]: detail.blockingCount,
      [A.findingIds]: detail.findings.map(({ id }) => id),
      [A.findingSeverities]: detail.findings.map(({ severity }) => severity),
      [A.findingPlaces]: detail.findings.map(({ place }) => place),
      [A.findingBlocking]: detail.findings.map(({ blocking }) => blocking)
    },
    core.current.round ?? runSpanRef(core)
  )
}

export function findingsCompared(core: WriterCore, detail: FindingsCompared): void {
  emitEvent(
    core,
    E.findingsCompared,
    {
      [A.findingsOpen]: [...detail.open],
      [A.findingsResolved]: [...detail.resolved],
      [A.findingsNew]: [...detail.new],
      [A.findingsRecurring]: [...detail.recurring]
    },
    core.current.round ?? runSpanRef(core)
  )
}
