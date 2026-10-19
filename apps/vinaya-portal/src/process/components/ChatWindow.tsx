'use client'

import { createContext, useContext, useEffect, useRef } from 'react'
import { Card } from '@/ui/components'
import { cn } from '@/ui/lib/utils'
import { toneBefore, toneText } from '../tone'
import type { ChatLine, Environment, Surface, Tone } from '../types'
import { defaultEnvironment } from '../types'
import { BrandIcon } from './BrandIcon'

/**
 * A simulated surface. `surface` says what the step is (an agent session or a
 * shell); `env` says how the reader sees it. Six chromes, one component, pure:
 * it shows the first `visible` lines, and `partial` of the next one's words.
 * With `fixed`, the window keeps the height its caller gives it and the lines
 * scroll inside; nothing around it moves as they appear.
 *
 * - `mac-terminal` / `linux-terminal`: a shell. `$` lines.
 * - `claude-tui` / `codex-tui`: the agent's own terminal UI, the way it
 *   really looks: you type on top, it answers below.
 * - `claude-app` / `codex-app`: the desktop app. Bubbles.
 */
type WindowChrome = 'mac-terminal' | 'linux-terminal' | 'claude-tui' | 'codex-tui' | 'claude-app' | 'codex-app'

function chromeFor(surface: Surface, env: Environment): WindowChrome {
  if (surface === 'terminal') return env.os === 'mac' ? 'mac-terminal' : 'linux-terminal'
  if (env.mode === 'terminal') return env.agent === 'codex' ? 'codex-tui' : 'claude-tui'
  return env.agent === 'codex' ? 'codex-app' : 'claude-app'
}

const agentName = (env: Environment) => (env.agent === 'codex' ? 'Codex' : 'Claude')
const CWD = '~/Work/Repositories/Me/atta-labs/shop'

const mono = 'min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-5'

/**
 * Complex work's window (`large`): terminal text at 16px on a 24px line from 1280 up, 12.5px on 20px below; a
 * command never wraps, any other long line wraps under a 2ch hanging indent. Chat bubbles at 15.75px.
 */
const Large = createContext(false)
/** The window's tone: the agent's name takes it. Outside a window the name keeps the line's ink. */
export const LineTone = createContext<Tone | undefined>(undefined)
const monoLarge = 'min-w-0 break-words pl-[2ch] -indent-[2ch] font-mono text-xs leading-5 xl:text-sm xl:leading-6'
/** The mono class for one line: `pre` keeps a command on one line, `pre-wrap` lets the rest wrap. */
const monoOf = (large: boolean, command = false) =>
  large ? cn(monoLarge, command ? 'whitespace-pre' : 'whitespace-pre-wrap') : mono

const shellLine: Record<ChatLine['kind'], string> = {
  cmd: 'text-foreground before:content-["$_"] before:text-muted-foreground',
  out: 'text-muted-foreground',
  skill: 'text-chart-3',
  me: 'text-foreground before:content-["you__"] before:text-muted-foreground',
  ag: 'text-muted-foreground before:content-[attr(data-who)_"__"]',
  hook: 'text-chart-4',
  ok: 'text-chart-2 before:content-["✓_"]',
  ev: 'text-primary',
  hl: 'text-foreground'
}

/** One line in a shell. */
export function TerminalLine({ line, env = defaultEnvironment }: { line: ChatLine; env?: Environment }) {
  const large = useContext(Large)
  const tone = useContext(LineTone)
  return (
    <div
      data-who={agentName(env).toLowerCase()}
      className={cn(
        'site-in',
        monoOf(large, line.kind === 'cmd'),
        shellLine[line.kind],
        line.kind === 'ag' && tone && toneBefore[tone]
      )}
    >
      {line.text}
    </div>
  )
}

