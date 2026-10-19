import { NextLink } from '@/ui/lib/next-link'
import { Heading, Text } from '@/ui/shared'
import { LabeledCommandCopy } from './LandingInteractions'
import { LandingSection } from './LandingSection'
import { WipeReveal } from './WipeReveal'

const QUICKSTART_COMMAND = 'npx @attalabs/vinaya quickstart'

// Zero lock-in. The install and the eject, side by side, centred in the band.
export function ZeroLockInSection() {
  return (
    <LandingSection
      background='bg-secondary text-secondary-foreground'
      py='compact'
      center
      className='flex max-w-[82rem] flex-col items-center justify-center px-4 py-24 sm:px-[clamp(1rem,4.5vw,4rem)] sm:py-[clamp(6rem,10vw,9.5rem)] min-[900px]:min-h-[53.75rem]'
    >
      <Text variant='eyebrow' size='sm' tone='muted'>
        Zero lock-in
      </Text>
      <Heading level={2} weight='normal' variant='display' className='mt-6 sm:mt-7'>
        <WipeReveal>In with one command</WipeReveal>
        <WipeReveal late>Out with one command</WipeReveal>
      </Heading>

      <div className='mt-12 flex w-full flex-col items-center justify-center gap-3 sm:mt-16 min-[900px]:w-auto min-[900px]:flex-row min-[900px]:gap-7'>
        <LabeledCommandCopy href='/docs/start/cli#command-quickstart' label='plug in' command={QUICKSTART_COMMAND} />
        <Text variant='figure' family='mono' tone='muted' className='py-3 min-[900px]:py-0 min-[900px]:pt-[2.125rem]'>
          <span className='min-[900px]:hidden'>⇅</span>
          <span className='hidden min-[900px]:inline'>⇄</span>
        </Text>
        <LabeledCommandCopy href='/docs/start/cli#command-eject' label='unplug' command='vinaya eject' />
      </div>
      <Text variant='lead' tone='muted' className='mt-10 max-w-[40rem] sm:mt-12'>
        Eject removes exactly what quickstart installed. Nothing else.
      </Text>
      <NextLink
        href='/docs/start/cli'
        variant='unstyled'
        className='mt-4 border-b-[1.5px] border-foreground py-2.5 text-lg font-medium sm:mt-5 sm:py-2 sm:text-lg'
      >
        See the CLI
      </NextLink>
    </LandingSection>
  )
}
