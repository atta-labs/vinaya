'use client'

import { StudioTable } from '@/process/components/StudioTable'
import { Group, Row, SectionHeader } from '../shell'

export function StudioSection() {
  return (
    <>
      <SectionHeader slug='studio' />
      <Group name='StudioTable'>
        <Row label='mid-tranche'>
          <StudioTable
            tone='exec'
            rows={[
              {
                task: '[checkout-v2/1] 1',
                issue: 418,
                pr: '#1468',
                state: 'published · merged',
                round: '1',
                phase: 'done',
                gate: 'green'
              },
              {
                task: '[checkout-v2/1] 2',
                issue: 419,
                pr: '—',
                state: 'running',
                round: '1',
                phase: 'developing',
                gate: 'ring 0'
              },
              {
                task: '[checkout-v2/1] 3',
                issue: 420,
                pr: '—',
                state: 'frozen · not started',
                round: '—',
                phase: '—',
                gate: '—'
              }
            ]}
          />
        </Row>
        <Row label='hot'>
          <StudioTable
            tone='hot'
            rows={[
              { task: '—', issue: 1001, pr: '#1472', state: 'merged', round: 'hot', phase: 'done', gate: 'green' }
            ]}
          />
        </Row>
      </Group>
    </>
  )
}
