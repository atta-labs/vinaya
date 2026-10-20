import type { ReactNode } from 'react'
import { Heading, Text } from '@/ui/shared'
import { ButtonLink } from './ButtonLink'
import { FeatureSections } from './FeatureSections'
import { LandingSection } from './LandingSection'

// Home's section frame: the board's 1312px column with its 16-64px gutter and its 80-136px rhythm.
export const HOME_FRAME =
  'max-w-[82rem] px-[clamp(1rem,4.5vw,4rem)] py-20 sm:px-[clamp(1rem,4.5vw,4rem)] sm:py-[clamp(5rem,9vw,8.5rem)]'

/** A Home section's head: the title, and its line beside it on a wide screen, under it on a phone. */
export function HomeHead({
  title,
  line,
  inverted = false
}: {
  title: ReactNode
  line?: ReactNode
  /** On the dark band: the line keeps the band's ink, dimmed. */
  inverted?: boolean
}) {
  return (
    <div className='flex flex-col gap-4 min-[900px]:flex-row min-[900px]:flex-wrap min-[900px]:items-end min-[900px]:justify-between min-[900px]:gap-x-16 min-[900px]:gap-y-6'>
      <Heading level={2} weight='normal' variant='headline'>
        {title}
      </Heading>
      {line ? (
        <Text variant='lead' tone={inverted ? undefined : 'muted'} className={inverted ? 'opacity-70' : undefined}>
          {line}
        </Text>
      ) : null}
    </div>
  )
}

// What you get: the five features, one full-width section each, opened by their heading and index (`FeatureSections`).
export function FeaturesSection() {
  return <FeatureSections />
}

const STAGES = [
  ['Thinking', 'The Architect turns product work into one milestone'],
  ['Planning', 'The Planner writes every task as an Issue'],
  ['Executing', 'Agents build and review in parallel, every gate runs'],
  ['Self-improvement', 'A report shows where time went and proposes what to fix next']
] as const

// The default process: a dark band, its four stages numbered in the orange, the theme's ring (each is where a person decides),
// and the two ways in.
export function ProcessStripSection() {
  return (
    <LandingSection background='bg-primary text-primary-foreground' py='compact' className={HOME_FRAME}>
      <div className='flex flex-col gap-11 sm:gap-[4.5rem]'>
        <HomeHead title='The Vinaya process' line='The default process, installed with the harness' inverted />
        <ol className='grid gap-8 min-[900px]:grid-cols-4 min-[900px]:gap-10'>
          {STAGES.map(([name, line], i) => (
            <li
              key={name}
              className='grid grid-cols-[4rem_minmax(0,1fr)] gap-4 border-t-[1.5px] border-ring pt-6 min-[900px]:flex min-[900px]:flex-col min-[900px]:pt-8'
            >
              <Text as='span' variant='figure' family='mono' tone='accent'>
                0{i + 1}
              </Text>
              <div className='flex flex-col gap-2 min-[900px]:mt-4 min-[900px]:gap-4'>
                <Heading level={3} weight='normal' variant='title'>
                  {name}
                </Heading>
                <Text variant='lead' className='opacity-70'>
                  {line}
                </Text>
              </div>
            </li>
          ))}
        </ol>
        <div className='flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-4'>
          <ButtonLink href='/vinaya-process/diagram' variant='inverse-outline' size='xl' className='w-full sm:w-auto'>
            See the whole diagram
          </ButtonLink>
        </div>
      </div>
    </LandingSection>
  )
}

// Underneath: the runtime, one line.
export function EngineSection() {
  return (
    <LandingSection
      background='bg-background text-foreground'
      py='compact'
      center
      className='max-w-[82rem] px-4 py-[4.5rem] sm:px-[clamp(1rem,4.5vw,4rem)] sm:py-[clamp(5rem,9vw,8rem)]'
    >
      <Text variant='intro' tone='muted' className='mx-auto max-w-[55rem]'>
        Underneath the loop runs <span className='text-foreground'>Atta Engine</span>, the generic workflow runtime:
        checkpoints, halt and resume, recovery. It holds no Vinaya policy.
      </Text>
    </LandingSection>
  )
}