/** One line in an agent's terminal UI: what you typed sits on a band, the answer follows with its marker. */
export function TuiLine({ line, env = defaultEnvironment }: { line: ChatLine; env?: Environment }) {
  const codex = env.agent === 'codex'
  const large = useContext(Large)
  const k = line.kind
  const mono = monoOf(large, k === 'cmd')
  if (k === 'cmd' && !line.text.startsWith('/')) return null
  // The launch banner is the chrome's own header here.
  if (k === 'out' && /^(Claude Code|Codex) · /.test(line.text)) return null
  if (k === 'me' || k === 'cmd')
    return (
      <div className={cn('site-in', mono, 'bg-muted px-2 py-1 text-foreground', codex && 'rounded-sm py-2')}>
        <span className='text-muted-foreground'>{codex ? '› ' : '❯ '}</span>
        {line.text}
      </div>
    )
  if (k === 'ag')
    return (
      <div className={cn('site-in', mono, 'px-2 text-foreground')}>
        {!codex && <span>● </span>}
        {line.text}
      </div>
    )
  if (k === 'skill')
    return (
      <div className={cn('site-in', mono, 'px-2 text-muted-foreground')}>
        {codex ? '• ' : '✻ '}
        {line.text.replace(/^▸\s*/, '')}
      </div>
    )
  return <div className={cn('site-in', mono, 'px-2', shellLine[k])}>{line.text}</div>
}

/** One line in a chat app: people and agents are bubbles; commands, skills and tool output are system rows. */
export function ChatBubble({ line, env = defaultEnvironment }: { line: ChatLine; env?: Environment }) {
  const large = useContext(Large)
  const tone = useContext(LineTone)
  const bubble = large ? 'text-sm leading-5' : 'text-xs leading-5'
  const k = line.kind
  if (k === 'me')
    return (
      <div
        className={cn(
          'site-in max-w-[88%] justify-self-end rounded-lg rounded-br-sm bg-muted px-3 py-2 text-foreground',
          bubble
        )}
      >
        {line.text}
      </div>
    )
  if (k === 'ag')
    return (
      <div className='site-in grid max-w-[92%] gap-1'>
        <span
          className={cn(
            'font-mono uppercase tracking-widest',
            tone && toneText[tone],
            large ? 'text-xs leading-4' : 'text-xs'
          )}
        >
          {agentName(env)}
        </span>
        <div className={cn('rounded-lg rounded-bl-sm border border-border bg-card px-3 py-2 text-foreground', bubble)}>
          {line.text}
        </div>
      </div>
    )
  if (k === 'cmd' && line.text.startsWith('/'))
    return (
      <div className='site-in justify-self-end'>
        <span
          className={cn(
            'rounded-sm border border-chart-3/50 bg-chart-3/10 px-2 py-0.5 font-mono text-chart-3',
            large ? 'text-xs' : 'text-xs'
          )}
        >
          {line.text}
        </span>
      </div>
    )
  if (k === 'cmd') return null
  if (k === 'skill')
    return (
      <div
        className={cn(
          'site-in rounded-sm border border-dashed border-border px-2.5 py-1.5 font-mono text-muted-foreground',
          large ? 'text-xs' : 'text-xs'
        )}
      >
        {line.text}
      </div>
    )
  return (
    <div
      className={cn('site-in', large ? monoOf(true) : cn(mono, 'text-xs'), shellLine[k])}
      data-who={agentName(env).toLowerCase()}
      // the launch banner (app · repo · branch) is small print: `large` leaves it out
      data-chat-detail={k === 'out' && /^(Claude Code|Codex) · /.test(line.text) ? '' : undefined}
    >
      {line.text}
    </div>
  )
}

/** The Claude Code mark as the terminal draws it: a pixel face on the theme's first chart hue. */
function Clawd() {
  const rows = ['.XX....XX.', 'XXXXXXXXXX', 'XXXXXXXXXX', 'XX.XXXX.XX', 'XXXXXXXXXX', 'XXXXXXXXXX', '.XX....XX.']
  return (
    <div className='grid shrink-0 grid-cols-10 gap-px' aria-hidden>
      {rows.flatMap((r, y) =>
        r.split('').map((c, x) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pixel grid; row and column are each cell's identity
          <i key={`${y}-${x}`} className={cn('size-[3px]', c === 'X' ? 'bg-chart-1' : 'bg-transparent')} />
        ))
      )}
    </div>
  )
}

const bodyBase = 'grid content-start gap-1 overflow-auto'

/** `large`: the small print (`data-chat-detail`) hidden, the input at the bubbles' size. */
const LARGE = '[&_[data-chat-detail]]:hidden [&_[data-chat-input]]:min-h-[2.444rem] [&_[data-chat-input]]:!text-sm'

