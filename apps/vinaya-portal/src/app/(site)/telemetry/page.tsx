import { FeaturePage } from '../_components/feature-page/FeaturePage'
import { TelemetryLive } from '../_components/feature-page/live'
import { CacheIcon, NormaliserIcon, QuestionsIcon, TelemetryIcon, TelemetrySourceIcon } from '../_components/icons'

export const metadata = { title: 'Telemetry · Vinaya' }

export default function TelemetryPage() {
  return (
    <FeaturePage
      n={2}
      name='Telemetry'
      icon={(className) => <TelemetryIcon className={className} />}
      lead='What the Log adds up to: how long each task took, what the reviewers caught, how often the checks said no.'
      tags={['vinaya sync', 'Local cache', 'Ten questions, plus a confidence comparison', 'Unknown, never zero']}
      docsHref='/docs/features/telemetry'
      command='vinaya sync'
      liveLabel='A milestone report'
      live={<TelemetryLive />}
      shows={{
        eyebrow: 'How it works',
        title: 'Four steps from stored lines to answers',
        items: [
          {
            title: 'Source',
            line: 'Pages through your folder or server, whichever the Log writes to. Reading never changes it.',
            href: '/docs/features/telemetry',
            icon: (className) => <TelemetrySourceIcon className={className} />
          },
          {
            title: 'Normaliser',
            line: 'Turns each line into a row, or sets it aside, with the same check the sender uses.',
            href: '/docs/features/telemetry',
            icon: (className) => <NormaliserIcon className={className} />
          },
          {
            title: 'Cache',
            line: 'Keeps the rows by event identity, so reading a line twice adds nothing.',
            href: '/docs/features/telemetry',
            icon: (className) => <CacheIcon className={className} />
          },
          {
            title: 'Questions',
            line: 'Each answers with a figure, or with "unknown" and the reason.',
            href: '/docs/features/telemetry',
            icon: (className) => <QuestionsIcon className={className} />
          }
        ]
      }}
      never={{
        eyebrow: 'What it never does',
        title: (
          <>
            It counts.
            <br />
            It never guesses.
          </>
        ),
        lead: 'Telemetry needs no configuration of its own: it reads wherever the Log is stored.',
        items: [
          ['Never zero for unknown.', 'A missing figure says unknown, and why.'],
          ['Never writes elsewhere.', 'Only its own cache folder: not the Log, not the server, not the forge.'],
          ['Never counts twice.', 'The same line read again adds nothing.']
        ]
      }}
      use={{
        title: 'Sync and ask',
        line: 'Reads what the Log stored into a local cache. Stop any time; it resumes.',
        code: ['$ vinaya sync', '$ vinaya sync --json']
      }}
      prev={{ n: 1, name: 'Log', href: '/log' }}
      next={{ n: 3, name: 'Studio', href: '/studio' }}
    />
  )
}
