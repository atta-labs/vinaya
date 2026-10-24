import { Gauge, LayoutDashboard, FolderGit2 } from 'lucide-react'
import { FeaturePage } from '../_components/feature-page/FeaturePage'
import { StudioLive } from '../_components/feature-page/live'

export const metadata = { title: 'Studio · Vinaya' }

export default function StudioPage() {
  return (
    <FeaturePage
      n={3}
      name='Studio'
      lead='See what your agents are doing, right now. Studio reads the record. It never decides.'
      tags={['Web app', 'Read-only', 'Local', 'Reads the Log']}
      docsHref='/docs/features/studio'
      command='vinaya studio'
      liveLabel='Studio, live'
      live={<StudioLive />}
      shows={{
        eyebrow: 'What it shows',
        title: 'Three questions, one screen each',
        items: [
          {
            title: 'Mission Control',
            line: 'Work in flight: what is happening, for how long, and who must act.',
            href: '/docs/features/studio/mission-control',
            icon: (className) => <Gauge className={className} />
          },
          {
            title: 'Dashboard and statistics',
            line: 'Over time: planned work from the forge, and ten questions, plus a confidence comparison, answered from the Log.',
            href: '/docs/features/studio/dashboard-and-statistics',
            icon: (className) => <LayoutDashboard className={className} />
          },
          {
            title: 'Many repositories',
            line: 'Across repositories: every one an owner governs, on one page.',
            href: '/docs/features/studio/many-repositories',
            icon: (className) => <FolderGit2 className={className} />
          }
        ]
      }}
      never={{
        eyebrow: 'What it never does',
        title: (
          <>
            It reads.
            <br />
            It never decides.
          </>
        ),
        lead: 'Studio has two inputs: the Log for what ran, the forge for titles and merge state. Nothing else.',
        items: [
          ['No control.', 'It never starts, resumes, cancels or merges, and holds no write credential.'],
          ['No guessing.', 'A task that stopped reporting shows as presumed dead, its silence stated.'],
          ['No extra logging.', 'If a fact is not in the Log, Studio shows less.']
        ]
      }}
      use={{
        title: 'Open it in one line',
        line: 'From inside any governed repository. Nothing to configure.',
        code: ['$ vinaya studio', '$ vinaya studio --port 4000']
      }}
      prev={{ n: 2, name: 'Telemetry', href: '/telemetry' }}
      next={{ n: 4, name: 'Self-improvement', href: '/self-improvement' }}
    />
  )
}
