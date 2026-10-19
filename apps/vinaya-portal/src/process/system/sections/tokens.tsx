'use client'

import { Eyebrow, Pill } from '@/process/components/primitives'
import { toneBg, toneText } from '@/process/tone'
import type { Tone } from '@/process/types'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import { Group, Row, SectionHeader } from '../shell'

const tones: Tone[] = ['product', 'think', 'exec', 'retro', 'hot', 'log']
const surfaces = ['background', 'card', 'secondary', 'muted', 'popover', 'input'] as const
const inks = ['foreground', 'muted-foreground', 'primary', 'destructive'] as const
const charts = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const

const toneRole: Record<Tone, string> = {
  product: 'outside Vinaya: Linear, Jira, the need · chart-5',
  think: 'upstream, Architect, Planner · chart-3',
  exec: 'loop, gates, merge · chart-4',
  retro: 'archive, Improver · chart-2',
  hot: 'hot Issue, hot mode · destructive',
  log: 'the Log, Studio · primary'
}

export function TokensSection() {
  return (
    <>
      <SectionHeader slug='' />
      <Group name='Theme · surfaces'>
        <div className='grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6'>
          {surfaces.map((s) => (
            <div key={s} className={`grid gap-1 rounded-md border border-border p-2 bg-${s}`}>
              <div className='h-10' />
              <span className='font-mono text-xs text-foreground'>{s}</span>
            </div>
          ))}
        </div>
      </Group>
      <Group name='Theme · inks and charts'>
        <div className='flex flex-wrap gap-2'>
          {inks.map((i) => (
            <span key={i} className={`font-mono text-sm text-${i}`}>
              {i}
            </span>
          ))}
        </div>
        <div className='grid grid-cols-5 gap-3'>
          {charts.map((c) => (
            <div key={c} className='grid gap-1'>
              <div className={`h-8 rounded-md bg-${c}`} />
              <span className='font-mono text-xs text-muted-foreground'>{c}</span>
            </div>
          ))}
        </div>
      </Group>
      <Group name='Stage palette · theme tokens per stage'>
        <Row label='tones'>
          <div className='grid gap-2 md:grid-cols-5'>
            {tones.map((t) => (
              <div key={t} className='grid gap-1 rounded-md border border-border p-2'>
                <div className={cn('h-8 rounded', toneBg[t])} />
                <span className={cn('font-mono text-xs', toneText[t])}>{t}</span>
                <span className='text-xs text-muted-foreground'>{toneRole[t]}</span>
              </div>
            ))}
          </div>
        </Row>
        <Row label='eyebrow'>
          <Eyebrow>Muted eyebrow</Eyebrow>
          {tones.map((t) => (
            <Eyebrow key={t} tone={t}>
              Stage · {t}
            </Eyebrow>
          ))}
        </Row>
        <Row label='pill'>
          <div className='flex flex-wrap gap-2'>
            <Pill>idle</Pill>
            {tones.map((t) => (
              <Pill key={t} tone={t} lit>
                {t}
              </Pill>
            ))}
          </div>
        </Row>
      </Group>
      <Group name='Library primitives · animate'>
        <Row label='button'>
          <div className='flex flex-wrap gap-2'>
            <Button>Default</Button>
            <Button variant='secondary'>Secondary</Button>
            <Button variant='outline'>Outline</Button>
            <Button variant='ghost'>Ghost</Button>
            <Button variant='destructive'>Destructive</Button>
            <Button size='sm'>Small</Button>
          </div>
        </Row>
        <Row label='badge'>
          <div className='flex flex-wrap gap-2'>
            <Badge>Default</Badge>
            <Badge variant='secondary'>Secondary</Badge>
            <Badge variant='outline'>Outline</Badge>
            <Badge variant='destructive'>Destructive</Badge>
          </div>
        </Row>
        <Row label='card'>
          <Card className='max-w-sm'>
            <CardHeader>
              <CardTitle size='md'>Card title</CardTitle>
            </CardHeader>
            <CardContent>
              <Text size='sm' tone='muted'>
                The library card; every diagram card is built on it.
              </Text>
            </CardContent>
          </Card>
        </Row>
      </Group>
    </>
  )
}
