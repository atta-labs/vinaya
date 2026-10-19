import { FeaturePage } from '../_components/feature-page/FeaturePage'
import { ConfigLive } from '../_components/feature-page/live'
import { ConfigurationIcon, SetupCommandsIcon, TrustIcon } from '../_components/icons'

export const metadata = { title: 'Configuration · Vinaya' }

export default function ConfigurationPage() {
  return (
    <FeaturePage
      n={5}
      name='Configuration'
      icon={(className) => <ConfigurationIcon className={className} />}
      lead='One file, vinaya.config.json, sets it all up. An empty file is a full harness; add a key only to change what runs.'
      tags={['vinaya.config.json', 'All optional', 'Harness keys', 'Trust anchor']}
      docsHref='/docs/features/configuration'
      command='vinaya init'
      liveLabel='A vinaya.config.json'
      live={<ConfigLive />}
      shows={{
        eyebrow: 'How it works',
        title: 'One file, reviewed like any other',
        items: [
          {
            title: 'The file and its keys',
            line: 'Every top-level key: who owns it, what it sets, and what happens when you leave it out.',
            href: '/docs/features/configuration/the-file-and-its-keys',
            icon: (className) => <ConfigurationIcon className={className} />
          },
          {
            title: 'Trust',
            line: 'Keys that decide who may merge are read from the default branch, never from the pull request.',
            href: '/docs/features/configuration/trust',
            icon: (className) => <TrustIcon className={className} />
          },
          {
            title: 'Setup commands',
            line: 'init installs, doctor diagnoses, upgrade regenerates, eject reverses the install exactly.',
            href: '/docs/features/configuration/setup-commands',
            icon: (className) => <SetupCommandsIcon className={className} />
          }
        ]
      }}
      never={{
        eyebrow: 'What it never does',
        title: (
          <>
            It declares.
            <br />
            It never runs code.
          </>
        ),
        lead: 'It selects and parameterizes what is installed. Reviewed like any other file, it is the audit trail.',
        items: [
          ['No code.', 'It cannot load code, grant authority, or switch off a protection.'],
          ['No self-rewrite.', 'A change cannot rewrite its own rules: sensitive keys come from the default branch.'],
          ['No silent loss.', 'A removed key is refused loudly, naming the one that replaced it.']
        ]
      }}
      use={{
        title: 'Start with an empty file',
        line: 'init writes a starter and records what it installed. Add a key only when you need it.',
        code: ['$ vinaya init', '$ vinaya doctor']
      }}
      prev={{ n: 4, name: 'Self-improvement', href: '/self-improvement' }}
    />
  )
}
