/**
 * The docs follow the product's structure in Linear, split into two sets, each
 * with its own sidebar and entry page: The Vinaya harness (what Vinaya is,
 * install and remove, the five features, the Dev Process contract that runs
 * across them, and every command you run) and The Vinaya process (the default
 * Dev Process implementation, with an Integration section for how it
 * fulfils that contract).
 * Every Linear initiative has one page here with Linear's name; pages Linear
 * does not have are reader pages (getting started, references, how-tos). See
 * `design/docs-structure.md`.
 *
 * Only what a person runs is documented. Commands the Operator and the agents
 * call (task run, pr create, review post and the rest) are not listed.
 */

/** A docs page. `source` names the Markdown file in `src/content/docs-tree/` that renders it; a page without one is hand-written. */
export type DocsPage = { title: string; href: string; line: string; source?: string; children?: DocsPage[] }
/** A titled group of pages in a docs set's sidebar. */
type DocsSection = { title: string; pages: DocsPage[] }
/** One docs set, with its own sidebar and its entry page at `href`. `prefixes` are other paths it owns. */
export type DocsGroup = {
  id: 'start' | 'process'
  title: string
  href: string
  prefixes?: string[]
  line: string
  sections: DocsSection[]
}

/** A Markdown-backed child page under `base`. */
const md = (base: string, slug: string, title: string, line: string, source: string): DocsPage => ({
  title,
  href: `${base}/${slug}`,
  line,
  source
})

const S = '/docs/start'
const F = '/docs/features'
const C = `${S}/cli`
const D = '/docs/dev-process'
const P = '/docs/process'
const I = `${P}/integration`

