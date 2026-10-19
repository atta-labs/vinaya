# The demo's four flows

The interactive demo lives at `/vinaya-process/demo`. That route is the setup wizard; **Start** moves to the chosen
flow's own subpage. Each flow has its own route and its own folder, so one session can change one flow without
touching another's files.

| Flow         | Route                             | Folder     | `FlowKey` |
| ------------ | --------------------------------- | ---------- | --------- |
| Complex work | `/vinaya-process/demo/complex`    | `complex/` | `feature` |
| Medium work  | `/vinaya-process/demo/medium`     | `medium/`  | `medium`  |
| Simple task  | `/vinaya-process/demo/simple`     | `simple/`  | `backlog` |
| Hot issue    | `/vinaya-process/demo/hot`        | `hot/`     | `hot`     |

## Files that belong to one flow

Change these freely when you work on that flow, and only that flow's:

- `flows/<flow>/flow.ts`: the flow's data: its tranches, tasks and steps.
- `flows/<flow>/scripts.ts`: the chat and terminal lines only that flow plays.
- `flows/<flow>/notes.ts`: the words shown beside each step while the flow has no animation of its own.
- `flows/<flow>/<Flow>Walk.tsx`: the flow's page: which provider, which right column (`aside`), edge to edge or not.
  A flow that needs its own animation or layout builds it here, in its folder.
- `src/app/vinaya-process/demo/<slug>/page.tsx`: the route, which only renders the walk.

## Shared and frozen

Used by every flow, and by the wizard, the diagram, `/system` or Home. Do not change them while working on one flow;
if a flow needs something different, copy it into the flow's folder and change the copy there.

- `flows/routes.ts`: the slugs and `flowHref`.
- `fixtures/index.ts`: assembles `flows` and `flowList` from the four folders, and `linesFor`.
- `fixtures/builders.ts`: the step builders (`intro`, `execStep`, `archiveStep`, `improveStep`, `closeTask`,
  `closeTranche`, `foldArchive`, `T`).
- `fixtures/scripts.ts`: `L`, `agentName`, `execScript` (one task through the loop) and `improverChat`.
- `fixtures/notes.ts`: `noteFor`, which fills each flow's note with the reader's environment.
- `fixtures/lifecycle.ts`: Complex work's products, figures and findings; also read by Home and the diagram.
- `components/DemoWalk.tsx`: the walk: site bar, top bar (Complexity and Environment menus), scroll clock, steps.
- `components/NoteAside.tsx`: the note column Medium work, Simple task and Hot issue use today.
- `components/ProcessPage.tsx`, `SetupWizard.tsx`, `SetupSlide.tsx`, `Environment.tsx`: the wizard.
- `components/StepSection.tsx`, `ChatWindow.tsx`, `LogTerminal.tsx`, `cards.tsx`, `primitives.tsx`, the rest of
  `components/`, `store.tsx`, `replay.ts`, `types.ts`, `lifecycle/`, `diagram/`.
