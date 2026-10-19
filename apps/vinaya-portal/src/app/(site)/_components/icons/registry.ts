import type { ComponentType } from 'react'
import { SetupCommandsIcon, TrustIcon } from './configuration'
import { ConfigurationIcon, LogIcon, SelfImprovementIcon, StudioIcon, TelemetryIcon } from './features'
import { CliIcon, DevProcessIcon, FeaturesIcon, GetStartedIcon, VinayaHarnessIcon } from './harness'
import { CustomEventsIcon, DeliveryIcon, EventContractIcon, RedactionIcon } from './log'
import { GatesIcon, IntegrationIcon, VinayaProcessIcon } from './process'
import { DashboardIcon, ManyRepositoriesIcon, MissionControlIcon } from './studio'

// One icon per element of the product, used for that element everywhere: the menus, the home page, the feature
// pages and the docs. Pick an element's icon from here rather than importing a drawing directly, so the same
// thing is never drawn two ways.

type Icon = ComponentType<{ className?: string }>

export const ELEMENT_ICONS = {
  'vinaya-harness': VinayaHarnessIcon,
  'vinaya-process': VinayaProcessIcon,
  'get-started': GetStartedIcon,
  features: FeaturesIcon,
  'dev-process': DevProcessIcon,
  cli: CliIcon,
  log: LogIcon,
  telemetry: TelemetryIcon,
  studio: StudioIcon,
  'self-improvement': SelfImprovementIcon,
  configuration: ConfigurationIcon,
  integration: IntegrationIcon,
  gates: GatesIcon,
  'event-contract': EventContractIcon,
  delivery: DeliveryIcon,
  'custom-events': CustomEventsIcon,
  'redaction-and-trust': RedactionIcon,
  'mission-control': MissionControlIcon,
  'dashboard-and-statistics': DashboardIcon,
  'many-repositories': ManyRepositoriesIcon,
  trust: TrustIcon,
  'setup-commands': SetupCommandsIcon
} satisfies Record<string, Icon>

export type Element = keyof typeof ELEMENT_ICONS

/** Each element's docs page. */
const DOCS_PAGE: Record<string, Element> = {
  '/docs/start': 'vinaya-harness',
  '/docs/start/get-started': 'get-started',
  '/docs/start/cli': 'cli',
  '/docs/features': 'features',
  '/docs/features/log': 'log',
  '/docs/features/log/event-contract': 'event-contract',
  '/docs/features/log/delivery': 'delivery',
  '/docs/features/log/custom-events': 'custom-events',
  '/docs/features/log/redaction-and-trust': 'redaction-and-trust',
  '/docs/features/telemetry': 'telemetry',
  '/docs/features/studio': 'studio',
  '/docs/features/studio/mission-control': 'mission-control',
  '/docs/features/studio/dashboard-and-statistics': 'dashboard-and-statistics',
  '/docs/features/studio/many-repositories': 'many-repositories',
  '/docs/features/self-improvement': 'self-improvement',
  '/docs/features/configuration': 'configuration',
  '/docs/features/configuration/the-file-and-its-keys': 'configuration',
  '/docs/features/configuration/trust': 'trust',
  '/docs/features/configuration/setup-commands': 'setup-commands',
  '/docs/dev-process/overview': 'dev-process',
  '/docs/process': 'vinaya-process',
  '/docs/process/gates': 'gates'
}

/** The icon of the element a docs page is about, or none for a page that is not one element. */
export function iconForHref(href: string): Icon | undefined {
  const element = DOCS_PAGE[href.split('#')[0] ?? href]
  return element ? ELEMENT_ICONS[element] : undefined
}
