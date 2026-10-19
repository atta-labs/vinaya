'use client'

import type { ComponentType } from 'react'
import { DiagramBand, DiagramCard, DiagramContainer } from '@/process/diagram/DiagramCard'
import { DiagramFrame, MomentProvider } from '@/process/diagram/links'
import { EventList, IssueChip, LoopBars, MiniChat, ProposalList, StatRow, TaskList } from '@/process/diagram/mocks'
import type { Moment, NodeState } from '@/process/diagram/moment'
import { type DiagramNode, nodes } from '@/process/diagram/nodes'
import {
  DevReviewLoop,
  Observability,
  Runtime,
  StageClosure,
  StageExecuting,
  StageGates,
  StageImprovement,
  type StageProps,
  StageRetrospecting,
  StageThinking,
  StageUpstream
} from '@/process/diagram/stages'
import { Group, Row, SectionHeader } from '../shell'

const states: NodeState[] = ['done', 'now', 'future', 'impossible', 'always']
const sample = nodes['planner-tranche'] as DiagramNode
const compact = nodes['rt-claude'] as DiagramNode
const long: DiagramNode = {
  id: 'long',
  tone: 'exec',
  title: 'A title far longer than any card can hold without truncating it somewhere sensible',
  tag: 'A TAG THAT IS ALSO MUCH TOO LONG FOR ITS SLOT',
  lines: [
    'A line of body text that runs on well past the width of the card and must clamp to two rows at most',
    '#a mono line that is just as long and must truncate too'
  ],
  flows: 'all',
  at: 'loop'
}

/** One stage component, its internal arrows drawn, at one moment. */
function StageDemo({ Stage, moment }: { Stage: ComponentType<StageProps>; moment: Moment }) {
  return (
    <DiagramFrame moment={moment} className='relative rounded-md border border-border bg-background p-4'>
      <Stage moment={moment} />
    </DiagramFrame>
  )
}

const stageList: [string, ComponentType<StageProps>, Moment, Moment][] = [
  ['StageUpstream', StageUpstream, { flow: 'feature', stage: 'upstream' }, { flow: 'hot', stage: 'archive' }],
  ['StageThinking', StageThinking, { flow: 'feature', stage: 'planner' }, { flow: 'hot', stage: 'loop' }],
  [
    'StageExecuting',
    StageExecuting,
    { flow: 'feature', stage: 'loop', gates: [2, 1, 0] },
    { flow: 'hot', stage: 'loop' }
  ],
  [
    'StageGates',
    StageGates,
    { flow: 'feature', stage: 'loop', gates: [2, 1, 0] },
    { flow: 'medium', stage: 'planner' }
  ],
  ['StageClosure', StageClosure, { flow: 'feature', stage: 'merge' }, { flow: 'backlog', stage: 'loop' }],
  [
    'StageRetrospecting',
    StageRetrospecting,
    { flow: 'feature', stage: 'archive' },
    { flow: 'backlog', stage: 'archive' }
  ],
  ['StageImprovement', StageImprovement, { flow: 'feature', stage: 'improve' }, { flow: 'hot', stage: 'loop' }]
]

export function DiagramElementsSection() {
  return (
    <div data-diagram='process'>
      <SectionHeader slug='diagram-elements' />
      <Group name='DiagramCard · five states'>
        <div className='grid gap-3 md:grid-cols-5'>
          {states.map((st) => (
            <div key={st} className='grid gap-1.5'>
              <span className='font-mono text-xs text-muted-foreground'>{st}</span>
              <DiagramCard node={sample} state={st} />
            </div>
          ))}
        </div>
      </Group>
      <Group name='DiagramCard · variants'>
        <Row label='compact'>
          <div className='grid max-w-lg grid-cols-2 gap-2'>
            <DiagramCard node={compact} />
            <DiagramCard node={{ ...compact, id: 'c2' }} state='now' />
          </div>
        </Row>
        <Row label='dashed'>
          <DiagramCard node={nodes['hot-issue'] as DiagramNode} className='max-w-xs' />
        </Row>
        <Row label='overflow'>
          <div className='grid max-w-md gap-2'>
            <DiagramCard node={long} />
            <DiagramCard node={long} className='max-w-[200px]' />
          </div>
        </Row>
      </Group>
      <Group name='DiagramBand'>
        <div className='grid gap-3'>
          <DiagramBand label='STAGE 1 · THINKING' tone='think' />
          <DiagramBand label='STAGE 2 · EXECUTING · lit' tone='exec' lit />
          <DiagramBand label='GATES · at every step, the doors to GitHub' tone='neutral' />
          <DiagramBand label='OBSERVABILITY & AUDITABILITY' tone='log' lit />
        </div>
      </Group>
      <Group name='DiagramContainer'>
        <div className='grid gap-3 md:grid-cols-2'>
          <DiagramContainer title='STAGE 2 · EXECUTING · lit' tone='exec'>
            <DiagramCard node={nodes.ring0 as DiagramNode} />
          </DiagramContainer>
          <DiagramContainer title='GATES · nested, unlit' tone='neutral' lit={false} soft>
            <DiagramCard node={nodes.ring1 as DiagramNode} />
          </DiagramContainer>
          <DiagramContainer title='OBSERVABILITY · dashed' tone='log' dashed>
            <DiagramCard node={nodes.log as DiagramNode} />
          </DiagramContainer>
          <DiagramContainer tone='think'>
            <DiagramCard node={nodes.architect as DiagramNode} />
          </DiagramContainer>
        </div>
      </Group>
      <Group name='Mocks'>
        <div className='grid gap-3 md:grid-cols-3'>
          <TaskList label='TR-02' tag='planned' items={['#418', '#419', '#420', '#421']} />
          <IssueChip n='#1001' tag='hot' title='Fix flaky CLI test now' tone='hot' />
          <MiniChat />
          <EventList />
          <LoopBars />
          <StatRow />
          <ProposalList />
        </div>
      </Group>
      <Group name='DevReviewLoop · Runtime'>
        <Row label='loop · now'>
          <DevReviewLoop moment={{ flow: 'feature', stage: 'loop' }} className='max-w-2xl' />
        </Row>
        <Row label='runtime · now'>
          <Runtime moment={{ flow: 'feature', stage: 'loop' }} />
        </Row>
      </Group>
      {stageList.map(([name, Stage, now, other]) => (
        <Group key={name} name={`${name} · now, and another moment`}>
          <div className='grid gap-4'>
            <StageDemo Stage={Stage} moment={now} />
            <StageDemo Stage={Stage} moment={other} />
          </div>
        </Group>
      ))}
      <Group name='Observability · alive: the Log and Mission Control follow the moment'>
        <div className='grid gap-4 md:grid-cols-3'>
          {(
            [
              ['feature · planner', { flow: 'feature', stage: 'planner' }],
              ['feature · loop', { flow: 'feature', stage: 'loop', gates: [2, 1, 0] }],
              ['hot · improve', { flow: 'hot', stage: 'improve', gates: [2, 2, 2], closed: true }]
            ] as [string, Moment][]
          ).map(([label, m]) => (
            <div key={label} className='grid min-w-0 gap-1.5'>
              <span className='font-mono text-xs text-muted-foreground'>{label}</span>
              <div className='h-[560px] min-w-0'>
                <MomentProvider moment={m}>
                  <Observability moment={m} />
                </MomentProvider>
              </div>
            </div>
          ))}
        </div>
      </Group>
    </div>
  )
}
