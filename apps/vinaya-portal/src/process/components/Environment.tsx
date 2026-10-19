'use client'

import { ArrowRight, Check, ChevronDown, MessageSquare, SquareTerminal } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button, Card, Popover, PopoverContent, PopoverTrigger, RadioGroup, RadioItem, Toggle } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { Text } from '@/ui/shared'
import type { Agent, Environment, LogServer, Mode, Os, Tracker } from '../types'
import { logServerLabel, sandboxOf, trackerLabel } from '../types'
import { type Brand, BrandIcon } from './BrandIcon'
import { Eyebrow } from './primitives'
import { SetupSlide } from './SetupSlide'

const osLabel: Record<Os, string> = { mac: 'macOS', linux: 'Linux / Unix' }
const agentLabel: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' }
const modeLabel: Record<Mode, string> = { terminal: 'the terminal', chat: 'the chat app' }
const modeShort: Record<Mode, string> = { terminal: 'Terminal', chat: 'Chat app' }
const osBrand: Record<Os, Brand> = { mac: 'apple', linux: 'linux' }
const agentBrand: Record<Agent, Brand> = { claude: 'claude', codex: 'codex' }

const describeEnvironment = (e: Environment) => `${agentLabel[e.agent]} · ${osLabel[e.os]} · ${modeLabel[e.mode]}`

type Choice = { key: string; icon: ReactNode; title: string; hint: string; on: boolean; pick: () => void }
export type Row = { label: string; choices: Choice[] }
/** One question group: a card in setup, a run of labelled rows in the top-bar popover. */
type Group = { key: string; label: string; title: string; rows: Row[] }

/** The environment questions, grouped. Setup shows one card per group; the popover shows every row. */
function groupsFor(value: Environment, onChange: (e: Environment) => void): Group[] {
  return [
    {
      key: 'os',
      label: 'Operating system',
      title: 'Runs in its sandbox',
      rows: [
        {
          label: 'Operating system',
          choices: (['mac', 'linux'] as Os[]).map((os) => ({
            key: os,
            icon: <BrandIcon brand={osBrand[os]} />,
            title: osLabel[os],
            hint: sandboxOf[os],
            on: value.os === os,
            pick: () => onChange({ ...value, os })
          }))
        }
      ]
    },
    {
      key: 'agent',
      label: 'Agent',
      title: 'Your subscription, in your CLI or chat app',
      rows: [
        {
          label: 'Agent',
          choices: (['claude', 'codex'] as Agent[]).map((agent) => ({
            key: agent,
            icon: <BrandIcon brand={agentBrand[agent]} />,
            title: agentLabel[agent],
            hint: 'subscription',
            on: value.agent === agent,
            pick: () => onChange({ ...value, agent })
          }))
        },
        {
          label: 'Where you drive it',
          choices: (['terminal', 'chat'] as Mode[]).map((mode) => ({
            key: mode,
            icon: mode === 'terminal' ? <SquareTerminal /> : <MessageSquare />,
            title: modeShort[mode],
            hint: mode === 'terminal' ? 'commands' : 'slash commands',
            on: value.mode === mode,
            pick: () => onChange({ ...value, mode })
          }))
        }
      ]
    },
    {
      key: 'tracker',
      label: 'Product management',
      title: 'Works with Linear and Jira',
      rows: [
        {
          label: 'Product management',
          choices: (['linear', 'jira'] as Tracker[]).map((tracker) => ({
            key: tracker,
            icon: <BrandIcon brand={tracker} />,
            title: trackerLabel[tracker],
            hint: tracker === 'linear' ? 'Projects' : 'Epics',
            on: value.tracker === tracker,
            pick: () => onChange({ ...value, tracker })
          }))
        }
      ]
    },
    {
      key: 'log',
      label: 'Log server',
      title: 'Sends the Log to your log server',
      rows: [
        {
          label: 'Log server',
          choices: (['cloudflare', 'grafana', 'datadog'] as LogServer[]).map((logServer) => ({
            key: logServer,
            icon: <BrandIcon brand={logServer} />,
            title: logServerLabel[logServer],
            hint: '',
            on: value.logServer === logServer,
            pick: () => onChange({ ...value, logServer })
          }))
        }
      ]
    }
  ]
}

