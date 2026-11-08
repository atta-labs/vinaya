# Mission Control's reading

The reading turns a repository's Log events into one picture of every task. It reads only the Log, never the forge. Two pure functions move a picture, and nothing else does:

- `reduce(picture, event)` reads one event: the line the Log's normaliser produced for it, its position in the Log, and the time it was received.
- `tick(picture, now)` lets time pass with no event arriving, and returns the tasks whose state or amber warning changed.

Neither function reads a clock, the disk or the network, and neither imports a Node built-in, because the Studio app bundles this code. The types are in `picture.ts`, the functions in `reading.ts`.

## Order and repeats

Order is the event's position, never the time it was received. An event at a position already read changes nothing but the picture's repeat count, so a reconnection that sends events again gives the same picture. A line the normaliser could not read is skipped and counted, never guessed. The same events in the same position order always give the same picture.

## Which tasks it shows

A task enters the picture with its first `dev_review_loop` record. Its dispatch and handoff records then add to it. Gate runs, usage observations and other families are read past, so an Issue with no loop record has no task. Queued tasks and merged tasks are not shown.

## The six states

Every task is in exactly one state. Screens list them in this order:

1. **Needs you** — a handoff to a person is open, or the loop paused for a reason a person must answer.
2. **Presumed dead** — the last sign of life is ten minutes old or more, and no exit was recorded after it.
3. **Stopped itself** — a stop condition other than green was met, with its condition as the reason.
4. **Needs a look** — the loop paused for a reason the reading does not recognise, or its driver exited with nothing recorded that explains why. It carries the loop's last decision word for word.
5. **Running** — the last sign of life is under ten minutes old, and no exit was recorded after it.
6. **Ready to merge** — the loop ended ready: a green stop, a ready journal, or a finished driver.

A pause is an event and death is silence, so a paused loop is never presumed dead. A pause the loop answers itself, such as a driver restarting on newer code, leaves the liveness rules in charge. The reasons a person must answer, and those the loop answers itself, come from the Log narration's own table.

## Time

The driver records a heartbeat at most every five minutes. At a tick, a running task silent for five minutes or more shows its amber warning. Silent for ten minutes or more, twice the heartbeat interval, with no exit recorded, it is presumed dead. Before the first tick there is no silence.

## What the picture holds for each task

- its title from the loop's start record, or none
- its state, its amber warning, its recorded reason and, for needs a look, the last decision
- its rounds: each agent's state, the Developer's stated confidence, the round's time, and each reviewer's verdict with its blocking and non-blocking finding counts and severities. A reviewer's findings are its own only when the record says which reviewer reported them. Otherwise every reviewer in the round shares one mark and the round's counts.
- its pull request number
- a short now-line, its last sign of life, who must act and the exact command to run
- its feed lines, in the Log narration's words, so a feed line and a terminal line about the same event say the same thing. No line carries an agent's reasoning or a finding's text.
- its tokens by role. A turn that recorded no usage stays unknown and is never counted as zero.
- its model and the machine it runs on