export const DOCS_NAV: DocsGroup[] = [
  {
    id: 'start',
    title: 'The Vinaya harness',
    href: S,
    prefixes: [F, D],
    line: 'What Vinaya is, the five features, the Dev Process that runs across them, and every command you run',
    sections: [
      {
        title: 'Start',
        pages: [
          { title: 'Overview', href: S, line: 'What Vinaya is, and the two docs', source: 'start-overview.md' },
          md(S, 'get-started', 'Get started', 'Install, upgrade, check, remove', '1.1.0-get-started.md')
        ]
      },
      {
        title: 'Features',
        pages: [
          {
            title: 'About features',
            href: F,
            line: 'What a feature is, and the five',
            source: '1.1-features.md'
          },
          {
            title: 'Log',
            href: `${F}/log`,
            line: 'Every governed act, delivered live',
            source: '1.1.1-log.md',
            children: [
              md(
                `${F}/log`,
                'event-contract',
                'Event contract',
                'Families, header, schema versions',
                '1.1.1.1-event-contract.md'
              ),
              md(`${F}/log`, 'delivery', 'Delivery', 'Folder or server, live, never the forge', '1.1.1.2-delivery.md'),
              md(
                `${F}/log`,
                'custom-events',
                'Custom events',
                "A team's own declared events",
                '1.1.1.3-custom-events.md'
              ),
              md(
                `${F}/log`,
                'redaction-and-trust',
                'Redaction and trust',
                'Secrets, provenance, trusted destination',
                '1.1.1.5-redaction-and-trust.md'
              )
            ]
          },
          {
            title: 'Telemetry',
            href: `${F}/telemetry`,
            line: 'The record, counted: cost, time, review strictness',
            source: 'telemetry.md'
          },
          {
            title: 'Studio',
            href: `${F}/studio`,
            line: 'The readers of the record',
            source: '1.1.2-studio.md',
            children: [
              md(
                `${F}/studio`,
                'mission-control',
                'Mission Control',
                'The live view of work in flight',
                '1.1.2.1-mission-control.md'
              ),
              md(
                `${F}/studio`,
                'dashboard-and-statistics',
                'Dashboard and statistics',
                'Planned work and measures',
                '1.1.2.2-dashboard-and-statistics.md'
              ),
              md(
                `${F}/studio`,
                'many-repositories',
                'Many repositories',
                'One Studio across repositories',
                '1.1.2.3-many-repositories.md'
              )
            ]
          },
          {
            title: 'Self-improvement',
            href: `${F}/self-improvement`,
            line: 'The Log turns runs into proposals; the Principal approves',
            source: '1.1.4-self-improvement.md'
          },
          {
            title: 'Configuration',
            href: `${F}/configuration`,
            line: 'The harness keys of vinaya.config.json',
            source: '1.1.5-configuration.md',
            children: [
              md(
                `${F}/configuration`,
                'the-file-and-its-keys',
                'The file and its keys',
                'Every key, its owner and default',
                '1.1.5.1-the-file-and-its-keys.md'
              ),
              md(`${F}/configuration`, 'trust', 'Trust', 'What is read from the default branch', '1.1.5.2-trust.md'),
              md(
                `${F}/configuration`,
                'setup-commands',
                'Setup commands',
                'init, doctor, upgrade, eject',
                '1.1.5.3-setup-commands.md'
              )
            ]
          }
        ]
      },
      {
        title: 'Dev Process',
        pages: [
          {
            title: 'Overview',
            href: `${D}/overview`,
            line: 'The contract that runs across the features',
            source: '1.1.3-dev-process.md'
          },
          md(
            D,
            'process-contract',
            'Process contract',
            'What every process must define, including the generic gates',
            '1.1.3.1-process-contract.md'
          ),
          md(D, 'adapters', 'Adapters', 'Runtime, tracker, code host, Log destination', '1.1.3.2-adapters.md'),
          md(D, 'loader', 'Loader', 'Install, pin, upgrade, resume', '1.1.3.3-loader.md'),
          md(D, 'conformance', 'Conformance', 'Proving a different process runs unchanged', '1.1.3.4-conformance.md'),
          md(D, 'logging', 'Logging', 'What a process supplies so the Log records its runs', 'dev-process-logging.md')
        ]
      },
      {
        title: 'CLI',
        pages: [
          {
            title: 'Harness commands',
            href: C,
            line: 'Install, gates, the Log, Studio and rulings, help',
            source: '1.1.6-cli.md'
          },
          md(C, 'vinaya-process', 'Vinaya process commands', 'The three agent commands', 'cli-vinaya-process.md')
        ]
      }
    ]
  },
  {
    id: 'process',
    title: 'The Vinaya process',
    href: P,
    line: 'The default Dev Process: its integration, stages, gates, roles and guides',
    sections: [
      {
        title: 'Start',
        pages: [
          {
            title: 'Overview',
            href: P,
            line: 'The process from product work to merge and back',
            source: '1.2-overview.md'
          }
        ]
      },
      {
        title: 'Integration',
        pages: [
          md(
            I,
            'process-contract',
            'Process contract',
            'The six elements, identities, declarations',
            'integration-process-contract.md'
          ),
          md(I, 'adapters', 'Adapters', 'GitHub, claude or codex, the Log destination', 'integration-adapters.md'),
          md(I, 'loader', 'Loader', 'Package, selection, pinning', 'integration-loader.md'),
          md(I, 'conformance', 'Conformance', 'When Vinaya conforms', 'integration-conformance.md'),
          md(I, 'logging', 'Logging', 'Event types mapped to the generic families', 'integration-logging.md')
        ]
      },
      {
        title: 'Parts',
        pages: [
          {
            title: 'Thinking',
            href: `${P}/thinking`,
            line: 'What enters execution',
            source: '1.2.1-thinking.md',
            children: [
              md(
                `${P}/thinking`,
                'goals-and-milestones',
                'Goals and milestones',
                'The Architect and the Goal',
                '1.2.1.1-goals-and-milestones.md'
              ),
              md(
                `${P}/thinking`,
                'tranches-and-tasks',
                'Tranches and tasks',
                'The Planner, tranches and Issues',
                '1.2.1.2-tranches-and-tasks.md'
              ),
              md(`${P}/thinking`, 'issue-kinds', 'Issue kinds', 'Planned, backlog, hot', '1.2.1.3-issue-kinds.md'),
              md(
                `${P}/thinking`,
                'readiness-and-frozen-brief',
                'Readiness and the frozen brief',
                'Checked facts and the brief',
                '1.2.1.4-readiness-and-frozen-brief.md'
              )
            ]
          },
          {
            title: 'Executing',
            href: `${P}/executing`,
            line: 'One Issue in, one mergeable pull request out',
            source: '1.2.2-executing.md',
            children: [
              md(`${P}/executing`, 'the-loop', 'The loop', 'Developer, reviewers, rounds', '1.2.2.1-the-loop.md'),
              md(`${P}/executing`, 'batches', 'Batches', 'Many Issues within capacity', '1.2.2.2-batches.md'),
              md(`${P}/executing`, 'hot-mode', 'Hot mode', 'The Principal and an agent, live', '1.2.2.3-hot-mode.md'),
              md(
                `${P}/executing`,
                'the-operator',
                'The Operator',
                'Six tools to run a task',
                '1.2.2.4-the-operator.md'
              ),
              md(
                `${P}/executing`,
                'pauses-and-rulings',
                'Pauses and rulings',
                'Who acts when a run stops',
                '1.2.2.5-pauses-and-rulings.md'
              ),
              md(
                `${P}/executing`,
                'parent-and-integration-branches',
                'Parent and integration branches',
                'Where work lands',
                '1.2.2.6-parent-and-integration-branches.md'
              )
            ]
          },
          {
            title: 'Retrospecting',
            href: `${P}/retrospecting`,
            line: 'Archiving after merge',
            source: '1.2.3-retrospecting.md',
            children: [
              md(`${P}/retrospecting`, 'task-close', 'Task close', 'The Archivist on merge', '1.2.3.1-task-close.md'),
              md(
                `${P}/retrospecting`,
                'tranche-and-milestone-close',
                'Tranche and Milestone close',
                'The Tranche Archivist',
                '1.2.3.2-tranche-and-milestone-close.md'
              ),
              md(`${P}/retrospecting`, 'ring2-audits', 'Ring 2 audits', 'Drift after merge', '1.2.3.3-ring2-audits.md')
            ]
          },
          {
            title: 'Gates',
            href: `${P}/gates`,
            line: 'The rings and all 37 checks',
            source: '1.2.4-gates.md',
            children: [
              md(
                `${P}/gates`,
                'ring0-commit-checks',
                'Ring 0 commit checks',
                'Eleven checks at commit',
                '1.2.4.1-ring0-commit-checks.md'
              ),
              md(
                `${P}/gates`,
                'ring0-push-checks',
                'Ring 0 push checks',
                'Fourteen checks at push',
                '1.2.4.2-ring0-push-checks.md'
              ),
              md(
                `${P}/gates`,
                'ring1-pull-request-checks',
                'Ring 1 pull request checks',
                'Seven checks on the pull request',
                '1.2.4.3-ring1-pull-request-checks.md'
              ),
              md(
                `${P}/gates`,
                'ring1-issue-checks',
                'Ring 1 Issue checks',
                'Five checks at Issue write',
                '1.2.4.4-ring1-issue-checks.md'
              ),
              md(
                `${P}/gates`,
                'mechanisms-outside-the-registry',
                'Mechanisms outside the registry',
                'Hooks, workflows and audits beyond the 37 checks',
                '1.2.4.5-gate-mechanisms.md'
              )
            ]
          }
        ]
      },
      {
        title: 'Using it',
        pages: [
          { title: 'Roles', href: `${P}/roles`, line: 'Who does what, and the hand-offs', source: '1.2.5-roles.md' },
          {
            title: 'Working with it',
            href: `${P}/working-with-it`,
            line: 'The three commands, rulings, Studio',
            source: '1.2.6-working-with-it.md'
          }
        ]
      },
      {
        title: 'Guides',
        pages: [
          md(
            `${P}/guides`,
            'from-a-goal',
            'Deploy complex work',
            'Complex work: a milestone, tranches, many tasks',
            'guide-from-a-goal.md'
          ),
          md(
            `${P}/guides`,
            'from-a-tranche',
            'Deploy medium work',
            'Medium work: one feature, several tasks',
            'guide-from-a-tranche.md'
          ),
          md(
            `${P}/guides`,
            'from-one-issue',
            'Deploy backlog issues',
            'A single fix as a backlog Issue',
            'guide-from-one-issue.md'
          ),
          md(
            `${P}/guides`,
            'hot-issue',
            'Deploy hot issue now',
            'Hot mode: you and one agent, live',
            'guide-hot-issue.md'
          )
        ]
      },
      {
        title: 'Reference',
        pages: [
          { title: 'Checks catalog', href: `${P}/checks`, line: 'All 37 checks, filterable' },
          {
            title: 'Events',
            href: `${P}/events`,
            line: 'Every Log event Vinaya records',
            source: '1.2-log-event-reference.md'
          },
          {
            title: 'Vinaya keys',
            href: `${P}/vinaya-keys`,
            line: 'The process keys of vinaya.config.json',
            source: '1.2.7-vinaya-keys.md'
          },
          {
            title: 'Glossary',
            href: `${P}/glossary`,
            line: 'Plain definitions of the words the docs use',
            source: 'glossary.md'
          }
        ]
      }
    ]
  }
]

