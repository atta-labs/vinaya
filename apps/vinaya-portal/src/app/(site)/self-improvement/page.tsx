import { FeaturePage } from '../_components/feature-page/FeaturePage'
import { ImproverLive } from '../_components/feature-page/live'
import { ApprovalIcon, ImproverIcon, ProposalIcon, SelfImprovementIcon } from '../_components/icons'

export const metadata = { title: 'Self-improvement · Vinaya' }

export default function SelfImprovementPage() {
  return (
    <FeaturePage
      n={4}
      name='Self-improvement'
      icon={(className) => <SelfImprovementIcon className={className} />}
      lead='The Improver reads the reports and proposes changes to the process. A person approves, and each one goes back to product.'
      tags={['The Improver', 'Reads the Log', 'You approve', 'Any process']}
      docsHref='/docs/features/self-improvement'
      liveLabel="The Improver's proposals"
      live={<ImproverLive />}
      shows={{
        eyebrow: 'How it works',
        title: 'From patterns to a new version',
        items: [
          {
            title: 'It reads the Log',
            line: 'Across many runs: where rounds are lost, which gate catches most, what a task costs.',
            href: '/docs/features/self-improvement',
            icon: (className) => <ImproverIcon className={className} />
          },
          {
            title: 'It proposes a change',
            line: 'Each pattern becomes a proposal: to instructions, gates, settings or roles.',
            href: '/docs/features/self-improvement',
            icon: (className) => <ProposalIcon className={className} />
          },
          {
            title: 'A person approves',
            line: 'An approved change becomes a new process version, and goes back to product.',
            href: '/docs/features/self-improvement',
            icon: (className) => <ApprovalIcon className={className} />
          }
        ]
      }}
      never={{
        eyebrow: 'What it never does',
        title: (
          <>
            It proposes.
            <br />
            You decide.
          </>
        ),
        lead: 'The Improver is a harness agent, not a process role. It works for every process that writes the Log.',
        items: [
          ['Never applies itself.', 'Nothing changes until a person approves it.'],
          ['Never touches a running task.', 'Runs in progress keep the version they started with.'],
          ['Never the Operator’s job.', 'The Operator only operates; it never reads the report.']
        ]
      }}
      use={{
        title: 'What the record answers',
        line: 'The questions the Improver starts from.',
        code: ['Does a cheaper model finish?', 'Are the reviewers strict?', 'Which findings recur?']
      }}
      prev={{ n: 3, name: 'Studio', href: '/studio' }}
      next={{ n: 5, name: 'Configuration', href: '/configuration' }}
    />
  )
}
