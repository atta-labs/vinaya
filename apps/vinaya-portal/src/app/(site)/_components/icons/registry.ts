import type { ComponentType } from 'react'
import type { IconProps } from './icon-motion'
import {
  AgentIcon,
  ArchitectIcon,
  PlannerIcon,
  DeveloperIcon,
  ReviewerIcon,
  SecurityReviewerIcon,
  OperatorIcon,
  ArchivistIcon,
  TrancheArchivistIcon
} from './agents'
import { VinayaHarnessIcon, GetStartedIcon, FeaturesIcon, DevProcessIcon, CliIcon } from './harness'
import { LogIcon, TelemetryIcon, StudioIcon, SelfImprovementIcon, ConfigurationIcon } from './features'
import {
  IntegrationIcon,
  ThinkingIcon,
  ExecutingIcon,
  RetrospectingIcon,
  GatesIcon,
  UsingItIcon,
  GuidesIcon,
  ReferenceIcon,
  PartsIcon
} from './subjects'
import { VinayaProcessIcon } from './process'

// Product, agent and index-subject drawings share one registry across menus, pages and docs.
type Icon = ComponentType<IconProps>

export const ELEMENT_ICONS = {
  'vinaya-harness': VinayaHarnessIcon,
  agent: AgentIcon,
  architect: ArchitectIcon,
  planner: PlannerIcon,
  developer: DeveloperIcon,
  reviewer: ReviewerIcon,
  'security-reviewer': SecurityReviewerIcon,
  operator: OperatorIcon,
  archivist: ArchivistIcon,
  'tranche-archivist': TrancheArchivistIcon,
  log: LogIcon,
  telemetry: TelemetryIcon,
  studio: StudioIcon,
  'self-improvement': SelfImprovementIcon,
  configuration: ConfigurationIcon,
  'dev-process': DevProcessIcon,
  cli: CliIcon,
  'get-started': GetStartedIcon,
  features: FeaturesIcon,
  integration: IntegrationIcon,
  thinking: ThinkingIcon,
  executing: ExecutingIcon,
  retrospecting: RetrospectingIcon,
  gates: GatesIcon,
  'using-it': UsingItIcon,
  guides: GuidesIcon,
  reference: ReferenceIcon,
  parts: PartsIcon,
  'vinaya-process': VinayaProcessIcon
} satisfies Record<string, Icon>

export type Element = keyof typeof ELEMENT_ICONS

/** Each element's docs page. */
const DOCS_PAGE: Record<string, Element> = {
  '/docs/start': 'vinaya-harness',
  '/docs/start/get-started': 'get-started',
  '/docs/start/cli': 'cli',
  '/docs/features': 'features',
  '/docs/features/log': 'log',
  '/docs/features/telemetry': 'telemetry',
  '/docs/features/studio': 'studio',
  '/docs/features/self-improvement': 'self-improvement',
  '/docs/features/configuration': 'configuration',
  '/docs/features/configuration/the-file-and-its-keys': 'configuration',
  '/docs/dev-process/overview': 'dev-process',
  '/docs/process': 'vinaya-process',
  '/docs/process/thinking': 'thinking',
  '/docs/process/executing': 'executing',
  '/docs/process/retrospecting': 'retrospecting',
  '/docs/process/gates': 'gates'
}

/** The icon of the element a docs page is about, or none for a page that is not one element. */
export function iconForHref(href: string): Icon | undefined {
  const element = DOCS_PAGE[href.split('#')[0] ?? href]
  return element ? ELEMENT_ICONS[element] : undefined
}
