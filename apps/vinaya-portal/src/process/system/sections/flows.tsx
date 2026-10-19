'use client'

import { FLOW_NAMES, FLOW_ORDER, FlowOnlyDiagram, WholeProcessDiagram } from '@/process/diagram/ProcessFlows'
import { Group, SectionHeader } from '../shell'

/** The five still diagrams: each flow's own part, then the whole process. All built from the same stage layers. */
export function FlowsSection() {
  return (
    <>
      <SectionHeader slug='flows' />
      {FLOW_ORDER.map((flow) => (
        <Group key={flow} name={`${FLOW_NAMES[flow]} · its part only`}>
          <div className='overflow-hidden rounded-md border border-border'>
            <FlowOnlyDiagram flow={flow} />
          </div>
        </Group>
      ))}
      <Group name='The whole process · every flow'>
        <div className='overflow-hidden rounded-md border border-border'>
          <WholeProcessDiagram />
        </div>
      </Group>
    </>
  )
}
