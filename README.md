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
| Composer | Native editor with a "Message pi" placeholder (or the session name), context meter with omp's warning thresholds, model chip (click to switch), thinking-effort chip (click to cycle), git branch with change counts, other extensions' statuses, session cost, and Send, which turns into Stop while pi works |
| Slash and `@` completion | Tern's native picker anchored at the caret, with the typed prefix highlighted |
| Working indicator | Spinner, elapsed time and "Working…" above the composer, with a Stop button |
| User messages | Right-aligned bubbles with a copy button, the send time, and "Copy message" on long-press |
| Answers | Native markdown, collapsible thinking sections ("Thought for 4s"), and a hover row with copy, turn duration, tokens and cost |
| Tool cards | Bash (command, output and Done/Exit footer with timing), Read/Write (file preview with syntax highlighting), Edit (real diff), and a generic card for any other tool |
| Notices | pi's warnings, errors and status lines as icon notices, without the terminal colour codes |
| Everything else | Selectors (`/model`, `/settings`, `/resume`), extension dialogs and widgets are still shown, drawn by pi as an `ansi` block, and keep working with the keyboard |
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
5. **Handles input.** Keystrokes reach pi as normal terminal input. Tern events (acks, resize, clicks on chips,
   copy, send and edit) are taken off the input stream before pi's editor sees them.
6. **Brands it.** pi's logo is sent as a content-addressed SVG blob that Tern inlines. A small stylesheet sent
   with the TSP `styles` feature retints the glow, the start-screen haze and the model chip with pi's palette.
   pi's working directory is reported with OSC 7.

### Files

| File | Role |
|---|---|
| `src/index.ts` | Activation, handshake, input events, describing pi's UI as TSP nodes, the stylesheet and logo |
| `src/reconcile.ts` | Keyed tree diff into TSP operations, with identity caching |
| `src/tsp.ts` | Wire format: encoding, chunking, the inbound APC/OSC 877 parser and node helpers |
| `bin/` | Launchers that set `PI_TERN_NATIVE=1` and start pi |

## Debugging

Set `PI_TERN_NATIVE_LOG` to a file path before starting pi:

```bat
set PI_TERN_NATIVE_LOG=C:\temp\pi-tern.jsonl
```

Every frame sent, every Tern event received (except acks) and every render's duration is appended as one JSON
line. Tern reports rejected operations as `{"ev":"error"}` events, which makes protocol mistakes visible.

Tern's own headless harness is the quickest way to see the result without a window:

```bash
tern serve --control 47811 --out shots &
tern ctl --control 47811 agent-command '"C:/path/to/pi-tern-native.cmd"'
tern ctl --control 47811 block agent
tern ctl --control 47811 shot start      # writes shots/serve/start.png and a layout JSON
```

## Performance

Measured on a 546-entry session with many tool cards: about 15 ms for the first full render, then about 1–2 ms
per keystroke.

## Limitations

- **Relies on pi internals.** It reads fields of pi's own components (for example a message component's
  `lastMessage`) and the order of the containers in pi's interactive mode, so a pi update may need small fixes.
- **Not yet ported from omp:** the "Pseudo" shell view in Bash cards; rewind, retry and fork in the long-press
  menu; images inside the transcript; and omp's rate (tok/s) chip.
- **Not verified in a real window yet:** paste (especially images), Windows IME input, scrolling and the
  thinking display. Tested so far in Tern's headless harness only.
- **macOS / Linux:** the shell launcher has not been tested.

## Credits

- [Tern](https://stencil.so/tern) by Stencil Labs, which defines the surface protocol and draws everything.
- [oh-my-pi](https://github.com/can1357/oh-my-pi), whose native backend is the reference for the node shapes,
  roles and id scheme used here.
- [pi](https://github.com/earendil-works/pi) by Earendil Works.
- [pi-tern](https://github.com/Ghost-9/pi-tern), whose notes on the TSP handshake and Windows OSC 877 input
  saved a lot of guessing.
