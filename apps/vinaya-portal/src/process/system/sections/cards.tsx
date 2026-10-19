'use client'

import { useState } from 'react'
import { ChoiceCard, Crumbs, GatePills, LogRail, OutputCard, ProposalCard, TaskChips } from '@/process/components/cards'
import { Banner, StatTiles } from '@/process/components/primitives'
import { flowList, flows } from '@/process/fixtures'
import { checkout1 } from '@/process/flows/complex/flow'
import type { GateState, Step, Tone } from '@/process/types'
import { RadioGroup } from '@/ui/components'
import { Group, Row, SectionHeader } from '../shell'

const improveStep = flows.feature.steps[flows.feature.steps.length - 1] as Step
const gateStates: GateState[] = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 1, 0],
  [2, 2, 2]
]
const tones: Tone[] = ['think', 'exec', 'retro', 'hot', 'log']

export function CardsSection() {
  const [created, setCreated] = useState(false)
  const [picked, setPicked] = useState<string>(flowList[0]?.key ?? '')
  return (
    <>
      <SectionHeader slug='cards' />
      <Group name='ChoiceCard'>
        <RadioGroup
          aria-label='Flow'
          value={picked}
          onValueChange={setPicked}
          className='grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-2.5'
        >
          {flowList.map((f) => (
            <ChoiceCard key={f.key} flow={f} pressed={f.key === picked} />
          ))}
        </RadioGroup>
      </Group>
      <Group name='OutputCard'>
        <Row label='milestone'>
          <OutputCard
            data={{
              kind: 'milestone',
              name: 'checkout-v2',
              branch: 'milestone/checkout-v2',
              intents: ['1 · charge once', '2 · pay in the apps', '3 · support tools']
            }}
          />
        </Row>
        <Row label='tranche'>
          <OutputCard data={{ kind: 'tranche', tranche: checkout1 }} />
        </Row>
        <Row label='tranche · status'>
          <OutputCard data={{ kind: 'tranche', tranche: checkout1 }} status={{ 418: 'done', 419: 'running' }} />
        </Row>
        <Row label='backlog issue'>
          <OutputCard
            data={{
              kind: 'issue',
              issue: 1000,
              title: 'Resume refuses kept work',
              surface: 'apps/cli/src/commands/resume.ts · 1 objective · test plan'
            }}
          />
        </Row>
        <Row label='hot issue'>
          <OutputCard
            data={{
              kind: 'issue',
              issue: 1001,
              title: 'Fix flaky CLI test',
              surface: 'objective: the test passes on CI · review: Principal decides',
              hot: true
            }}
          />
        </Row>
      </Group>
      <Group name='TaskChips'>
        <Row label='queued'>
          <TaskChips tasks={checkout1.tasks} />
        </Row>
        <Row label='mixed'>
          <TaskChips tasks={checkout1.tasks} status={{ 418: 'done', 419: 'running' }} />
        </Row>
        <Row label='done'>
          <TaskChips tasks={checkout1.tasks} status={{ 418: 'done', 419: 'done', 420: 'done' }} />
        </Row>
      </Group>
      <Group name='GatePills'>
        <div className='flex flex-wrap gap-6'>
          {gateStates.map((g) => (
            <GatePills key={g.join()} gates={g} />
          ))}
        </div>
      </Group>
      <Group name='LogRail'>
        <Row label='empty'>
          <LogRail events={[]} className='max-w-md' />
        </Row>
        <Row label='filling'>
          <LogRail
            className='max-w-md'
            total={42}
            events={[
              { name: 'forge_write.written', detail: 'op=milestone.create · checkout-v2', tone: 'think' },
              { name: 'dev_review_loop.loop_started', detail: '#418', tone: 'exec' },
              { name: 'gate.summary', detail: 'host=hook ran=31 failed=0', tone: 'exec' },
              { name: 'dev_review_loop.round_ended', detail: 'outcome=green', tone: 'exec' },
              { name: 'forge_write.written', detail: 'op=archive · #418', tone: 'retro' }
            ]}
          />
        </Row>
      </Group>
      <Group name='Banner · StatTiles · ProposalCard'>
        <Row label='banner'>
          <Banner tone='retro' title='Your Milestone is closed.'>
            Every act above is in the Log. Studio already shows it.
          </Banner>
          <Banner tone='hot' title='Hot Issue merged.' />
        </Row>
        <Row label='stats'>
          <StatTiles stats={improveStep.stats ?? []} />
        </Row>
        <Row label='proposal'>
          {improveStep.proposals?.map((p, i) => (
            <ProposalCard key={p.title} {...p} created={i === 0 ? created : false} onCreate={() => setCreated(true)} />
          ))}
        </Row>
      </Group>
      <Group name='Crumbs'>
        {(['upstream', 'thinking', 'executing', 'improve'] as const).map((a, i) => (
          <Row key={a} label={a}>
            <Crumbs active={a} tone={tones[i % tones.length] as Tone} />
          </Row>
        ))}
      </Group>
    </>
  )
}