function Frame({
  chrome,
  children,
  fixed,
  draft
}: {
  chrome: WindowChrome
  children: React.ReactNode
  fixed?: boolean
  /** What the reader is typing: it sits in the input until it is sent. */
  draft?: string
}) {
  const large = useContext(Large)
  const caret = <span className='inline-block h-3 w-1.5 translate-y-0.5 bg-muted-foreground' />
  const body = cn(bodyBase, fixed ? 'min-h-0 flex-1' : 'max-h-[400px] min-h-[96px]')
  const shell = fixed ? 'flex h-full flex-col' : ''
  if (chrome === 'mac-terminal' || chrome === 'linux-terminal')
    return (
      <Card variant='inset' className={cn('overflow-hidden', shell)}>
        {chrome === 'mac-terminal' ? (
          <div className='relative flex items-center gap-1.5 border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground'>
            <i className='size-2.5 rounded-full bg-destructive' />
            <i className='size-2.5 rounded-full bg-chart-4' />
            <i className='size-2.5 rounded-full bg-chart-2' />
            <span data-chat-detail className='absolute inset-x-0 text-center'>
              zsh — 96×24
            </span>
          </div>
        ) : (
          <div className='flex items-center justify-between border-b border-border bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground'>
            <span data-chat-detail>dani@box: ~/shop</span>
            <span className='tracking-widest'>– ▢ ✕</span>
          </div>
        )}
        <div data-scroll className={cn(body, 'p-3')}>
          {children}
        </div>
      </Card>
    )
  if (chrome === 'claude-tui')
    return (
      <Card variant='terminal' className={cn('overflow-hidden', shell)}>
        {/* The welcome header is the first thing in the scrollback, as in the real TUI: it scrolls away. */}
        <div data-scroll className={cn(body, 'px-1 py-3')}>
          <div data-chat-detail className='mb-2 flex items-start gap-3 px-2'>
            <Clawd />
            <div className='grid min-w-0 text-xs leading-4'>
              <span className='text-foreground'>
                <b>Claude Code</b> <span className='text-muted-foreground'>v2.1.299</span>
              </span>
              <span className='text-muted-foreground'>Sonnet 5.5 · Claude Max</span>
              <span className='truncate text-muted-foreground'>{CWD}</span>
            </div>
          </div>
          {children}
        </div>
        <div data-chat-input className='border-t border-border px-3 py-1.5 text-xs text-muted-foreground'>
          <span className='text-foreground'>❯ {draft}</span>
          {caret}
        </div>
        <div
          data-chat-detail
          className='flex items-center justify-between gap-2 whitespace-nowrap border-t border-border px-3 py-1.5 text-xs text-muted-foreground'
        >
          <span className='min-w-0 truncate'>
            {CWD} <span className='text-chart-2'>▮▮▮▮▮▮▮▮▮▮ 4%</span> Sonnet 5.5
          </span>
          <span className='shrink-0 text-chart-4'>▸▸ auto mode on</span>
        </div>
      </Card>
    )
  if (chrome === 'codex-tui')
    return (
      <Card variant='terminal' className={cn('overflow-hidden', shell)}>
        <div data-scroll className={cn(body, 'relative px-2 py-3')}>
          <BrandIcon
            brand='codex'
            className='pointer-events-none absolute left-1/2 top-1/2 size-28 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/15'
          />
          {/* The header is the first thing in the scrollback, as in the real TUI: it scrolls away. */}
          <div data-chat-detail className='mb-2 grid min-w-0 px-1 text-xs leading-4'>
            <span className='text-foreground'>
              <span className='text-chart-3'>&gt;_</span> <b>OpenAI Codex</b>{' '}
              <span className='text-muted-foreground'>(v0.162.1)</span>
            </span>
            <span className='truncate pl-6 text-muted-foreground'>{CWD}</span>
          </div>
          {children}
        </div>
        <div data-chat-input className='mx-2 mb-2 rounded-sm bg-muted px-2 py-2 text-xs text-muted-foreground'>
          {draft ? (
            <span className='text-foreground'>
              › {draft}
              {caret}
            </span>
          ) : (
            '› Ask Codex to do anything'
          )}
        </div>
        <div
          data-chat-detail
          className='flex items-center justify-between gap-2 whitespace-nowrap px-3 pb-2 text-xs text-muted-foreground'
        >
          <span className='min-w-0 truncate'>
            <span className='text-chart-2'>GPT-6-Astra low</span> · {CWD}
          </span>
          <span className='shrink-0'>← for agents · ? for shortcuts</span>
        </div>
      </Card>
    )
  const codex = chrome === 'codex-app'
  return (
    <Card variant='flat' className={cn('grid grid-cols-[44px_minmax(0,1fr)] overflow-hidden', fixed && 'h-full')}>
      <div className='grid content-start justify-items-center gap-3 border-r border-border bg-muted/40 py-3'>
        <BrandIcon brand={codex ? 'codex' : 'claude'} className='size-5 text-foreground' />
        <i className='size-4 rounded-full border border-border' />
        <i className='size-4 rounded-full border border-border' />
      </div>
      <div className={cn('grid min-w-0', fixed && 'flex min-h-0 flex-col')}>
        <div
          className={cn(
            'flex items-center gap-2 border-b border-border px-3 font-mono text-xs text-muted-foreground',
            large ? 'h-[2.444rem] px-4' : 'py-2'
          )}
        >
          <span className={cn('font-sans font-semibold text-foreground', large && 'text-sm')}>
            {codex ? 'Codex' : 'Claude Code'}
          </span>
          <span data-chat-detail>· atta-labs/shop · main</span>
          <span data-chat-detail className='ml-auto'>
            {codex ? 'gpt-6' : 'sonnet 5.5'}
          </span>
        </div>
        <div data-scroll className={cn(body, 'gap-2 p-3')}>
          {children}
        </div>
        <div data-chat-input className='border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground'>
          {draft ? (
            <span className='text-foreground'>
              {draft}
              {caret}
            </span>
          ) : (
            <span data-chat-detail>Reply… · ⌘⏎ to send</span>
          )}
        </div>
      </div>
    </Card>
  )
}

