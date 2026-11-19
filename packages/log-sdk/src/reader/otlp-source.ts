import { createLineReader } from './lines.js'
import type { OtelRecord } from './records.js'
import type { RecordSource, SourceProblem } from './source.js'

/** What a caller's supplier hands back: OTLP JSON documents (parsed, or as JSON text) after a cursor, and the cursor to read on from. */
export type OtlpPage = { documents: readonly unknown[]; cursor?: string | undefined }

/** The caller's way to reach an OpenTelemetry source: a file, a query interface or a server of any tool. */
export type OtlpSupplier = (cursor: string | undefined) => Promise<OtlpPage>

export type OtlpSourceOptions = {
  name: string
  supply: OtlpSupplier
  /**
   * Whether another tool wrote what the supplier hands. Defaults to `true`:
   * a record's own claim of `governed` is trusted only from a source the
   * caller says is the Log's own.
   */
  foreign?: boolean
  home?: string
}

/**
 * A source over any supplier of OTLP JSON documents. The position is the
 * supplier's cursor; a supplier that fails is reported and the same cursor is
 * read again on the next read.
 */
export function createOtlpSource(options: OtlpSourceOptions): RecordSource {
  const lines = createLineReader(options.name, options.home === undefined ? {} : { home: options.home })
  return {
    name: options.name,
    foreign: options.foreign ?? true,
    async read(position) {
      let page: OtlpPage
      try {
        page = await options.supply(position)
      } catch {
        return {
          records: [],
          problems: [
            {
              kind: 'source_unavailable',
              writerId: null,
              place: options.name,
              detail: `the supplier of ${options.name} failed; reading again from the same cursor`
            }
          ],
          position
        }
      }
      const records: OtelRecord[] = []
      const problems: SourceProblem[] = []
      page.documents.forEach((document, index) => {
        const read = typeof document === 'string' ? lines.readLine(document) : null
        const found = read ? read.records : lines.readDocument(document)
        if (found === null || (read !== null && read.problem !== null)) {
          problems.push({
            kind: 'unrecognised_document',
            writerId: null,
            place: `${options.name} document ${index}`,
            detail: read?.problem?.detail ?? 'the document is neither a traces nor a logs document'
          })
          return
        }
        records.push(...found)
      })
      return { records, problems, position: page.cursor ?? position }
    }
  }
}
