import { VinayaHeroEmblem } from '../hero-canvas/VinayaHeroEmblem'
import { AudienceSection } from './AudienceSection'
import { ButtonLink } from './ButtonLink'
import { EngineSection, FeaturesSection, ProcessStripSection } from './PortalSections'
import { ZeroLockInSection } from './ZeroLockInSection'

interface ReleaseMetrics {
  version: string
  executableLines: number
  doctrineLines: number
}

// The hero buttons: side by side, sharing the row on a phone, their own width from tablet up.
const HERO_BUTTON = 'min-w-0 flex-1 sm:flex-none'

function HeroSection() {
  return (
    <VinayaHeroEmblem
      landingActions={
        <div className='flex w-full max-w-[22.375rem] flex-row gap-3 sm:w-auto sm:max-w-none sm:justify-center sm:gap-4'>
          <ButtonLink href='/vinaya-process' size='xl' className={HERO_BUTTON}>
            See the process
          </ButtonLink>
          <ButtonLink href='/start' variant='outline' size='xl' className={HERO_BUTTON}>
            Install
          </ButtonLink>
        </div>
      }
    />
  )
}

/**
 * Home: what Vinaya is, once, top to bottom. The hero, who it is for, the five features,
 * the default process, in and out with one command, the engine
 * underneath. Each feature has its own page; the process has its own walk.
 */
// `releaseMetrics` is unused: nothing on Home renders it. Drop this prop together with the
// `getPublishedReleaseMetrics` fetch in `(site)/page.tsx` that supplies it.
export function LandingPage(_props: { releaseMetrics: ReleaseMetrics }) {
  return (
    <main>
      <HeroSection />
      <FeaturesSection />
      <AudienceSection />
      <ProcessStripSection />
      <ZeroLockInSection />
      <EngineSection />
    </main>
  )
}
