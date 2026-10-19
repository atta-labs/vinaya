# Vinaya Development Harness — DESIGN.md

The public site that explains Vinaya as a development process: an interactive walk through the four stages, driven by one of four choices. Dark first, light supported. The CMS theme (shadcn tokens) is the base; the site adds one layer: a stage palette.

Files: `src/ui/styles/site.css` (tokens), `src/process/types.ts` (the model), `src/process/fixtures/` (the only data), `src/process/components/` (the components), `src/process/diagram/` (the diagram), `src/process/system/` (the design system: a sidebar shell and one section page each under `/system`), `/` (the process page assembled from them).

Rules inherited from the attalabs UI package, applied in full: components over raw primitives, theme tokens only (no palette classes, no hex, no `text-white`), no inline styles except computed numbers, named exports. The `animate` library is the one in use; `installed/` files are upstream pastes and are never edited.

**`installed/` is attalabs, byte for byte.** `src/ui/libraries/*/installed/` are exact copies of attalabs `packages/ui/libraries/*/installed/`: never edited, never reformatted (excluded from Biome in `biome.json`), never invented. Their `@atta/ui/*` imports resolve through a `tsconfig` alias to `src/ui/*`, so the files need no rewriting. Any change in behaviour goes in the wrapper layer (`libraries/*/components/`). Not every file in `installed/` is a real animate-ui paste: only `installed/animate-ui/primitives/` is; `card.tsx`, `badge.tsx`, `dropdown-menu.tsx`, `popover.tsx`, `select.tsx` and `table.tsx` were hand-written in attalabs.

**Cards do not move.** The animate library's `Card` is written in the wrapper (`libraries/animate/components/card.tsx`): same markup, no hover lift. It does not import the hand-written `installed/card.tsx`, which lifts every card 2px on hover.

**Top-bar buttons do not move.** The animate `Button` scales on hover (1.05) and on tap (0.95); every top-bar button passes `hoverScale={1} tapScale={1}`, the component's own props.

**Atoms are not styled.** `Button`, `Badge`, `Card`, `Table`, `Tabs`, `Heading`, `Text` are used as the library ships them: their variants and sizes, nothing else. Tailwind classes on them are for layout only (grid, gap, margin, width). Type is set through `Text` and `Heading` props, never classes: `variant` picks a role (`Text`: `eyebrow`, `lead`, `intro`, `title`, `figure`; `Heading`: `display`, `headline`, `page`, `title`, `subtitle`), and `size`, `weight`, `family`, `tone` (`muted`, `foreground`, `accent`) and `leading` adjust it. The other atoms work the same way: `Badge` (`variant` `label`, `code`; `size` `2xs`…`2xl`; `tone` `primary`, `success`, `retired`), `Card` (`variant` `flat`, `inset`, `terminal`, `link`, `square`; `CardTitle` `size`, `weight`, `family`), `Button` (`variant` `subtle`, `field`, `code`, `inverse`, `inverse-outline`; `size` `xl`) and `Table` (`variant` `docs`, `data`). Stage colour stays the `tone.ts` maps. Type sizes, line heights and tracking come from the theme's scale steps only, never bracket values; the one exception is a scaled drawing (the CSS-zoomed diagram miniatures, the `--k`-scaled SVG scene, the pad screen's container units) and `Code`'s size relative to its text. A composite the library lacks (a Banner, a LogRail, a choice card) is composed from `Card` and the other atoms, never hand-drawn. Icons: `lucide-react` for everything generic; brand marks through `BrandIcon` (simple-icons paths in `currentColor`: Linear, Jira, Claude (Claude's own mark, `siClaude`), Anthropic, Codex (OpenAI), Apple, Linux, Asana, Cloudflare, GitHub), never inline SVG.

---

## 0. The portal

This lab is becoming the new Vinaya portal. The attalabs portal (`apps/vinaya-portal/web`) was copied in as it was: every page and component under `src/app/(site)/`, its `src/lib/` (docs loaders, published-version reads, GitHub links) and its `public/` assets. The copy is the lab's own code now; it only borrows content: the doctrine and CLI data from the published `@attalabs/*` npm packages, and the theme, branding and roadmap from the shared Sanity project, read at build or render time.

**Structure.** The site is one product made of features, plus its default process:

