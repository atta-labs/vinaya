import { Braces, Send, SquarePlus, EyeOff } from 'lucide-react'
import { FeaturePage } from '../_components/feature-page/FeaturePage'
import { LogLive } from '../_components/feature-page/live'

export const metadata = { title: 'Log · Vinaya' }

export default function LogPage() {
  return (
    <FeaturePage
      n={1}
      name='Log'
      lead='Every check, review and decision, written down as it happens, with who made it.'
      tags={['Typed events', 'Live delivery', 'Folder or server', 'Custom events']}
      docsHref='/docs/features/log'
      command='vinaya log --follow'
      liveLabel='The Log, live'
      live={<LogLive />}
      shows={{
        eyebrow: 'How it works',
        title: 'One typed event for every governed act',
        items: [
          {
            title: 'Event contract',
            line: 'Ten closed families, a versioned header, strict fields. A line that does not fit is never written.',
            href: '/docs/features/log/event-contract',
            icon: (className) => <Braces className={className} />
          },
          {
            title: 'Delivery',
            line: 'Sent the moment it is written, to a folder or your own server. Never batched, never slows a run.',
            href: '/docs/features/log/delivery',
            icon: (className) => <Send className={className} />
          },
          {
            title: 'Custom events',
            line: 'Declare your own events in logs.events. Vinaya checks each one and writes it like any other.',
            href: '/docs/features/log/custom-events',
            icon: (className) => <SquarePlus className={className} />
          },
          {
            title: 'Redaction and trust',
            line: 'Secrets are removed before a line is written, and again before it is sent or read back.',
            href: '/docs/features/log/redaction-and-trust',
            icon: (className) => <EyeOff className={className} />
          }
        ]
      }}
      never={{
        eyebrow: 'What it never does',
        title: (
          <>
            A record.
            <br />
            Never a control.
          </>
        ),
        lead: 'The Log belongs to the harness, not to a process. It reads the same whatever process runs on top.',
        items: [
          ['Never on the forge.', 'No Issue or pull-request comment, no CI artifact.'],
          ['Never in the way.', 'Delivery never slows or fails a run.'],
          ['Never control state.', 'A run never reads the Log to decide or recover.']
        ]
      }}
      use={{
        title: 'Point it anywhere',
        line: 'A folder on your machine by default, or your own log server with one key.',
        code: ['"logs": {', '  "url": "https://logs.acme.dev/v1/events"', '}']
      }}
      next={{ n: 2, name: 'Telemetry', href: '/telemetry' }}
    />
  )
}
