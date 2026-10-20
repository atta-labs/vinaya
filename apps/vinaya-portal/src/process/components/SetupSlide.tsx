'use client'

import type { ReactNode, Ref } from 'react'
import { cn } from '@/ui/lib/utils'
import { Heading } from '@/ui/shared'
import { Eyebrow } from './primitives'

/** How many setup slides there are. */
const SETUP_STEPS = 2

/** The step indicator beside the eyebrow: one segment per step, filled up to `n`, the newest filling from the left. */
function StepSegments({ n }: { n: number }) {
  return (
    <span aria-hidden='true' className='flex gap-[0.333rem]'>
      {Array.from({ length: SETUP_STEPS }, (_, i) => (
        <span key={i} className='relative h-[3px] w-[1.778rem] bg-border/40 md:w-[2.222rem]'>
          <span
            className={cn(
              'absolute inset-0 origin-left bg-foreground transition-transform duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
              i < n ? 'scale-x-100' : 'scale-x-0'
            )}
          />
        </span>
      ))}
    </span>
  )
}

/**
 * One setup slide, laid out at real size (no scaling): the step and the title on top, the content under them, and a
 * footer that sticks to the bottom of the screen with the buttons, the primary one last. Phone under 768, tablet
 * 768-1279, desktop from 1280 (content at most 1200 wide, 64px of padding). Sizes are in rem against the site's
 * 18px root, so each one is the board's pixel value.
 *
 * `contentRef` is the part that moves between steps (the title and the content); the header line and the footer stay
 * put. `headingRef` takes focus when a step arrives, so screen readers announce it.
 */
export function SetupSlide({
  n,
  title,
  actions,
  children,
  contentRef,
  headingRef,
  className
}: {
  n: number
  title: string
  actions: ReactNode
  children: ReactNode
  contentRef?: Ref<HTMLDivElement>
  headingRef?: Ref<HTMLHeadingElement>
  className?: string
}) {
  return (
    <div className={cn('flex min-h-[calc(100dvh-3.5rem)] flex-col', className)}>
      <div className='flex-1 px-4 pt-[1.333rem] pb-[1.778rem] md:px-[1.778rem] md:py-[2.222rem] xl:px-[3.556rem] xl:pt-[3.556rem] xl:pb-[2.667rem]'>
        <div className='mx-auto w-full max-w-[66.667rem]'>
          <div className='flex items-center gap-[0.889rem]'>
            <Eyebrow tone='think'>
              Setup · {n} of {SETUP_STEPS}
            </Eyebrow>
            <StepSegments n={n} />
          </div>
          <div ref={contentRef}>
            <Heading
              ref={headingRef}
              level={1}
              tabIndex={-1}
              size='4xl'
              leading='tight'
              className='mt-[0.556rem] outline-none md:mt-[0.667rem]'
            >
              {title}
            </Heading>
            <div className='mt-[1.556rem] md:mt-[1.778rem] xl:mt-[2.222rem]'>{children}</div>
          </div>
        </div>
      </div>
      <div className='sticky bottom-0 z-10 border-t border-border/40 bg-background px-4 py-[0.667rem] md:px-[1.778rem] xl:px-[3.556rem] xl:py-[0.889rem]'>
        <div className='mx-auto flex w-full max-w-[66.667rem] justify-end gap-2'>{actions}</div>
      </div>
    </div>
  )
}
