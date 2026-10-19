'use client'

import { ChatWindow } from '@/process/components/ChatWindow'
import { LogTerminal } from '@/process/components/LogTerminal'
import { ScrubLetters } from '@/process/components/ScrubLetters'
import { execLines, StepHeader, StepView } from '@/process/components/StepSection'
import { flows } from '@/process/fixtures'
import { noteFor } from '@/process/fixtures/notes'
import { checkout1 } from '@/process/flows/complex/flow'
import { replay } from '@/process/replay'
import type { Step } from '@/process/types'
import { defaultEnvironment } from '@/process/types'
import { Heading } from '@/ui/shared'
import { Group, Row, SectionHeader } from '../shell'

const feature = flows.feature
// The step that closes the work: its own archive step if the flow has one, else the step carrying the closing lines.
const closingStep = (feature.steps.find((s) => s.kind === 'archive') ??
  feature.steps.find((s) => s.closingLines)) as Step
const plannerStep = feature.steps.find((s) => s.stage === 'planner') as Step
const sampleLog = replay('feature', 'claude', { step: 3, progress: 0.5 }).log

export function StepsSection() {
  return (
    <>
      <SectionHeader slug='steps' />
      <Group name='StepHeader'>
        {feature.steps.slice(1, 4).map((s) => (
          <Row key={s.title} label={s.stage}>
            <StepHeader step={s} />
          </Row>
        ))}
        <Row label='with emphasis'>
          <StepHeader step={closingStep} />
        </Row>
      </Group>
      <Group name='StepView · driven by scroll progress'>
        {[0.25, 0.6, 1].map((p) => (
          <Row key={p} label={`progress ${p}`}>
            <div className='h-[760px]'>
              <StepView step={plannerStep} flow='feature' env={defaultEnvironment} progress={p} className='h-full' />
            </div>
          </Row>
        ))}
      </Group>
      <Group name='ScrubLetters · the note beside a step'>
        {[0.3, 0.7, 1].map((p) => (
          <Row key={p} label={`progress ${p}`}>
            <Heading level={2} size='2xl' weight='normal' leading='snug' className='max-w-[36ch]'>
              <ScrubLetters text={noteFor(plannerStep, 'feature')} progress={p} />
            </Heading>
          </Row>
        ))}
      </Group>
      <Group name='LogTerminal'>
        <Row label='mac'>
          <LogTerminal events={sampleLog} env={defaultEnvironment} />
        </Row>
        <Row label='linux'>
          <LogTerminal events={sampleLog} env={{ ...defaultEnvironment, os: 'linux' }} />
        </Row>
      </Group>
      <Group name='Derived lines'>
        <Row label='tranche · 3 tasks'>
          <ChatWindow surface='terminal' tone='exec' lines={execLines(checkout1.tasks, 'claude', checkout1.name)} />
        </Row>
        <Row label='archive'>
          <ChatWindow surface='terminal' tone='retro' lines={closingStep.closingLines ?? []} />
        </Row>
      </Group>
    </>
  )
}
