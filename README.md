# pi-tern-native

Native [Tern](https://stencil.so/tern) UI for the [pi coding agent](https://github.com/earendil-works/pi).

Inside a Tern **agent block**, pi stops drawing terminal text. Tern draws it with its own widgets instead: the
centred composer with model and effort chips, the context meter, markdown answers, tool cards and toasts. It is
the interface Tern gives [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp), restyled with pi's logo,
palette and wording.

Outside Tern, or in a normal shell block, pi is untouched.

## What you get

| Area | In Tern |
|---|---|
| Start screen | pi's pixel logo in coral, blue and yellow, with Tern's intro animation, a dotted background, a rotating tip and the composer centred with a glow in pi's colours |
| Composer | Native editor with a "Message pi" placeholder (or the session name), context meter with omp's warning thresholds (hover for tokens used and when auto-compaction starts), model chip (click to switch), thinking-effort chip (click to cycle), git branch with change counts, other extensions' statuses, the generation rate (tok/s) while pi works, session cost, and Send, which turns into Stop while pi works. Edits Tern makes itself (typing over a selection, IME, drag and drop) keep the caret where Tern put it, and Ctrl+Z in Tern goes through pi's undo |
| Usage | The bar keeps only the cost. Hovering it shows the session's numbers the way pi's footer counts them (tokens in and out, prompt cache read and written, cache hit rate); clicking it opens a usage card with the full breakdown, billing and context, closed with Escape. On a subscription login the cost is dimmed, since it is an estimate at API prices. A "cache 41%" warning chip appears only when the cache hit rate of the last request drops below 80% |
| Slash and `@` completion | Tern's native picker anchored at the caret, with the typed prefix highlighted; click a row to select it, double-click to complete |
| Queue | Steering and follow-up messages queued while pi works show as omp's pills above the composer, with a count and an Edit button that puts them back in the editor |
| Working indicator | Spinner, elapsed time and "Working…" above the composer, with a Stop button |
| User messages | Right-aligned bubbles with a hover toolbar: copy, rewind (opens `/tree` at the message, so pi asks about a summary as usual), retry (back to before the prompt and send it again) and the send time. A long press (phones) also offers Edit & resend (the prompt back in the composer) and Fork from here (a new session up to the message) |
| Images | Pasted images (pi saves them to a temp file and puts its path in your message) become chips above the text, with a thumbnail, the pixel size and a remove button. The long path is hidden in the editor and taken out of the sent bubble, which shows the image as a thumbnail instead (click to zoom). Images the model reads appear inside the Read card, capped in height. The model still receives exactly the same message. |
| Answers | Native markdown, collapsible thinking sections ("Thought for 4s"), and a hover row with copy, rewind, retry, turn duration, tokens and cost; a long press also offers Fork from here |
| Tool cards | Bash (command, output and Done/Exit footer with timing), Read/Write (file preview with syntax highlighting), Edit (real diff), Grep (matches grouped by file, with line numbers and highlighting), Find and List (paths with file and folder icons, counts in the head, pi's limit notices kept), and a generic card for any other tool |
| Notices | pi's warnings, errors and status lines as icon notices, without the terminal colour codes. A failed request is omp's error card: the status code as a chip, the provider's message, and Retry (the prompt again from before the failure), Copy error and Switch model |
| History | Compactions and branch summaries as omp's slim dividers ("Compacted · 142K tokens before"), the summary inside; skill invocations as a collapsible "Skill name" row; extension messages without a renderer of their own as a card |
| Pickers | `/model` (and the model chip) as Tern's model picker: provider marks, the current model checked, the default badged, all/scoped tabs, search typed into pi. `/resume` as the session picker: this folder / all tabs, the session tree, message count and age, search, sort, named-only, Rename (in a native input card) and Delete (with an inline confirmation). `/tree` as a tree picker: every entry indented, tool rows with their tool glyph, the active path dotted, labels as badges, the filter modes as tabs, Go here, Label (in a native input card) and Copy. `/thinking`, the theme selector and other list selectors as picker sheets |
| Extension dialogs | `ctx.ui.select` and `ctx.ui.confirm` as picker sheets, `ctx.ui.input` as omp's input card with Cancel and Submit; rows and buttons work with the pointer as well as the keyboard. Extension overlays (`ctx.ui.custom(..., { overlay: true })`) float as Tern overlays |
| Settings | `/settings` as Tern's native settings page: on/off settings as switches, short value lists as segmented choices, longer ones as menus, search, and settings with a submenu as buttons that open it: list submenus (theme, per-model thinking level, step by step) as native picker sheets over the page, submenus that are themselves settings (warnings, automatic themes) as a second page of the window, with the first one in the sidebar to go back. Settings that are a single command ("save and go back") are buttons. Changes go through pi and are saved as usual |
| Everything else | Other custom dialogs and widgets are still shown, drawn by pi as an `ansi` block, and keep working with the keyboard |
| Themes | Follows Tern's light and dark themes |

## Requirements

- Tern 0.9 or newer (tested on 0.9.18, Windows).
- pi 1.5 or newer (tested on 1.5.2).
- Not inside tmux, screen or zellij, which drop the escape sequences the protocol uses.

## Install

### As a pi package

```bash
pi install git:github.com/Baylar55/pi-tern-native
```

Restart pi or run `/reload`.

### Manually

Copy `src/` into your extensions folder:

```text
~/.pi/agent/extensions/tern-native/
├── index.ts
├── brand.ts
├── format.ts
├── images.ts
├── reconcile.ts
└── tsp.ts
```

Install it one way or the other, not both: two copies would both try to draw the interface.

## Use it

The extension does nothing until pi is started through the launcher, which sets `PI_TERN_NATIVE=1`. The reason:
Tern only displays surfaces in agent blocks, and in a shell block a surface would leave the pane blank.

1. Put the launcher somewhere stable:
   - Windows: `bin/pi-tern-native.cmd`
   - macOS / Linux: `bin/pi-tern-native` (`chmod +x` it; untested so far)
2. In Tern, open **Settings › Agents** and set the agent command to the launcher's full path, for example
   `C:\Users\you\.pi\agent\bin\pi-tern-native.cmd`.
3. Open an agent block with **Ctrl+Shift+A**.

This replaces omp as the program that new agent blocks run. Set the agent command back to `omp` to switch back.

Run `/tern-native` inside pi to see whether the native surface is active, the Tern version and the column count.

## How it works

Tern speaks the **Tern Surface Protocol (TSP)**. A program says hello, opens a surface and sends frames of
operations on a tree of semantic nodes: `editor`, `meter`, `seg`, `md`, `tool`, `card`, `toast` and so on. Tern
draws the nodes with its own CSS, keyed by each node's `role`. omp is the reference program: its composer is a
`col` with role `omp.editor`, its model chip a `row` with role `omp.composer.model`, and so on.

This extension does the same for pi, without patching pi:

1. **Handshake.** At session start it sends `hello` and waits for Tern's reply. On Windows Tern answers with
   OSC 877 instead of APC, because ConPTY cannot carry APC on input; both are handled. With no reply, pi is
   left alone.
2. **Takes over output.** pi-tui still renders as usual, but its terminal writes are swallowed, apart from
   window-title sequences. Each render triggers a native describe instead.
3. **Describes pi's live components.** It walks pi's component tree and maps every component it knows to omp's
   node shapes and roles: user and assistant messages, tool executions, `!` bash runs, notices and the editor.
   Unknown components are rendered by pi itself into an `ansi` node, so nothing disappears.
4. **Diffs and sends frames.** `reconcile.ts` turns the tree into `add` / `del` / `set` / `text` operations, with
   omp's id scheme (`composer.line/input`). Unchanged subtrees are reused by identity and skipped. Frames
   respect Tern's acknowledgement credits.
5. **Sends large updates in pieces.** Opening a long session can produce megabytes of changes. They go out as
   frames of about 160 KB, in order, as Tern acknowledges them. A single multi-megabyte frame arrived corrupted
   through the Windows console layer.
6. **Handles input.** Keystrokes reach pi as normal terminal input. Tern events (acks, resize, clicks on chips,
   copy, send and edit) are taken off the input stream before pi's editor sees them.
7. **Brands it.** pi's logo is sent as a content-addressed SVG blob that Tern inlines, the same way pasted
   images reach Tern: written to Tern's blob cache and announced, or sent inline when Tern lacks them. A small stylesheet sent
   with the TSP `styles` feature retints the glow, the start-screen haze and the model chip with pi's palette.
   pi's working directory is reported with OSC 7, and pi's mouse tracking is switched off so the touchpad and
   wheel scroll the transcript.

### Files

| File | Role |
|---|---|
| `src/index.ts` | Activation, handshake, input events, describing pi's UI as TSP nodes, dialogs, pickers and turn actions |
| `src/brand.ts` | pi's logo, palette stylesheet and start-screen tips |
| `src/format.ts` | Pure text helpers: ANSI to styled spans, token and time formatting, languages by extension |
| `src/images.ts` | Image paths in messages and pixel sizes from file headers |
| `src/reconcile.ts` | Keyed tree diff into TSP operations, with identity caching |
| `src/tsp.ts` | Wire format: encoding, chunking, the inbound APC/OSC 877 parser and node helpers |
| `bin/` | Launchers that set `PI_TERN_NATIVE=1` and start pi |
| `test/` | Unit tests, and the headless Tern harness with its mock model, fixture extension and isolated pi config |

## Debugging

Set `PI_TERN_NATIVE_LOG` to a file path before starting pi:

```bat
set PI_TERN_NATIVE_LOG=C:\temp\pi-tern.jsonl
```

Every frame sent, every Tern event received (except acks) and every render's duration is appended as one JSON
line. Tern reports rejected operations as `{"ev":"error"}` events, which makes protocol mistakes visible.
With `PI_TERN_NATIVE_LOG_VERBOSE=1` the log also gets acks and the raw terminal input (your keystrokes, so only
turn it on while debugging).

Tern's own headless harness is the quickest way to see the result without a window:

```bash
tern serve --control 47811 --out shots &
tern ctl --control 47811 agent-command '"C:/path/to/pi-tern-native.cmd"'
tern ctl --control 47811 block agent
tern ctl --control 47811 shot start      # writes shots/serve/start.png and a layout JSON
```

## Development

```bash
npm install        # pi's packages as dev dependencies (types), TypeScript
npm run check      # tsc --noEmit
npm test           # unit tests: wire format, inbound parser, tree diff, text and image helpers
```

`test/shot.sh` checks the real thing headlessly. It starts a mock model (`test/mock-llm.mjs`, an
OpenAI-compatible server that streams a canned answer: no network, no cost), a `tern serve`, and an agent block
running `test/dev-launch.cmd`. That launcher runs this checkout's `src/` with an isolated pi config (`test/agent`:
the mock models, no credentials, a demo skill) and a fixture extension (`test/fixture-ext.ts`) whose commands open
the dialogs: `/t-select`, `/t-confirm`, `/t-input`, `/t-overlay`, `/t-custom`. Arguments are `tern ctl` commands;
ones starting with `!` run in the shell:

```bash
bash test/shot.sh 'type "/t-select"' 'key Tab' 'key Enter' '!sleep 1' 'shot select'
```

Screenshots and layouts land in `%TEMP%\pi-tern-shots\serve`, the frame log in `%TEMP%\pi-tern-dev.jsonl`.
`wait N` only moves Tern's own clock forward and returns at once, so give pi real time with `!sleep N`.

## Performance

Measured on a 546-entry session with many tool cards: about 15 ms for the first full render, then about 1–2 ms
per keystroke.

## Limitations

- **Relies on pi internals.** It reads fields of pi's own components (for example a message component's
  `lastMessage`) and the order of the containers in pi's interactive mode, so a pi update may need small fixes.
  The layout is checked at startup: when it is not the expected one, the surface shows a warning and pi's own
  screen in one block instead of a broken native view (`PI_TERN_NATIVE_FORCE_DEGRADED=1` shows that mode).
- **Not yet ported from omp:** the "Pseudo" shell view in Bash cards.
- **Extension overlays** are pi's own rendering inside a Tern overlay, not native widgets.
- **Images are recognised by path:** any absolute path to an existing `.png`, `.jpg`, `.gif`, `.webp` or `.bmp`
  file in a message is shown as an image (up to 20 MB). Paths to files that no longer exist stay as text.
- **Not verified in a real window yet:** Windows IME input and the thinking display.
- **macOS / Linux:** the shell launcher has not been tested.

## Credits

- [Tern](https://stencil.so/tern) by Stencil Labs, which defines the surface protocol and draws everything.
- [oh-my-pi](https://github.com/can1357/oh-my-pi), whose native backend is the reference for the node shapes,
  roles and id scheme used here.
- [pi](https://github.com/earendil-works/pi) by Earendil Works.
- [pi-tern](https://github.com/Ghost-9/pi-tern), whose notes on the TSP handshake and Windows OSC 877 input
  saved a lot of guessing.