/** The harness commands, in the order a team meets them. */
export const HARNESS_COMMANDS: string[][] = [
  ['quickstart', 'init', 'upgrade', 'doctor', 'eject'],
  ['check', 'new check', 'new noop-check', 'waiver'],
  ['log selftest', 'log send', 'sync'],
  ['studio', 'pr rule'],
  ['demo break', 'help', 'version']
]

/** Top-level config keys by half; nested keys follow their parent. Removed keys are not shown. */
export const HARNESS_KEYS = ['logs', 'runtimeDir', 'dispatch', 'principals', 'releaseActor', 'managed', 'ci', 'tokens']
export const PROCESS_KEYS = [
  'roles',
  'briefSchema',
  'reviewPolicy',
  'planning',
  'projects',
  'blastRadius',
  'checks',
  'rings',
  'prePush',
  'securityScan',
  'gateCutovers',
  'proseGates',
  'decisionRecords',
  'report'
]

export const topKey = (key: string) => key.split('.')[0] ?? key

/** Every docs page in reading order: the two sets in turn, each page followed by its children. */
export const DOCS_PAGES: (DocsPage & { group: DocsGroup; section: string; parent?: DocsPage })[] = DOCS_NAV.flatMap(
  (group) =>
    group.sections.flatMap((section) =>
      section.pages.flatMap((page) => [
        { ...page, group, section: section.title },
        ...(page.children ?? []).map((child) => ({ ...child, group, section: section.title, parent: page }))
      ])
    )
)

/** The docs set a path belongs to; any other path shows Start. */
export const groupForPath = (path: string) =>
  DOCS_NAV.find((g) => [g.href, ...(g.prefixes ?? [])].some((p) => path === p || path.startsWith(`${p}/`))) ??
  DOCS_NAV[0]

/** The page at `href`, with its group and, for a child page, its parent. */
export const findDocsPage = (href: string) => DOCS_PAGES.find((p) => p.href === href)

/** The page before and after `href` in its docs set's reading order, for the pager at a page's end. */
export function pageNeighbours(href: string) {
  const page = findDocsPage(href)
  const pages = DOCS_PAGES.filter((p) => p.group === page?.group)
  const i = pages.findIndex((p) => p.href === href)
  return { prev: i > 0 ? pages[i - 1] : undefined, next: i >= 0 ? pages[i + 1] : undefined }
}

/** The anchor id of a section heading, shared by the heading and the page's contents list. */
export const sectionId = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
