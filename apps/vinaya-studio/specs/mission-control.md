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
4. **One WebSocket** carries the picture to the page: the whole picture when the page connects, then only the tasks that changed. It lives on `/api/mission-control/live`. The Studio server answers that upgrade itself; Next's hot-reload socket stays Next's, and the two never share a handler. A WebSocket is chosen over server-sent events because the page also sends over the same connection, and the host already owns the listener.

## The repository picture service

One server-owned service holds one shared picture per selected repository. It owns the repository's Log source and follower and the one clock; every browser reads the same picture, so a second browser never starts a second follower. It knows nothing of HTTP or React.

- **Opening a log server.** The service asks the source what it retains, starts at the stated head minus a stretch (5000 events by default, never below the beginning), reads forward in pages of the source's own bound until a page brings nothing, presents the caught-up picture with the position it started from, and follows from exactly the last position it read. If the head is unknown, the source's own reason is the status and nothing starts. A start above the beginning is declared opening-limited: a task whose start record or early rounds come before it keeps what its recorded events show, and the rest is unknown.
- **Opening a log folder.** The service reads everything the folder's live files hold, keeps every machine's file in its own order, and orders across files by recorded time. A loop start comes before a same-time record. Missing, backwards or equal-time cross-machine records are declared source-limited, not authoritative. Rotated slots are not read on opening, so coverage is declared incomplete.
- **Time.** History keeps its recorded age; a line read live takes the local receipt time. After a reconnect no line is read as newer than its recorded time. An unreadable recorded time is unknown freshness, never a sign of life. Only the thirty-second clock moves silence.
- **After opening.** A folder record older than the newest one applied for its task is held back: the task keeps its last reliable standing and is marked chronology-limited.
- **Bounds.** 200 feed entries per task, 100000 remembered event identities, 10000 tasks, 1000 rounds per task and 64 MiB read while opening. When one runs out the source stops advancing at the last applied position, the picture is kept, and coverage is declared capacity-limited, never live or complete.
- **Status.** The service reports connection state, coverage limits and counts. A refused credential, an unreachable source or an unreadable record is shown as such; an empty or stale picture is never presented as live. Closing stops the clock, every watcher and every socket.

## The live endpoints

- **`/api/mission-control/live`** — the WebSocket above, open only to a page holding the launch session. A host with no picture service answers one fixed greeting frame, `{"type":"hello"}`, and carries no repository data; Studio's own start registers the live endpoint below in its place.

## The live protocol

Every frame is JSON and names `"v":1`. The page rejects any other version or any unknown type.

- **Server frames.** `snapshot` carries every repository and every task and starts a new *generation*. `task` carries one whole changed task, keyed by repository and task. `status` carries a repository's connection and coverage. `keepalive` carries nothing. A `task` or `status` frame names the generation of the snapshot it follows; a page ignores one from any other generation. A page replaces tasks whole and never patches them.
- **Repository ids.** A repository is named on the wire by an opaque id (`r1`, `r2`, ... in launch order) and its remote's name. Its local folder never leaves the server.
- **What a task carries.** An explicit allowlist, built field by field: number, title, state, amber, reason, decision, pull request, the one line saying what is happening, last sign, who acts, the command, model, each round's outcome, checks, agents, confidence, reviewers' outcomes and finding counts, and token sums. Recorded gate payloads, finding text, reasoning, the feed's narration, machine names, loop identities, local paths, credential headers and the launch or session secret never reach the page. Text is cut at 500 characters and a repository sends at most 10000 tasks.
- **Keep-alive.** The server sends a `keepalive` every twenty seconds. It proves the socket and nothing else: it is never a sign of life of any task and never moves silence. A page that hears nothing for fifty seconds drops the socket.
- **Reconnecting.** The page keeps its last picture and the time of its last update while it reconnects, after 1, 2, 4, 8, 15 and then every 30 seconds, for at most twenty attempts; then it stops until asked again. The first frame of every connection is a fresh snapshot that replaces the page's state. A reconnect sends nothing: the session cookie is the only credential, and the launch token is never sent again.
- **Slow pages.** A page whose socket holds more than 1 MiB unsent has its frames dropped and gets a fresh snapshot once it drains; past 4 MiB it is closed and reconnects.
- **What the page may send.** One frame, `resync`, which answers with a fresh snapshot. Any other frame, or one over 256 bytes, closes the connection. Nothing a page sends runs a command.
- **`/api/mission-control/tasks`** — the minimum live task list, an HTTP `GET` answering `{"tasks":[]}` until the picture is wired in.

Neither endpoint stores or describes task topology: which task depends on which, and in what order they run, stay with the repository's Issues.
