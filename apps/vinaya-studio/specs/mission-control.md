# Mission Control

Mission Control is Studio's landing screen. It is a live board with one row per task, and it answers one question first: does anything need you?

## What it never shows

- An agent's reasoning, or a finding's text. For findings it shows counts and severity only.
- A value it does not know. Unknown is shown as unknown, never guessed.
- An emoji. Every icon is a line icon from one icon set.

## States

Every task is in exactly one of six states. The board sorts them in this order:

1. **Needs you** — a loop paused for a decision only a person can make. The row shows why, how long it has waited, and the exact command to run.
2. **Presumed dead** — no sign of life for ten minutes, and no exit.
3. **Stopped itself** — the loop stopped by its own rules. The row shows the reason.
4. **Needs a look** — the loop paused for a reason Studio does not recognise. The row shows the last decision, word for word.
5. **Running** — the loop is working.
6. **Ready to merge** — the loop ended ready. Studio never says a task is merged.

## Silence

Silence is a state. A task that has said nothing for five minutes turns amber. At ten minutes it is presumed dead. Studio works this out on a clock, so a task can change state while no event arrives.

## The top of the board

- **Counts bar.** One count per state. Only "need you" has a bright background.
- **Waiting on you.** A strip of chips, one per task that needs you, oldest first.

## The row

From left to right:

- **State.** One line icon. Hovering it names the state.

  | State | Icon |
  | --- | --- |
  | Running | three animated dots |
  | Needs you | an outlined raised hand |
  | Presumed dead | a crossed-out signal |
  | Stopped itself | a stop square |
  | Needs a look | a question mark |
  | Ready to merge | a ticked circle |

- **Title.** As wide as the longest title, up to a maximum. A longer title ends in an ellipsis, and hovering it shows the full title.
- **Rounds.** R1, R2 and R3, each shown as agent glyphs.
- **Pull request.** Lit when the task is ready.
- **Now-line.** Where the task stands now.
- **Last sign.** When the task last said anything.

## Agent glyphs

Every agent is the same hexagon. The mark inside tells the role:

| Role | Mark |
| --- | --- |
| Developer | code brackets |
| Code review | a tick |
| Security | a shield |

Colour and outline tell the state:

| State | Look |
| --- | --- |
| Not started | dim outline |
| Working | bright white, slow pulse |
| Done | solid green |
| Changes requested | red, dashed |
| Needs a person | amber, filled |
| No word back | grey, dashed |

Only two things move on the board: the working glyph and the running dots. A pause-motion switch stops them both.

## The feed

One live feed, shared by the whole board, with two views only: **Following** and **Attention**.

## The drawer

Choosing a row opens a drawer beside the board, with:

- **Needs you** — a box with the command to run, when the task needs you.
- **Story** — what has happened to the task.
- **Rounds** — each round with its confidence and its verdicts.
- **Usage** — what the task has used.

## The task page

Each task has its own page with its full event log.

## How events reach the page

1. **One follower per repository** reads the repository's Log as it grows.
2. **One pure reading** turns the events into a picture of every task. Every page shares that one picture.
3. **A thirty-second clock** reads the picture again, so silence becomes amber and then presumed dead even when no event arrives.
4. **One server-sent event stream** carries the picture to the page: the whole picture when the page connects, then only the tasks that changed.