/** One row of choices as library `Toggle`s: icon, name, and a short hint. The top-bar menus share it. */
export function ChoiceToggles({ row, hints }: { row: Row; hints: boolean }) {
  return (
    <div className={cn('grid gap-2', row.choices.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {row.choices.map((c) => (
        <Toggle
          key={c.key}
          variant='outline'
          size='lg'
          pressed={c.on}
          onPressedChange={c.pick}
          aria-label={c.title}
          className='w-full justify-start'
        >
          {c.icon}
          <span className='min-w-0 truncate'>{c.title}</span>
          {hints && c.hint && (
            <Text as='span' size='xs' tone='muted' family='mono' className='ml-auto min-w-0 truncate'>
              {c.hint}
            </Text>
          )}
        </Toggle>
      ))}
    </div>
  )
}

/**
 * The environment questions as labelled rows of toggles: the compact form for
 * the top-bar popover. Same choices, same toggles as the setup cards.
 */
function EnvironmentOptions({
  value,
  onChange,
  hints = true
}: {
  value: Environment
  onChange: (e: Environment) => void
  /** The short hint at the end of each option; off where the space is narrow (the top-bar popover). */
  hints?: boolean
}) {
  const rows = groupsFor(value, onChange).flatMap((g) => g.rows)
  return (
    <div className='grid gap-4'>
      {rows.map((r) => (
        <div key={r.label} className='grid gap-1.5'>
          <Eyebrow>{r.label}</Eyebrow>
          <ChoiceToggles row={r} hints={hints} />
        </div>
      ))}
    </div>
  )
}

/**
 * One choice as a tile, composed on the library Card: the mark, the name, the short hint in mono, and a check circle
 * on the right. Selected is the orange ring (a person decides): ring border, a 1px inner ring and the check filled.
 * Keyboard focus is the library Button's focus. 72px tall.
 */
function ChoiceTile({ choice }: { choice: Choice }) {
  return (
    <RadioItem
      value={choice.key}
      render={<Card />}
      className={cn(
        'grid h-16 cursor-pointer grid-cols-[1.222rem_minmax(0,1fr)_1.111rem] items-center gap-x-[0.667rem] px-[0.889rem] py-0 outline-none transition-[border-color,box-shadow,background-color] duration-150 ease-out hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none [&_svg]:size-[1.222rem]',
        choice.on && 'border-ring inset-ring inset-ring-ring'
      )}
    >
      {choice.icon}
      <span className='flex min-w-0 flex-col'>
        <Text as='span' weight='semibold' leading='normal' className='truncate'>
          {choice.title}
        </Text>
        {choice.hint && (
          <Text as='span' size='xs' tone='muted' family='mono' leading='none' className='truncate'>
            {choice.hint}
          </Text>
        )}
      </span>
      <span
        aria-hidden='true'
        className={cn(
          'grid size-[1.111rem] place-items-center rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none',
          choice.on ? 'bg-ring text-foreground dark:text-background' : 'border-[1.5px] border-border'
        )}
      >
        {choice.on && <Check className='!size-[0.722rem]' strokeWidth={3} />}
      </span>
    </RadioItem>
  )
}

/** One row of choices as a radio group of tiles: one per row on a phone, two or three per row on a tablet, a stack on a desktop. */
function TileGroup({ row, labelId }: { row: Row; labelId: string }) {
  return (
    <RadioGroup
      aria-labelledby={labelId}
      value={row.choices.find((c) => c.on)?.key ?? null}
      onValueChange={(key) => row.choices.find((c) => c.key === key)?.pick()}
      className={cn(
        'grid grid-cols-1 gap-[0.444rem] md:gap-[0.667rem] xl:grid-cols-1 xl:gap-[0.444rem]',
        row.choices.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'
      )}
    >
      {row.choices.map((c) => (
        <ChoiceTile key={c.key} choice={c} />
      ))}
    </RadioGroup>
  )
}

/**
 * The environment questions as choice tiles: four columns side by side on a desktop (each question titled, the titles
 * at least 47px tall so the tiles line up), stacked on a tablet and a phone. The agent question holds two groups:
 * which agent, and where you drive it.
 */
export function EnvironmentCards({ value, onChange }: { value: Environment; onChange: (e: Environment) => void }) {
  return (
    <div className='grid grid-cols-1 items-start gap-y-[1.778rem] xl:grid-cols-4 xl:gap-x-[1.333rem]'>
      {groupsFor(value, onChange).map((g) => (
        <section key={g.key} aria-label={g.label}>
          {g.rows.map((r, i) => {
            const id = `setup-${g.key}-${i}`
            return i === 0 ? (
              <div key={r.label}>
                <Eyebrow id={id} tone='think' className='block'>
                  {g.label}
                </Eyebrow>
                <Text weight='semibold' leading='tight' className='mt-[0.333rem] xl:min-h-[2.611rem]'>
                  {g.title}
                </Text>
                <div className='mt-[0.889rem] md:mt-[0.778rem] xl:mt-[0.889rem]'>
                  <TileGroup row={r} labelId={id} />
                </div>
              </div>
            ) : (
              <div key={r.label} className='mt-[1.111rem]'>
                <Eyebrow id={id} className='block'>
                  {r.label}
                </Eyebrow>
                <div className='mt-[0.556rem]'>
                  <TileGroup row={r} labelId={id} />
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

/** Setup step 1 on its own (as `/system` shows it): the environment tiles, then Continue. */
function EnvironmentPicker({
  value,
  onChange,
  onDone
}: {
  value: Environment
  onChange: (e: Environment) => void
  onDone?: () => void
}) {
  return (
    <SetupSlide
      n={1}
      title='Set up your work environment'
      actions={
        onDone && (
          <Button onClick={onDone} hoverScale={1} tapScale={1} className='max-md:flex-1'>
            Continue
            <ArrowRight />
          </Button>
        )
      }
    >
      <EnvironmentCards value={value} onChange={onChange} />
    </SetupSlide>
  )
}

/**
 * The top-bar environment control: the agent and OS marks and the mode as a
 * word, opening a popover with the same `EnvironmentOptions` as setup.
 * Changing it keeps the reader where they are.
 */
export function EnvironmentMenu({ env, onChange }: { env: Environment; onChange: (e: Environment) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          hoverScale={1}
          tapScale={1}
          aria-label={`Environment: ${describeEnvironment(env)}`}
        >
          <BrandIcon brand={agentBrand[env.agent]} />
          <BrandIcon brand={osBrand[env.os]} />
          {/* the word from 1024 up; on a tablet the two icons carry it, so the stages fit beside */}
          <span className='hidden lg:inline'>Environment</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[min(28rem,calc(100vw-2rem))]'>
        <EnvironmentOptions value={env} onChange={onChange} hints={false} />
      </PopoverContent>
    </Popover>
  )
}

/** Lets `/system` show the picker live without the store. */
export function EnvironmentPickerDemo({ initial }: { initial: Environment }) {
  const [v, setV] = useState(initial)
  return <EnvironmentPicker value={v} onChange={setV} onDone={() => {}} />
}
