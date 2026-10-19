import { Heading, Text } from '@/ui/shared'
import { RevealGrid } from './LandingInteractions'
import { LandingSection } from './LandingSection'
import { HOME_FRAME, HomeHead } from './PortalSections'

// Who it's for: three readers, each under an ink rule.
export function AudienceSection() {
  const audiences = [
    [
      'For the engineer',
      'You ship the feature',
      'You define the milestone and ground it in tasks. Agents write and review. You control the merge.'
    ],
    ['For the tech lead', 'Your standards, enforced', 'Your standards become checks every pull request must pass.'],
    ['For the founder', 'One process', 'The feature lands through one process, so you can still answer why it shipped.']
  ] as const

  return (
    <LandingSection background='bg-secondary text-secondary-foreground' py='compact' className={HOME_FRAME}>
      <div className='flex flex-col gap-10 sm:gap-16'>
        <HomeHead title='Who it’s for' />
        <RevealGrid className='grid gap-10 min-[900px]:grid-cols-3 min-[900px]:gap-[clamp(2.5rem,4vw,4rem)]'>
          {audiences.map(([overline, title, body], index) => (
            <div
              key={overline}
              className={`flex translate-y-6 flex-col gap-3.5 border-t border-foreground pt-6 opacity-0 transition-[opacity,transform] duration-700 ease-out group-data-[visible=true]/reveal:translate-y-0 group-data-[visible=true]/reveal:opacity-100 motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none sm:gap-[18px] sm:pt-7 ${index === 1 ? 'delay-[140ms]' : index === 2 ? 'delay-[280ms]' : ''}`}
            >
              <Text variant='eyebrow' size='sm' tone='muted'>
                {overline}
              </Text>
              <Heading level={3} weight='normal' variant='title'>
                {title}
              </Heading>
              <Text variant='lead' tone='muted'>
                {body}
              </Text>
            </div>
          ))}
        </RevealGrid>
      </div>
    </LandingSection>
  )
}