export function ChatWindow({
  surface,
  lines,
  visible = lines.length,
  env = defaultEnvironment,
  tone = 'think',
  partial = 0,
  fixed = false,
  large = false,
  className
}: {
  surface: Surface
  lines: ChatLine[]
  visible?: number
  /** 0..1: how much of the next line's words are already on screen. */
  partial?: number
  /** Keep the caller's height; lines scroll inside. */
  fixed?: boolean
  /**
   * Body-size type (22px) for every line, and the window's small print (paths, model, hints, speaker names, status
   * bars) left out: Complex work reads at the landing's size.
   */
  large?: boolean
  env?: Environment
  tone?: Tone
  className?: string
}) {
  const chrome = chromeFor(surface, env)
  const kind = chrome.endsWith('-app') ? 'app' : chrome.endsWith('-tui') ? 'tui' : 'shell'
  const root = useRef<HTMLDivElement>(null)
  const shown = lines.slice(0, visible)
  const next = lines[visible]
  // A line the reader types (a message, a slash command) is typed into the input, letter by
  // letter, and joins the transcript only once it is sent. A shell has no separate input:
  // its prompt is the last line. Agent output arrives in the transcript word by word.
  const typed = (l: ChatLine) => kind !== 'shell' && (l.kind === 'me' || (l.kind === 'cmd' && l.text.startsWith('/')))
  let draft = ''
  if (next && partial > 0) {
    if (typed(next)) draft = next.text.slice(0, Math.ceil(next.text.length * partial))
    else {
      const words = next.text.split(' ')
      shown.push({ ...next, text: words.slice(0, Math.ceil(words.length * partial)).join(' ') })
    }
  }
  const tail = shown.length + (shown.at(-1)?.text.length ?? 0)
  useEffect(() => {
    const el = root.current?.querySelector('[data-scroll]') as HTMLElement | null
    if (el && tail) el.scrollTop = el.scrollHeight
  }, [tail])
  return (
    <div ref={root} className={cn(large && LARGE, className)}>
      <Large.Provider value={large}>
        <LineTone.Provider value={tone}>
          <Frame chrome={chrome} fixed={fixed} draft={draft}>
            {shown.map((l, i) => {
              const key = String(i)
              if (kind === 'app') return <ChatBubble key={key} line={l} env={env} />
              if (kind === 'tui') return <TuiLine key={key} line={l} env={env} />
              return <TerminalLine key={key} line={l} env={env} />
            })}
          </Frame>
        </LineTone.Provider>
      </Large.Provider>
    </div>
  )
}
