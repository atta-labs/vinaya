'use client'

import { ChatBubble, ChatWindow, LineTone, TerminalLine, TuiLine } from '@/process/components/ChatWindow'
import { execScript } from '@/process/fixtures/scripts'
import { idempotencyTask } from '@/process/flows/complex/flow'
import { architectChat } from '@/process/flows/complex/scripts'
import { hotExec } from '@/process/flows/hot/scripts'
import type { ChatLine } from '@/process/types'
import { defaultEnvironment } from '@/process/types'
import { Group, Row, SectionHeader } from '../shell'

const kinds: ChatLine[] = [
  { kind: 'cmd', text: 'vinaya task run checkout-v2/1 1 --agent claude' },
  { kind: 'out', text: 'brief frozen · #418' },
  { kind: 'skill', text: '▸ doctrine loaded: planner' },
  { kind: 'me', text: 'Approved. Write them.' },
  { kind: 'ag', text: 'Tranche written. Briefs frozen.' },
  { kind: 'hook', text: 'pre-push · vinaya check --all --local' },
  { kind: 'ok', text: '38 checks · 0 failed · Ring 0 green' },
  { kind: 'ev', text: 'round 1 · dispatch developer' },
  { kind: 'hl', text: '── task 2 · #419' }
]

export function ChatSection() {
  return (
    <>
      <SectionHeader slug='chat' />
      <Group name='Lines · every kind'>
        <Row label='terminal'>
          <LineTone.Provider value='exec'>
            <div className='grid gap-1 rounded-md border border-border bg-muted/60 p-3'>
              {kinds.map((l) => (
                <TerminalLine key={l.text} line={l} />
              ))}
            </div>
          </LineTone.Provider>
        </Row>
        <Row label='agent tui'>
          <div className='grid gap-1 rounded-md border border-border bg-muted/60 py-2'>
            {kinds.map((l) => (
              <TuiLine key={l.text} line={l} />
            ))}
          </div>
        </Row>
        <Row label='chat app'>
          <LineTone.Provider value='think'>
            <div className='grid gap-1.5 rounded-md border border-border bg-card p-3'>
              {kinds.map((l) => (
                <ChatBubble key={l.text} line={l} />
              ))}
            </div>
          </LineTone.Provider>
        </Row>
      </Group>
      <Group name='ChatWindow · six chromes'>
        <Row label='claude app · chat'>
          <ChatWindow
            surface='claude'
            lines={architectChat}
            env={{ ...defaultEnvironment, os: 'mac', agent: 'claude', mode: 'chat' }}
          />
        </Row>
        <Row label='codex app · typing'>
          <ChatWindow
            surface='claude'
            lines={architectChat}
            visible={5}
            env={{ ...defaultEnvironment, os: 'mac', agent: 'codex', mode: 'chat' }}
            tone='hot'
          />
        </Row>
        <Row label='claude code · tui'>
          <ChatWindow
            surface='claude'
            lines={architectChat}
            env={{ ...defaultEnvironment, os: 'mac', agent: 'claude', mode: 'terminal' }}
          />
        </Row>
        <Row label='codex · tui'>
          <ChatWindow
            surface='claude'
            lines={architectChat}
            visible={3}
            env={{ ...defaultEnvironment, os: 'linux', agent: 'codex', mode: 'terminal' }}
          />
        </Row>
        <Row label='codex · tui · empty'>
          <ChatWindow
            surface='claude'
            lines={[]}
            env={{ ...defaultEnvironment, os: 'linux', agent: 'codex', mode: 'terminal' }}
          />
        </Row>
        <Row label='linux terminal · exec'>
          <ChatWindow
            surface='terminal'
            lines={execScript(idempotencyTask, 'codex')}
            env={{ ...defaultEnvironment, os: 'linux', agent: 'codex', mode: 'terminal' }}
            tone='exec'
          />
        </Row>
        <Row label='mac terminal · hot'>
          <ChatWindow
            surface='terminal'
            lines={hotExec}
            env={{ ...defaultEnvironment, os: 'mac', agent: 'claude', mode: 'chat' }}
            tone='hot'
          />
        </Row>
        <Row label='empty'>
          <ChatWindow surface='terminal' lines={[]} />
        </Row>
      </Group>
    </>
  )
}