- **Top bar** (`src/app/(site)/layout.tsx`): Product ▾ (Configuration, Gates, Log, Studio, Dev Process) · The process · Docs ▾ (Harness, The Vinaya process) · Start. Footer: Start, Docs, CLI, Config, Studio, Roadmap, Compare, npm.
- **Home** (`_components/landing/LandingPage.tsx`): the hero (the portal's 3D emblem; "An agent harness / for software teams"; See the process, Install), Five features (`FeaturesSection`), Who it's for (`AudienceSection`), the Vinaya process strip (`ProcessStripSection`: four stages; Walk through it, See the whole diagram), Zero lock-in (`ZeroLockInSection`), Atta Engine in one line (`EngineSection`).
- **Feature pages** (`/product/*`, `FeaturePage`): a feature's name and line, the portal's own sections that show it, then where to read more. Configuration (ConfigBoard, Zero lock-in), Gates (the Rings), Log (the merge scene and `vinaya log --follow`), Dev Process (links to the walk, roles and contracts, the state machine). Studio keeps its own page, `/the-studio`.
- **The Vinaya process** (`/vinaya-process`): a short page in the site layout (the live diagram preview, the stages, the four ways work enters, the Principal's five decisions) with two ways in: the interactive demo (`/vinaya-process/demo`, this document's §4) and the full diagram (`/vinaya-process/diagram`). Both full-screen pages carry the site's own bar (`PortalBar`, the shared `SITE_LINKS`); the demo adds its toolbar under it. `/process` redirects to `/vinaya-process`.
- **Docs** (`/docs/*`, one sidebar layout, `docs/(guide)/`, nav in `docs/_lib/portal-docs.ts`): two halves, the product as it will be once the harness and the process are separated (the "Any Process, One Harness" end state), not as the code is today.
  - **Harness**: Get started, Configuration (the harness keys), Gates (the three rings, your own checks), Log, Your own process (the process contract), CLI (the harness commands).
  - **The Vinaya process**: Overview (four stages, the walk, the diagram), Roles (roles and hand-offs from the doctrine), Working with it (`/vinaya architect`, `planner`, `operator`, rulings, Studio), Configuration (the process keys).
  - Only what a person runs is documented. Commands the Operator and the agents call (task run, pr create, review post and the rest) are not listed. The circles map, the state machine page, the reference dump and the doctrine pages are retired; their old URLs redirect (`next.config.ts`). The top bar's Docs menu has two items, one per half.
- **Start, Compare, Roadmap**: the portal's pages, unchanged. `/life-cycle` is retired and redirects to `/vinaya-process`.

The repo root for the docs loaders is wherever the installed doctrine sits (`node_modules/@attalabs/vinaya/aeg-root`); the lab has no `vinaya.config.json`. `jsdom` is pinned to 26 for the roadmap's sanitizer.

---

## 1. Tokens

**Base.** The CMS is the source of truth: the only theme variables are the ones the CMS theme renders (`src/cms/utils/theme.ts`, field names mapped in `src/cms/types.ts`). Local CSS only maps them into Tailwind (`--color-x: var(--x)` in `globals.css`); it never defines a value or a variable of its own. The rendered set today:

- shadcn: `background`, `foreground`, `card(-foreground)`, `popover(-foreground)`, `primary(-foreground)`, `secondary(-foreground)`, `muted(-foreground)`, `accent(-foreground)`, `destructive(-foreground)`, `border`, `input`, `ring`, `chart-1`…`chart-5`, `sidebar-*`, `radius`, `font-sans`, `font-serif`, `font-mono`
- CMS extras: `success(-foreground)`, `warning(-foreground)`, `primary-hover`, `secondary-hover`, `shadow-color`, `shadow-2xs`…`shadow-2xl`, `header-background`, `gradient-primary`, `gradient-background`, `gradient-card`, `spacing`, `tracking-normal`

Shades are opacity on these (`bg-chart-3/10`). Nothing in `src/process` sets a raw colour.

**Stage palette.** One hue per stage family, each a shadcn theme token the CMS renders (theme Obsidian today). There are no tone variables and no `data-tone`: the only colour variables in the app are the CMS theme's. A component that belongs to a stage takes a `tone` prop and picks its classes from the maps in `src/process/tone.ts` (`toneText`, `toneBg`, `toneBorder`, `toneMarker`, `toneTint`, `toneBefore`), which write each class out whole for Tailwind. A component whose tone never changes uses the token class directly (`text-chart-3`). Chat lines read the window's tone from the `LineTone` context.

| Tone | Theme token | Stage family |
|---|---|---|
| `product` | `chart-5` | outside Vinaya: Linear, Jira, the engineering need |
| `think` | `chart-3` | Architect, Planner |
| `exec` | `chart-4` | loop, gates, merge |
| `retro` | `chart-2` | archive, Improver |
| `hot` | `destructive` | hot Issue, hot mode |
| `log` | `primary` | the Log, Studio |
| `ok` (no tone) | `chart-2` | a gate that passed: a chat line's `✓` |
| `neutral` | `muted-foreground` | cards that belong to no stage |

The 3D scene cannot read CSS classes, so it resolves the same theme tokens (`--chart-3`, `--chart-4`, `--chart-2`, `--primary`, `--destructive`) through a canvas (`resolveColor`) at mount and on every state change; oklch included.

**Type.** UI: the CMS sans. Everything that is a command, an event, a label, a figure or an identifier: Geist Mono (`font-mono`), `tabular-nums` on figures. Eyebrows are 11px mono, uppercase, +12% tracking.

| Style | Size / line / tracking | Use |
|---|---|---|
| `h1` | clamp(30, 4.4vw, 46) / 1.06 / −2% | the intro question |
| `h2` | clamp(24, 3vw, 34) / 1.12 / −2% | step titles |
| `body` | 15 / 1.5 | step text, muted |
| `chat` | 12.5 / 20 mono | every typed line |
| `label` | 11 / 16 / +12% caps mono | eyebrows, pills, chips, rail |

**Scrollbars** thin, in `muted-foreground` at 35%, on every element (`site.css`).

**Bar height** The top bar is `h-14`, 3.5rem, so its pixels follow the theme's root font size (18px here: 63px). Layout classes use `3.5rem`; the scroll code measures the bar. Never hard-code 56px.

**Spacing** base 4px. Gaps used: 1.5 2 2.5 3 4 (6 8 10 12 16px). Section gap on `/system`: 16 (64px).
**Radii** md 6 (chips) · lg 8 (stat tile) · xl 12 (cards, windows, rail) · 2xl 16 (overlay sheet) · full (pills, buttons).
**Motion** The interactive page has no clock: the reader's scroll drives every animation, forward and back. Each step owns a scroll runway (`max(640px, 40px × lines)`); its lines type in over the first 82% (`LINES_END`), word by word, and what the step produces shows for the rest. The note beside a step reveals letter by letter over the first 45% of the runway (`ScrubLetters`: each letter fades in and rises 4px; windows overlap). `site-in` 300ms ease-out when a line first mounts; `site-blink` 600ms for a running gate. `prefers-reduced-motion`: every step renders finished.

---

## 2. The model

`src/process/types.ts`. The four scenarios, one **Flow** each. Scenario copy (labels, tags, descriptions, Upstream) stays high level: no tranche, Architect or Milestone.

| Flow | Label | Title | Scope |
|---|---|---|---|
| `feature` | Complex work | Deploy complex work | Multiple projects or features |
| `medium` | Medium work | Deploy medium work | Complex features, fixes or refactors |
| `backlog` | Simple task | Deploy a backlog issue | Simple chore, feature, fix or refactor |
| `hot` | Hot issue | Deploy a hot issue | Hot chore, feature or fix (pair programming on the Issue's branch, not straight on main) |

A **Flow** has `tranches` and ordered `steps`. A **Step** has a `kind` (`intro`, `chat`, `exec`, `archive`, `improve`), a `stage`, its copy, and what the reader's scroll types: `lines` (chat or terminal), a `tranche` (exec derives the lines per task; `logFull` shows only that many tasks in full, then each tranche as one Operator dispatch line and one merge line — Complex work's 52 tasks show two in full), `closingLines`, `stats`, `proposals`. A **ChatLine** carries an optional **LineEffect**: Log events, a gate state. **SceneState** is the one object the 3D scene reads (on `/system` only for now).

**Replay** (`replay.ts`, pure). The page state is one **Cursor**: the step in view and the scroll progress through it. `replay(flow, agent, cursor)` re-applies every line effect up to the cursor and returns the Log, the gates and each task's state; scrolling back undoes what scrolling forward did. `stepLines`, `execLines`, `shownAt` live here too.

Rules:
- A component takes data and renders any flow. `/system` proves it by rendering with each fixture.
- Log event names are the real families: `gate.summary`, `dev_review_loop.round_started`, `dispatch.dispatched`, `forge_write.written`.
- Commands are real: `vinaya task run <tranche> <n> --agent <claude|codex>`, `--issue <n>`, `/vinaya architect`, `/vinaya planner`.
- Captions come from the Vinaya Development Harness document. New copy is a documented exception.
- Copy is for a first-time reader: plain words, no insider vocabulary (no doctrine, Surface, Ring numbers, Principal, tranche intents, briefs frozen). The role that runs the work and reads the report is the Operator, on both sides of the page. A task in full is nine lines: dispatch, the developer at work, checks before commit and push, the pull request, CI, two fresh reviewers, the merge, the audit.

---

## 3. Components

Props are the contract. When a prop is added, this file changes in the same commit.

### Primitives (`primitives.tsx`)
- **Eyebrow** `{ tone?, size? }` — muted by default; toned when a stage owns it. `size='xl'` makes it a headline (the scenario cards' title).
- **Pill** `{ tone?, lit? }` — HUD stage and flow labels. Lit = tone border and text.
- **BigBullets** `{ items, size?, stagger? }` — big, short bullets on the library `Text` (`lg` or `xl`); `stagger` fades them in one after another on mount. The setup and the flow cards use it.
- **Banner** `{ tone, title, children? }` — the one tinted callout; closing message of stage 3.
- **StatTiles** `{ stats: {value,label}[] }` — three figures; only on stage 4.

### Environment (`Environment.tsx`)
- **Environment** is five choices: OS, agent, where you drive it, the product management tool (`tracker`: Linear, Jira) and the Log server (`logServer`: Cloudflare, Grafana, Datadog). An environment stored before the last two existed reads back with the defaults (Linear, Cloudflare).
- **EnvironmentProvider** / **useEnvironment** (`environment-context.tsx`) — the reader's environment for any component that renders a choice; null outside the page, where components stay generic.
- **fillEnv** `(text, env)` — copy names the reader's tools: `{tracker}`, `{project}` (a Project in Linear, an Epic in Jira; the article follows), `{logServer}`. With no environment: "Linear or Jira", "Project", "Any log server". Step copy, the conversations, the notes and diagram card lines all go through it; the Log card's footer shows the chosen server's mark.
- **EnvironmentCards** `{ value, onChange }` — setup step 1: the environment as four cards, two by two, like step 2's scenarios. Each card: a label, a short title, then rows of library `Toggle`s (operating system; agent with where you drive it as a second row; product management; log server).
- **EnvironmentOptions** `{ value, onChange, hints? }` — the same choices and toggles as labelled rows, for the top-bar popover. Both read one grouped definition (`groupsFor`).
- **SetupSlide** `{ n, title, actions, children }` — every setup slide is designed at one fixed size (1296 × 900) and scaled down to fit the space under the bar, like a slide in a deck: it never scrolls at any window size, the buttons are always on screen, and content inside it uses no breakpoints. Every setup slide is this one structure: `Setup · n of 2` and the title pinned at the top, the content between, the buttons pinned bottom right with the primary one last. Step label, title and primary button land on the same pixels on every slide.
- **EnvironmentPicker** `{ value, onChange, onDone? }` — setup step 1 on SetupSlide: "Set up your work environment", EnvironmentCards, Continue.
- **EnvironmentMenu** `{ env, onChange }` — the top-bar control: the agent and OS marks and the mode as a word, opening a library `Popover` with EnvironmentOptions (no hints). Changing it keeps the reader where they are.
- Stored in `localStorage` under `vinaya.environment`. It only pre-fills the picker; setup always shows both steps. The store hydrates it after mount.

### Chat (`ChatWindow.tsx`)
- **ChatWindow** `{ surface: 'claude'|'terminal', lines, visible?, partial?, fixed?, env?, tone? }` — pure, on `Card`. `partial` (0..1) shows that share of the next line. A line the reader types (a message, a slash command) types into the window's input, letter by letter, and joins the transcript only once sent; a shell has no separate input, its prompt is the last line. Agent output arrives in the transcript word by word. In the TUIs the welcome header is the first thing in the scrollback and scrolls away, as in the real tools; footers stay one line. `fixed` keeps the height the caller sets; lines scroll inside and the window never grows. `chromeFor(surface, env)` picks one of six chromes. A `terminal` surface is a shell of the reader's OS: `mac-terminal` (traffic lights, zsh), `linux-terminal` (flat title bar). An agent session is `claude-tui` or `codex-tui` in terminal mode, the agent's real terminal UI: Claude Code's pixel mark, version line, `❯` input band, `●` answers, `✻` system lines, the footer with the context bar and auto mode; Codex's `>_` header, the dotted mark as a watermark, `›` input box, model footer. In chat mode it is `claude-app` or `codex-app`: a rail with the brand mark, title bar, bubbles, reply box.
- **TuiLine** `{ line, env }` — a line in an agent's TUI: you type on a band, it answers below. A bare launch command and the launch banner are not shown; the chrome already is them.
- **TerminalLine** `{ line, env }` — one line by `kind`: `cmd` (`$`), `me` (`you`), `ag` (agent name in tone), `skill` (think), `hook` (exec), `ok` (✓ ok), `ev` (log), `out`, `hl`.
- **ChatBubble** `{ line, env }` — the same line in an app: `me` right bubble, `ag` left bubble with the agent's name, a slash `cmd` as a chip, `skill` as a dashed system row, tool output as mono; a bare launch `cmd` is not shown.
- **LogTerminal** `{ events, env }` — the Log as the reader would tail it: a shell of their OS running `vinaya log tail --follow`, one line per event, fixed height.
- **ScrubLetters** `{ text, progress }` — text revealed letter by letter by a progress value, never a timer.

### Cards (`cards.tsx`)
- **ChoiceCard** `{ flow, pressed }` — the four entries: one title, said once, "DEPLOY COMPLEX WORK" (`flow.deploy` as an `lg` Eyebrow: uppercase mono, tone colour, the same size as the Scope line), a **Scope:** line (`flow.scope`), then the flow's `points` as BigBullets (`lg`). Pressed = tone border + inset ring.
- **OutputCard** `{ data: milestone | tranche | issue, status? }` — what a thinking step produces. A tranche is one line per task (number, Issue, title); the Surface is in the tooltip.
- **TaskChips** `{ tasks, status? }` — queued (border), running (exec), done (retro).
- **GatePills** `{ gates: [0|1|2 ×3] }` — Ring 0 hooks, Ring 1 CI, Ring 2 audit. 1 blinks exec, 2 is ok with glow.
- **LogRail** `{ events, total?, max? }` — last `max` events, newest at the bottom, name in tone, detail muted.
- **ProposalCard** `{ kind, title, text, target, created?, onCreate }` — the Improver's proposal; created = retro border, button disabled.
- **Crumbs** `{ active, tone, onPick?, only? }` — `only` lists the stages the flow has; the others are not shown. A diagram stage the flow lacks is mapped to the step the walk lands on, so the bar never lights a missing stage.
  With `onPick` each crumb is a library `Button` that moves the walk there; without it, a `Badge`.

### Steps (`StepSection.tsx`)
- **BriefHeader** `{ brief, tone, env?, progress? }` — a section said like a landing page: `Stage n`, the stage in big type with its command beside it as a **CommandLine**, an optional subtitle, then bullets at the largest Text size, `xl` (what it does, Output). A stage with no command (Self-improvement runs on its own) shows no command line and no "Automatic" bullet; its bullets say how it runs. Bullets appear one by one as the reader scrolls in; they hold their space, so nothing moves. A step with a `brief` shows it instead of its StepHeader. Complex work uses briefs on all five stages (Thinking, Planning, Executing, Retrospecting, Self-improvement) and ends on an `outro` step, back upstream outside Vinaya, laid out like the Upstream intro (the top bar lights Upstream again); the other flows still use StepHeader.
- **CommandLine** `{ command, progress? }` — the stage's command as a terminal line on the library `Card`: a terminal icon, the command typed in letter by letter over the first 12% of the step's scroll, a block cursor (`site-cursor`, in the stage tone) resting at its end. It wraps under the title when there is no room beside it. Reduced motion: typed and still.
- **StepHeader** `{ step }` — eyebrow, title, text, and `emphasis`: one bold sentence the reader must not miss (stage 3 uses it to say the Archivists act on merge, automatically, and what closes in this flow).
- **FlowChoice** `{ flow: FlowKey | null, onPick, onBack?, onStart }` — setup step 2, "What you have to deploy next": the four choices in a 2×2 grid, Back and Start. No description. No card is pressed until the reader clicks one; Start waits for it.
- **FlowMenu** `{ flow, onChange }` (`cards.tsx`) — the top-bar dropdown: the current flow as the trigger, the four flows inside as plain menu items. Hover keeps the menu's own highlight; the current flow is marked with a check (no radio bullets, no second highlight). Changing it restarts the walk at the top of the new flow. Never pass `align` to the animate `DropdownMenuContent`: the installed component forwards it to its div as an HTML attribute, which right-aligns the text.
- **StepView** `{ step, flow, env, progress }` — one step at a scroll progress, pure. It fills its parent's height: copy on top, and on the last step the diagram's own **ImproverCards** below (not for Complex work, whose animation draws the stats and the new Project) (outputs, task states and closing banners are the animation's to show, not a card's). The window takes the height left over (at least 144px), so a step always fits the screen. The Improver's cards hold their place from the start and fade in once the lines are done, so nothing moves.
- **noteFor** `(step, flow)` (`fixtures/notes.ts`) — the words that stand where each step's animation will go.

### The diagram (`diagram/`)
- **ProcessDiagram** `{ moment: { flow, stage, gates?, closed? }, onNode? }` — the document's whole diagram as one SVG component (viewBox 1540 × 1610). The flow runs down the left column; the **Observability & auditability** box on the right holds the Log and Studio, and a dashed arrow from every stage says that stage writes there as it happens, from the first Issue created. Nodes, bands and edges are data in `nodes.ts`; each node declares `flows` (which choices pass through it) and `at` (the stage where it is current).
- **DiagramCard** `{ node, state }` — one card. States from `moment.ts`: `impossible` (the flow never passes here: hatched cover, content hidden), `future` (muted 30%), `now` (lit, tone glow, 2px stroke), `done` (normal), `always` (the observed band). Mocks inside a card (task list, issue, chat, events, loops, stats, proposals) are drawn from the node's `mock`.
- **nodeState / statesAt** — the driver: flow membership first, then stage rank against the moment; the gates node reads the gate state instead.
- Edges carry `flows` too; an edge outside the flow is not drawn.
- **Executing holds everything after the work.** The Gates, Before closure and Retrospecting sections sit inside the Executing container (`StageGroup nested`): the same yellow tone, their borders at 30% until current, every card in them in the Executing tone. Arrows run gates → closure → retrospecting inside the container; the container hands on to Self-improvement, now Stage 3 in the diagram.
- **UpstreamCards** `{ moment }` — Linear, Jira and the engineer's own need. The diagram's upstream stage and the walk's first section render this one component.
- **ImproverCards** `{ moment }` — the Stats and Improver cards. Stage 4 of the diagram and the last step of the walk render this one component. Their contents (`StatRow`, `ProposalList`) read `fixtures/lifecycle.ts`, the same data the life-cycle animation's last altitudes draw.
- **MapView** `{ flow, stage, onFlow, onStage, flows? }`, **MapDialog** (MapView in the library `Dialog`, for `/system/diagram`'s Full screen) and **MomentPicker** (`flows` hides the flow tabs) — the full-screen diagram and its picker; `momentOf(flow, stage)` derives gates and closure from the stage.

### The life-cycle animation (`lifecycle/`)
- **LifecycleScene** `{ progress, archive?, story, className? }` — Complex work's right column: one three.js scene, one camera that only goes down, eight altitudes. `story` is read once on mount (the page keys the component on the tracker, so a new tracker remounts it); `progress` and `archive` every frame. The scene reads its progress from a stand-in track whose rectangle encodes `progress`; it eases towards it (`p += (target − p) × 0.07`), and every weight is a pure function of `p` and `archive`, so scrolling back replays the same frames.
- **lifecycleStory** `(tracker, mark)` (`story.ts`) — what the scene draws, from the fixtures the left column renders: the tracker (name, Project or Epic, its simple-icons mark via `brandPath`, a key prefix), the product Projects (a name and a lucide mark each) and the stats, conclusions and proposals (`fixtures/lifecycle.ts`), the milestone and its tranches (`flows.feature`), and Log lines in the real families.
- **lifecycleProgress** `(stage, q, lines, closing)` (`progress.ts`) — the walk's position as `{ progress, archive }`. Each stage owns a window (`LIFECYCLE_WINDOWS`) and moves through it as its lines type (`shownAt`): Upstream 0 → 0.06 (by scroll), Thinking 0.06 → 0.24, Planning 0.24 → 0.40, Executing 0.40 → 0.655 with the execution lines, then 0.655 → 0.80 with the Archivist's closing lines (`archive` 0 → 1), Self-improvement 0.80 → 0.92 (by scroll: the report, then the Improver), the outro step 0.92 → 1 (by scroll: back upstream).
- **The altitudes**, top to bottom, all in one world column. Each is a box the camera fits from one fixed direction; between legs (`TRAVEL`) it holds, on a leg it eases from box to box, and every box is lower than the last.
  1. **Product** — the reader's tracker as a dashboard, landing-page scale: a bar with the tracker's mark and name and the deploy's one target (Checkout v2), a wordless sidebar, and the six Projects as big tiles. A Project is a feature to deliver, not a product: its name, large, and above it the marks of the products it touches (Never charge twice: Cloudflare, Payments API; Ledger and receipts: Database, Payments API; Fraud checks at the edge: Cloudflare; One-tap pay on mobile: Mobile app, Payments API; Checkout on desktop: Desktop app, Payments API; Refunds in the admin: Admin web, Database). Each tile lights as it joins the deploy; six lines then run from the dashboard down into the milestone.
  2. **Milestone** — a container laid out like the tracker's dashboard: a bar across the top (a flag icon and `checkout-v2` on the left, its state on the right, a hairline under it), and right under it three cards, one per part, each a name and the marks of the products its features touch: Charge once (Never charge twice, Ledger and receipts, Fraud checks at the edge), Pay in the apps (One-tap pay on mobile, Checkout on desktop), Support tools (Refunds in the admin) (`checkoutParts`). No empty band, no small print. Six fine vertical lines, one per Project, each over the part it goes into, run from the dashboard's foot to the container's top edge and stop there (no end dots; every link between altitudes is the same hairline); they start only on the leg down (never at rest on the dashboard) and draw as the camera comes down, the tip just inside the frame. The parts appear as the Architect names them. The animation never says "tranche intent".
  3. **Tranches** — each part card stays one card: its marks give way to its tasks as rows (Issue number, a short title, state) as the Planner writes them, and its state shows on the right. Complex work is 52 tasks (22 / 18 / 12 per part); a card shows its first seven and then "+ N more tasks", which shares their state. Nothing cross-fades over anything.
  4. **Task** — the first row's lane drops out of its tranche (drawn on the leg, so the frame is never empty) and runs develop → review (sent back once) → security → verify → merge, with the Merged chip. Meanwhile every row goes in flight then merged, in waves. Code review wears an eye and security a shield, each in a ring that takes the check's colour (running, sent back, green). The view is framed from just before develop to past the Merged chip; as the run lands, the camera pans right until the chip is centred (a function of the run, so it replays on the way back). The lane runs into the chip; the chip is the merge (no merge dot). The branch sits left so the chip stands over the milestone below, and from right under the chip one hairline drops straight down into the closing milestone's top edge, reaching it as the camera does.
  5. **Closure** — the camera just keeps going down and finds the milestone there, whole (the same builder, `buildMilestone`, draws it a second time at this altitude, one row taller): nothing is carried or dropped, nothing crosses the branch. One unit per closing line typed whole, in the log's order: each part's Issues CLOSED together (one Archivist line per part), then the part ARCHIVED, then the milestone DONE (its flag, state and container turn success), then the retrospective. The retrospective row is there from the start, dashed and muted ("Retrospective · when the milestone closes"), and turns success when kept ("Retrospective kept · what shipped and why"). Each change flashes once.
  6. **Report** — what the Log says about the milestone, laid out as a report: a head (MILESTONE REPORT, Checkout v2, 52 of 52 tasks merged, a full progress bar), four figures each with its label, value and one line on where it comes from (34 min time per task, 19 of 52 second rounds, 418 problems caught, 18,508 checks run), and where the time goes (one thick bar, a large legend: Developer writes the code · 84%, Reviewers check it · 16%). Parts rise in one by one.
  7. **Self-improvement** — one fine line down to the Operator's card, framed in the primary tone: an eye mark (it watches every run) and "Operator", in the other corner "3 improvements found", large, then three cards side by side, centred, large: what the report showed (muted) over a down arrow and the change it asks for (bold) (`improveFindings`): Most extra rounds come from one gate → Run the doc gate before push; A vague Surface doubles the rounds → Check the Surface at planning time; Rulings are hard to predict → Preview a resume in Studio. No badges, no full-width rows.
  8. **Back upstream** — the walk's last step (`outro`, back outside Vinaya); its leg starts the moment the step does, so the left and right sides change together: one fine line down into the tracker's dashboard again ("From the Log"), holding the approved change as a new Project tile, which lights success, and beside it "Why", large, the report's lines that justify it (`improveWhy`). The loop closes here; no line climbs back up.
- **Handoff** — an arriving altitude is legible by the middle of its leg and the leaving one only starts to fade there (`altWeight`); anything an arriving altitude needs to be read (the container, the lane's drop, the proposals) draws before or during its leg. Objects never disappear by contrast alone: every altitude keeps a floor.
- **Colour** — shadcn tokens only, read through `token()`; materials through `TOKEN_OF`, text panels repaint from tokens. A theme switch repaints without a reload (`applyTheme`).
- **Labels** — DOM spans placed by projection (`LABELS`), one or more altitudes each; their classes are authored in `LifecycleScene.tsx`.
- **Reduced motion** — the walk hands each step finished; the scene snaps to the altitude that step ends on, fitted whole (`fitComposed`), nothing reads time or the pointer.
- **Inspection** — `?lifecycle=<0..1>` pins the scene at one progress (re-read when the query changes).
- `lifecycle-scene.js` grew from the attalabs portal's life-cycle scene (its token reader, materials, labels and the task's branch); it stays `.js` and is excluded from Biome.

### Map and Studio (`ProcessMap.tsx`)
- **ProcessMap** `{ path, now?, tone }` — the whole process; `path` lights a flow's boxes, `now` the current one.
- **StudioTable** `{ rows, tone }` — Mission Control columns: task, issue, PR, state, round, phase, gate.

### Scene (`ProcessScene.tsx`)
- **ProcessScene** `{ state: SceneState }` — three.js; reads one object. Stage nodes on a closed curve, task particles, loop orbit in a sandbox, three gate tori, milestone plane. Reduced motion renders once per state.

### Page (`ProcessPage.tsx`)
- **ProcessPage** — the store, the two columns, the HUD, the overlays. Nothing here decides; it wires.

### Store (`store.tsx`)
- **ProcessProvider** / **useProcess** — `{ flow, env, envKnown, envChosen, agent, started, cursor, view, mapStage, extra }` and a reducer; `live` is the replay at the cursor plus `extra` (events the reader caused by hand). `readStoredEnvironment` / `storeEnvironment` wrap the browser store.

---

## 4. Layout

Setup first, full width, nothing beside it, two steps as slides of one track: Continue slides it left to the next step, Back slides it right (500ms, none under reduced motion; the slide out of view is `inert`). Each slide fits the screen under the bar, no scroll. Step 2 is "What you have to deploy next": the four ChoiceCards two by two, wide enough for every bullet to sit on one line. Each choice lands in the top bar the moment it is clicked: the EnvironmentMenu on the first environment click (or at once when one is stored), the FlowMenu on the first flow click. Both work from there on. Start opens the walk: two columns from 768px, the walk two fifths and the right side three fifths. Each pinned step sits in **ShrinkToFit**: on a short window it is laid out larger and scaled down until it fits, so nothing spills into the next step; where it fits, it is untouched. The life-cycle animation runs edge to edge and fades out over its box's edges (a CSS mask), so the drawing never ends on a hard line. Left, the flow's sections in order. Retrospecting is not a section: it is automatic and part of executing, so each flow's archive step is folded into its last execution step (its closing lines run on in that terminal) and the top bar has no Retrospecting stage. For Complex work the life-cycle animation tells the whole flow, Upstream to Self-improvement. Only the flows with an upstream (complex and medium work) open with Upstream; a simple task or a hot issue starts at its Issue. Upstream says where the need comes from, in words that name the reader's tracker, with no window and no Observability beside it, since nothing is recorded before Vinaya. Each step pins under the top bar for its whole runway, centred, its window at a fixed height. Right, no border, no panel: the note for the step in view, revealed on scroll. (Observability is off the page for now.) For Complex work the right side is instead the life-cycle animation (**LifecycleScene**, `src/process/lifecycle/`), one continuous descent described in **The life-cycle animation** below. The header is two rows: the site's own bar (`PortalBar`) and the demo's toolbar under it (6.5rem together; the sticky offsets use it). The whole-process diagram is no longer a top-bar view: the walk's last step (the `outro`) offers **See the whole process** (a library `Button`), which opens `MapDialog` full screen on the walk's flow at Self-improvement, with its own flow and stage picker; `/system/diagram` keeps it reachable directly. The diagram's bands follow the walk's numbering (Stages 1 and 2 · Thinking and Planning, Stage 3 · Executing, Stage 4 · Self-improvement) and its Self-improvement cards are the report and the Operator. The stage **Crumbs** in the top bar are library `Button`s (`onPick`): a crumb scrolls the walk to that stage. The walk's state lives in memory only (a refresh starts over): the flow and the cursor. The toolbar reads left to right: the name The Vinaya process, the FlowMenu (a short flow name as the trigger, from the first flow click), then that flow's stage crumbs; on the right the EnvironmentMenu. It fits from 1280px. Studio lives in Observability, not in the bar. Below 768px the right column is hidden.

---

## 5. Do / Don't

- Do pass `tone` to the component that belongs to a stage and colour it from `src/process/tone.ts`; don't add colour variables or `data-tone`.
- Do add a fixture before a component; a component with no fixture state on `/system` does not exist.
- Do name events as the Log names them; don't invent families.
- Don't add a clock: scroll is the only input that moves the page.
- Don't let the scene decide; it draws `SceneState`.

---

## 6. Later

Portal three.js scenes (`design/portal-reference/*.js`) are the look to grow into; they import only `three`. The pause and ruling round, the replan path, and Studio's live view are not in the fixtures yet by decision.
