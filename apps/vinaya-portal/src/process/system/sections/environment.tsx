'use client'

import { useState } from 'react'
import { FlowMenu } from '@/process/components/cards'
import { EnvironmentMenu, EnvironmentPickerDemo } from '@/process/components/Environment'
import { FlowChoice } from '@/process/components/StepSection'
import type { Environment, FlowKey } from '@/process/types'
import { defaultEnvironment } from '@/process/types'
import { Group, Row, SectionHeader } from '../shell'

function Menus() {
  const [env, setEnv] = useState<Environment>(defaultEnvironment)
  const [flow, setFlow] = useState<FlowKey>('feature')
  return (
    <div className='flex flex-wrap gap-2'>
      <FlowMenu flow={flow} onChange={setFlow} />
      <EnvironmentMenu env={env} onChange={setEnv} />
    </div>
  )
}

function FlowChoiceDemo() {
  const [flow, setFlow] = useState<FlowKey>('feature')
  return <FlowChoice flow={flow} onPick={setFlow} onBack={() => {}} onStart={() => {}} />
}

export function EnvironmentSection() {
  return (
    <>
      <SectionHeader slug='environment' />
      <Group name='Setup 1 · EnvironmentPicker'>
        <Row label='live'>
          <EnvironmentPickerDemo initial={defaultEnvironment} />
        </Row>
      </Group>
      <Group name='Setup 2 · FlowChoice'>
        <Row label='live'>
          <FlowChoiceDemo />
        </Row>
      </Group>
      <Group name='Top-bar menus · FlowMenu, EnvironmentMenu'>
        <Row label='live'>
          <Menus />
        </Row>
      </Group>
    </>
  )
}
