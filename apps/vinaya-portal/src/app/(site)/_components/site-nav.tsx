import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import type { TopBarGroupSection, TopBarNavItem } from '@/ui/topbar'
import { ELEMENT_ICONS } from './icons'
import { ConfigScene, ImproveScene, LogScene, StudioScene, TelemetryScene } from './menu-previews'

const ConfigurationIcon = ELEMENT_ICONS['configuration']
const LogIcon = ELEMENT_ICONS['log']
const SelfImprovementIcon = ELEMENT_ICONS['self-improvement']
const StudioIcon = ELEMENT_ICONS['studio']
const TelemetryIcon = ELEMENT_ICONS['telemetry']
const VinayaHarnessIcon = ELEMENT_ICONS['vinaya-harness']
const VinayaProcessIcon = ELEMENT_ICONS['vinaya-process']

/**
 * The site's one navigation, shared by every top bar: the site's own, the docs
 * shell's and the Vinaya process app's. Plain labels; the bar marks the active one.
 */
/** A group's trigger: its name and the chevron that turns while the panel is open. */
const group = (name: string): ReactNode => (
  <span className='flex items-center gap-1'>
    {name}
    <ChevronDown className='size-3.5 transition-transform duration-200' aria-hidden />
  </span>
)

const LIST_ICON = 'size-9'

/** The Product menu: the five features as a list, and a preview of the one pointed at. Each opens its feature page. */
const PRODUCT_SECTIONS: TopBarGroupSection[] = [
  {
    title: 'Five features, one harness',
    description: 'They work with any process',
    layout: 'preview',
    items: [
      {
        label: 'Log',
        href: '/log',
        icon: <LogIcon className={LIST_ICON} />,
        description: 'Every act, written down',
        preview: {
          title: 'Every check, review and decision, written down',
          line: 'Typed events with who made them, delivered live to a folder or your own log server.',
          art: <LogScene />
        }
      },
      {
        label: 'Telemetry',
        href: '/telemetry',
        icon: <TelemetryIcon className={LIST_ICON} />,
        description: 'The Log, counted',
        preview: {
          title: 'What the Log adds up to',
          line: 'Time per task, second rounds, problems caught and where the time goes, for every milestone.',
          art: <TelemetryScene />
        }
      },
      {
        label: 'Studio',
        href: '/studio',
        icon: <StudioIcon className={LIST_ICON} />,
        description: 'Your agents, right now',
        preview: {
          title: 'See every agent and every task, live',
          line: 'Mission Control, the dashboard and every repository you govern. It reads; it never decides.',
          art: <StudioScene />
        }
      },
      {
        label: 'Self-improvement',
        href: '/self-improvement',
        icon: <SelfImprovementIcon className={LIST_ICON} />,
        description: 'Proposed, then approved',
        preview: {
          title: 'The process gets better by itself',
          line: 'The Improver reads the reports and proposes changes. You approve them; they go back to product.',
          art: <ImproveScene />
        }
      },
      {
        label: 'Configuration',
        href: '/configuration',
        icon: <ConfigurationIcon className={LIST_ICON} />,
        description: 'One file sets it up',
        preview: {
          title: 'One file turns the harness on',
          line: 'vinaya.config.json declares the process, agents, forge and log destination. It never runs code.',
          art: <ConfigScene />
        }
      }
    ]
  }
]

/** The Docs menu: the harness and the process, side by side. */
const DOCS_SECTIONS: TopBarGroupSection[] = [
  {
    title: 'Docs',
    description: 'Pick where to start',
    layout: 'cards',
    items: [
      {
        label: 'The Vinaya harness',
        href: '/docs/start',
        icon: <VinayaHarnessIcon className='size-12' />,
        description: 'Install it, the CLI, the features'
      },
      {
        label: 'The Vinaya process',
        href: '/docs/process',
        icon: <VinayaProcessIcon className='size-12' />,
        description: 'Think, execute, retrospect'
      }
    ]
  }
]

export const SITE_LINKS: TopBarNavItem[] = [
  {
    label: group('Product'),
    items: PRODUCT_SECTIONS.flatMap((section) => section.items),
    sections: PRODUCT_SECTIONS
  },
  { label: 'The Vinaya process', href: '/vinaya-process' },
  {
    label: group('Docs'),
    items: DOCS_SECTIONS.flatMap((section) => section.items),
    sections: DOCS_SECTIONS
  }
]
