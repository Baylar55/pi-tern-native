/**
 * tern-native — pi with omp's native Tern interface.
 *
 * Inside a Tern *agent block*, Tern draws programs that speak the Tern Surface Protocol (TSP)
 * with its own native widgets. omp describes every component as a semantic node under `omp.*`
 * roles (composer, chips, context meter, tool cards, markdown…); Tern's stylesheet does the rest.
 *
 * This extension does the same for pi: it swallows pi-tui's ANSI output, and describes pi's live
 * component tree as TSP nodes with omp's roles. Anything it has no semantic mapping for
 * (selectors, dialogs, widgets, custom messages) is still shown, as an `ansi` node rendered by
 * the component itself, so nothing pi or other extensions draw disappears.
 *
 * Activation is explicit: only when PI_TERN_NATIVE=1 (set by the `pi-tern-native` launcher that
 * Tern's `agent_command` points at) and the terminal answers the TSP hello. Otherwise inert.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	type KeybindingsManager,
	ModelSelectorComponent,
	SessionSelectorComponent,
	type ReadonlyFooterDataProvider,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, type EditorTheme, Markdown, SelectList, Spacer, type TUI, Text } from "@earendil-works/pi-tui";
import { Reconciler } from "./reconcile.ts";
import {
	APC,
	col,
	encode,
	encodeHello,
	encodeRaw,
	type Hello,
	InboundParser,
	icon,
	md,
	n,
	type Op,
	row,
	span,
	ST,
	spans,
	type TspNode,
	text,
} from "./tsp.ts";

const PLACEHOLDER = "Message pi";
const COST_ICON = "\u{f067a}";
const OSC_ONLY = /^(\x1b\][^\x07\x1b]*(\x07|\x1b\\))+$/;

const TIPS = [
	"Start a message with ! to run a shell command, or !! to keep its output out of the context",
	"Type / for commands and @ to attach files",
	"Shift+Tab changes the thinking level, Ctrl+L switches the model",
	"Escape stops the agent, Ctrl+P cycles through your models",
	"Run /tree to go back to an earlier point in the session",
]

const LANG: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
	java: "java", kt: "kotlin", py: "python", rb: "ruby", go: "go", rs: "rust", cs: "csharp",
	c: "c", h: "c", cpp: "cpp", hpp: "cpp", json: "json", md: "markdown", sql: "sql", xml: "xml",
	yaml: "yaml", yml: "yaml", toml: "toml", sh: "bash", bash: "bash", ps1: "powershell",
	html: "html", css: "css", scss: "scss", gradle: "groovy", properties: "properties", lua: "lua",
};

type G = { __piTernNative?: { surfaces: number } };
const shared = ((globalThis as G).__piTernNative ??= { surfaces: 0 });

function langOf(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
	return ext ? LANG[ext] : undefined;
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g, "");
}

function fmtTokens(v: number): string {
	if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${+(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`;
	return `${v}`;
}

function clock(ts: unknown): string | undefined {
	const d = typeof ts === "number" || typeof ts === "string" ? new Date(ts) : undefined;
	if (!d || Number.isNaN(d.getTime())) return undefined;
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * pi's logo (components/pi-logo.ts): the 4x4 pixel "Pi" in coral, blue and yellow.
 *
 * Built like Tern's built-in omp mark so Tern inlines it and runs the same welcome intro:
 * `mark` shapes fade in, the `trace` outline draws itself first. Unlike omp's, the fills are
 * solid brand colours rather than a gradient Tern recolours to ink, so pi keeps its identity.
 * The trace uses currentColor, Tern's text colour, so it suits light and dark themes.
 */
const PI_CORAL = "#e48a7a";
const PI_BLUE = "#4f8eb3";
const PI_YELLOW = "#eab65d";
const PI_LOGO = (() => {
	const coral = "M14 13h27v18h-9v-9h-18z";
	const blue = "M14 22h9v9h9v9h-9v9h-9z";
	const yellow = "M41 31h9v18h-9z";
	const outline = "M14 13h27v18h-9v-9h-9v9h9v9h-9v9h-9z";
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 12 44 38" shape-rendering="crispEdges">`,
		`<path class="mark" fill="${PI_CORAL}" d="${coral}"/>`,
		`<path class="mark" fill="${PI_BLUE}" d="${blue}"/>`,
		`<path class="mark" fill="${PI_YELLOW}" d="${yellow}"/>`,
		`<path class="trace" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" pathLength="1" d="${outline}${yellow}"/>`,
		`</svg>`,
	].join("\n");
	const bytes = Buffer.from(svg, "utf8");
	return { bytes, mime: "image/svg+xml", id: createHash("sha256").update(bytes).digest("hex") };
})();

/**
 * pi's palette for Tern's chat chrome, sent with the TSP `styles` feature (`s` verb). It
 * retints what Tern otherwise paints in omp's purple/pink/cyan: the aurora under the composer
 * and the haze behind the dotted start screen.
 */
const PI_STYLES = `
[data-role^='omp.editor'] {
	--rd-aurora:
		light-dark(#d9705f, ${PI_CORAL}), light-dark(#d39a35, ${PI_YELLOW}), light-dark(#3f7ea6, ${PI_BLUE}),
		light-dark(#5f9cc4, #7fb3d4), light-dark(#d9705f, ${PI_CORAL});
}
[data-role='omp.composer.model'] .sf-t-accent {
	color: light-dark(#3f7ea6, #7fb3d4) !important;
}
/* Tern's own folder chip: the git chip already says where pi works, and omp shows none */
[data-role='omp.composer.bar'] > .sf-place {
	display: none !important;
}
.sf-slot::before {
	background-image:
		radial-gradient(560px 110px at 50% 100%, rgb(228 138 122 / 9%), transparent),
		radial-gradient(circle, var(--l4) 0 1px, transparent 1.5px) !important;
}
`;

/**
 * Absolute paths to image files in message text: what pi inserts when you paste an image
 * (`%TEMP%\pi-clipboard-<uuid>.png`), or any image path typed or dropped in. Only paths that exist
 * on disk become attachments; anything else stays plain text.
 */
const IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?]*?\.(?:png|jpe?g|gif|webp|bmp)(?![\w.])/gi;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Pixel size from the file header (PNG, GIF, JPEG, WebP, BMP), for chip labels and layout hints. */
function imageSize(b: Buffer): { w: number; h: number } | undefined {
	try {
		if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
		if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
		if (b.length > 26 && b.toString("ascii", 0, 2) === "BM") return { w: b.readInt32LE(18), h: Math.abs(b.readInt32LE(22)) };
		if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
			const kind = b.toString("ascii", 12, 16);
			if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
			if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
			if (kind === "VP8L") {
				const bits = b.readUInt32LE(21);
				return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
			}
		}
		if (b[0] === 0xff && b[1] === 0xd8) {
			let o = 2;
			while (o + 9 < b.length) {
				if (b[o] !== 0xff) {
					o++;
					continue;
				}
				const marker = b[o + 1]!;
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
				}
				o += 2 + b.readUInt16BE(o + 2);
			}
		}
	} catch {
		/* unreadable header */
	}
	return undefined;
}

/** Drop the trailing padding pi-tui adds to every line, keeping any closing SGR codes. */
function trimRight(line: string): string {
	return line.replace(/[ \t]+((?:\x1b\[[0-9;:]*m)*)$/, "$1");
}

function trimBlank(lines: string[]): string[] {
	let a = 0;
	let b = lines.length;
	while (a < b && stripAnsi(lines[a]!).trim() === "") a++;
	while (b > a && stripAnsi(lines[b - 1]!).trim() === "") b--;
	return lines.slice(a, b);
}

function resultText(result: any): string {
	if (!result?.content) return "";
	return result.content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.replace(/\s+$/, "");
}

const trace = (msg: string) => {
	const p = process.env.PI_TERN_NATIVE_LOG;
	if (p) try { appendFileSync(p, `${JSON.stringify({ t: Date.now(), trace: msg })}
`); } catch {}
};

/**
 * pi colours notices with its theme; Tern wants semantic styles. Map each run's foreground to the
 * theme token that produced it (warning, error, success…) so Tern draws it in its own palette.
 */
function ansiToSpans(text: string, styleOf: (sgr: string) => string | undefined): { t: string; s?: string }[] {
	const out: { t: string; s?: string }[] = [];
	let fg: string | undefined;
	let bold = false;
	let italic = false;
	const re = /\x1b\[([0-9;:]*)m/g;
	let last = 0;
	const push = (t: string) => {
		if (!t) return;
		const s = [fg && styleOf(fg), bold ? "strong" : undefined, italic ? "em" : undefined].filter(Boolean).join(" ") || undefined;
		const prev = out[out.length - 1];
		if (prev && prev.s === s) prev.t += t;
		else out.push(s ? { t, s } : { t });
	};
	for (let m = re.exec(text); m; m = re.exec(text)) {
		push(stripAnsi(text.slice(last, m.index)));
		last = re.lastIndex;
		const params = m[1] === "" ? ["0"] : m[1]!.split(";");
		for (let i = 0; i < params.length; i++) {
			const p = params[i];
			if (p === "0") (fg = undefined), (bold = false), (italic = false);
			else if (p === "1") bold = true;
			else if (p === "22") bold = false;
			else if (p === "3") italic = true;
			else if (p === "23") italic = false;
			else if (p === "39") fg = undefined;
			else if (p === "38") {
				fg = params[i + 1] === "2" ? params.slice(i, i + 5).join(";") : params.slice(i, i + 3).join(";");
				i += params[i + 1] === "2" ? 4 : 2;
			} else if (/^(3[0-7]|9[0-7])$/.test(p ?? "")) fg = p;
		}
	}
	push(stripAnsi(text.slice(last)));
	return out;
}

export default function (pi: ExtensionAPI) {
	trace(`factory native=${process.env.PI_TERN_NATIVE} term=${process.env.TERM_PROGRAM}`);
	if (process.env.PI_TERN_NATIVE !== "1") return;
	if ((process.env.TERM_PROGRAM ?? "").toLowerCase() !== "tern") return;
	if (process.env.TMUX || process.env.STY || process.env.ZELLIJ) return;

	// ---------- state ----------
	let ctxRef: ExtensionContext | undefined;
	let tuiRef: TUI | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;
	let composer: TernComposer | undefined;
	let keybindingsRef: KeybindingsManager | undefined;
	let hello: Hello | undefined;
	let active = false;
	let sf = "";
	let seq = 0;
	let unacked: number[] = [];
	let credits = 2;
	let apcLimit = 65536;
	let cols = 80;
	let lastFocus: string | null | undefined;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	let restoreWrite: (() => void) | undefined;
	let unsubInput: (() => void) | undefined;
	let helloWaiter: ((h: Hello | undefined) => void) | undefined;
	let running = false;
	let tipIndex = Math.floor(Math.random() * TIPS.length);
	let git: { branch?: string; untracked: number; changed: number } = { untracked: 0, changed: 0 };
	let gitTimer: ReturnType<typeof setTimeout> | undefined;

	const parser = new InboundParser();
	const reconciler = new Reconciler();
	const ids = new WeakMap<object, string>();
	let idSeq = 0;
	const nodeCache = new WeakMap<object, { key: string; node: TspNode }>();
	const toolClock = new WeakMap<object, { start: number; end?: number }>();

	const idOf = (o: object, prefix: string) => {
		let id = ids.get(o);
		if (!id) ids.set(o, (id = `${prefix}${(idSeq++).toString(36)}`));
		return id;
	};

	const logPath = process.env.PI_TERN_NATIVE_LOG;
	const logVerbose = process.env.PI_TERN_NATIVE_LOG_VERBOSE === "1";
	const log = (dir: string, verb: string, body: unknown) => {
		if (!logPath) return;
		try {
			appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), dir, verb, body })}\n`);
		} catch {
			/* best effort */
		}
	};

	const rawWrite = (s: string) => {
		try {
			process.stdout.write(s);
		} catch {
			/* terminal went away */
		}
	};

	// ---------- composer (pi's editor, described natively) ----------
	class TernComposer extends CustomEditor {
		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings);
			tuiRef = tui;
			composer = this;
			keybindingsRef = keybindings;
		}
	}

	// ---------- input: TSP events ----------
	const onInput = (data: string) => {
		if (logVerbose && !data.includes("\x1b]877") && !data.includes("\x1b_tsp")) log("in", "raw", { data });
		if (usageOpen && data !== "\x1b" && !data.includes("\x1b_tsp") && !data.includes("\x1b]877")) {
			// typing (or any other key) closes the card and carries on as usual
			usageOpen = false;
			scheduleRender(0);
		}
		if (!data.includes("\x1b")) return parser.buffering ? feed(data) : undefined;
		return feed(data);
	};

	const feed = (data: string) => {
		if (usageOpen && data === "\x1b") {
			usageOpen = false;
			scheduleRender(0);
			return { consume: true };
		}
		const { messages, rest } = parser.feed(data);
		for (const m of messages) handleInbound(m.verb, m.body);
		if (rest === data) return undefined;
		return rest.length === 0 ? { consume: true } : { data: rest };
	};

	const handleInbound = (verb: string, body: any) => {
		if (logVerbose || !(verb === "e" && body?.ev === "ack")) log("in", verb, body);
		if (verb === "r" && body?.r === "hello") {
			if (helloWaiter) {
				const w = helloWaiter;
				helloWaiter = undefined;
				w(body as Hello);
			}
			return;
		}
		if (verb === "r" && body?.r === "blobs") {
			const asked = blobQueries.shift() ?? [];
			const have: unknown[] = Array.isArray(body.have) ? body.have : [];
			for (const id of asked) if (!have.includes(id)) sendBlobInline(id);
			return;
		}
		if (verb !== "e" || !body || typeof body.ev !== "string") return;
		if (body.sf && body.sf !== sf) return;
		switch (body.ev) {
			case "ack": {
				const done = unacked.length - Math.max(0, seq - body.s);
				if (done > 0) unacked.splice(0, done);
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = undefined;
				scheduleRender(0);
				return;
			}
			case "resize":
				if (typeof body.cols === "number" && body.cols > 0 && body.cols !== cols) {
					cols = body.cols;
					scheduleRender();
				}
				return;
			case "action":
				return runAction(String(body.act ?? ""), String(body.id ?? ""), typeof body.value === "string" ? body.value : undefined);
			case "select":
			case "activate":
				return pick(body.ev === "activate", String(body.id ?? ""), String(body.item ?? ""));
			case "send":
				if (composer && typeof body.text === "string" && body.text.trim()) {
					// submit the given text; a draft already in the composer stays there (TSP `send`)
					const draft = composer.getText();
					composer.setText(body.text);
					composer.handleInput("\r");
					if (draft.trim() && composer.getText() === "") composer.setText(draft);
					scheduleRender(0);
				}
				return;
			case "edit":
				return applyEdit(String(body.id ?? ""), body);
			case "undo":
				return applyUndo(String(body.id ?? ""));
			case "theme":
				if (typeof body.dark === "boolean" && hello) hello.dark = body.dark;
				return;
			case "gone":
				if (Array.isArray(body.ids) && body.ids.includes(sf)) openSurface();
				return;
		}
	};

	/** Put the composer's caret at a UTF-16 offset into its text. */
	const setComposerCursor = (ed: TernComposer, offset: number) => {
		const lines = ed.getLines();
		const st = ed as unknown as { state: { cursorLine: number }; setCursorCol(col: number): void };
		let rest = Math.max(0, offset);
		for (let i = 0; i < lines.length; i++) {
			const len = lines[i]!.length;
			if (rest <= len || i === lines.length - 1) {
				st.state.cursorLine = i;
				st.setCursorCol(Math.min(rest, len));
				return;
			}
			rest -= len + 1;
		}
	};

	type DialogField = { getValue(): string; setValue(v: string): void; cursor: number; pushUndo?(): void; undo?(): void };
	const dialogField = (id: string): DialogField | undefined => (id === DIALOG_INPUT ? activeTextDialog()?.field : undefined);

	/**
	 * A TSP `edit`: Tern replaced `[from, to)` of an editor or input with `text` (a selection paste,
	 * IME, drag and drop) and put the caret at `cursor`. `len` is the length Tern saw; when it
	 * differs the edit is stale and dropped, and the next frame shows the real text again.
	 */
	const applyEdit = (id: string, e: { from?: unknown; to?: unknown; text?: unknown; cursor?: unknown; len?: unknown }) => {
		if (typeof e.text !== "string") return;
		const field = dialogField(id);
		if (!field && !composer) return;
		const before = field ? field.getValue() : composer!.getText();
		if (typeof e.len === "number" && e.len !== before.length) return scheduleRender(0);
		const clamp = (v: unknown, max: number, dflt: number) => Math.max(0, Math.min(max, typeof v === "number" && Number.isFinite(v) ? v : dflt));
		const from = clamp(e.from, before.length, 0);
		const to = Math.max(from, clamp(e.to, before.length, from));
		const text = field ? e.text.replace(/[\r\n]+/g, "") : e.text;
		const after = before.slice(0, from) + text + before.slice(to);
		const caret = clamp(e.cursor, after.length, from + text.length);
		if (field) {
			field.pushUndo?.();
			field.setValue(after);
			field.cursor = caret;
		} else {
			composer!.setText(after); // one undo unit, as typing is
			setComposerCursor(composer!, caret);
		}
		tuiRef?.requestRender();
		scheduleRender(0);
	};

	/** A TSP `undo` (Ctrl+Z in a Tern field): pi's own undo history for that field. */
	const applyUndo = (id: string) => {
		const field = dialogField(id);
		if (field) field.undo?.();
		else (composer as unknown as { undo?: () => void } | undefined)?.undo?.();
		tuiRef?.requestRender();
		scheduleRender(0);
	};

	/** Pointer picks: rows of the select sheet and of the autocomplete list. */
	const pick = (activate: boolean, id: string, item: string) => {
		if (id === SHEET_ID) {
			currentSheet()?.pick(activate, item); // picker items carry pi's own ids (model ids hold a "/")
			tuiRef?.requestRender();
			return scheduleRender(0);
		}
		const key = item.slice(Math.max(item.lastIndexOf("/"), item.lastIndexOf(".")) + 1);
		if (id === SELECT_ID || id.startsWith(`${SELECT_ID}.`) || id.startsWith(`${SELECT_ID}/`)) {
			const sel = shownSelector() as unknown as
				| { options: string[]; selectedIndex: number; updateList(): void; onSelectCallback(o: string): void }
				| undefined;
			const index = Number(key);
			if (!sel || !Number.isInteger(index) || index < 0 || index >= sel.options.length) return;
			sel.selectedIndex = index;
			sel.updateList();
			if (activate) sel.onSelectCallback(sel.options[index]!);
		} else if (id.startsWith("complete")) {
			const index = autocompleteKeys.get(key);
			const list = (composer as unknown as { autocompleteList?: { setSelectedIndex(i: number): void } } | undefined)?.autocompleteList;
			if (index === undefined || !list) return;
			list.setSelectedIndex(index);
			if (activate) composer!.handleInput("\t"); // apply the completion without submitting
		} else return;
		tuiRef?.requestRender();
		scheduleRender(0);
	};

	const runAction = (act: string, target = "", value?: string) => {
		if (target === SHEET_ID) {
			currentSheet()?.act(act, value);
			tuiRef?.requestRender();
			return scheduleRender(0);
		}
		if (target === SELECT_ID || target.startsWith(`${SELECT_ID}.`) || target.startsWith(`${SELECT_ID}/`)) {
			const sel = shownSelector() as unknown as
				| { options: string[]; selectedIndex: number; onSelectCallback(o: string): void; onCancelCallback(): void }
				| undefined;
			if (!sel) return;
			if (act === "confirm") {
				const option = sel.options[sel.selectedIndex];
				if (option !== undefined) sel.onSelectCallback(option);
			} else if (act === "close") sel.onCancelCallback();
			tuiRef?.requestRender();
			scheduleRender(0);
			return;
		}
		if (act === "dialog.submit" || act === "dialog.cancel") {
			const dlg = activeTextDialog();
			if (!dlg) return;
			if (act === "dialog.submit") dlg.submit();
			else dlg.cancel();
			tuiRef?.requestRender();
			scheduleRender(0);
			return;
		}
		if (act === "remove-image") {
			const n = Number(/img(\d+)/.exec(target)?.[1]);
			const image = composerImages.find((a) => a.n === n);
			if (composer && image) {
				const text = composer.getText();
				let from = image.from;
				let to = image.to;
				if (text[to] === " ") to++;
				else if (from > 0 && text[from - 1] === " ") from--;
				composer.setText(text.slice(0, from) + text.slice(to));
				scheduleRender(0);
			}
			return;
		}
		if (act === "copy-message" || act === "copy-answer") {
			const owner = target.split(/[./]/)[0] ?? "";
			const value = copyTexts.get(owner);
			if (value) {
				rawWrite(`\x1b]52;c;${Buffer.from(value, "utf8").toString("base64")}\x07`);
				toast(act === "copy-answer" ? "Reply copied" : "Message copied");
			}
			return;
		}
		const ed = composer as unknown as { actionHandlers?: Map<string, () => void> } | undefined;
		switch (act) {
			case "submit":
				composer?.handleInput("\r");
				break;
			case "status.cost":
				usageOpen = !usageOpen;
				break;
			case "usage.close":
				usageOpen = false;
				break;
			case "queue.edit":
				ed?.actionHandlers?.get("app.message.dequeue")?.();
				break;
			case "interrupt":
				ctxRef?.abort();
				break;
			case "status.model":
				ed?.actionHandlers?.get("app.model.select")?.();
				break;
			case "thinking.cycle":
				ed?.actionHandlers?.get("app.thinking.cycle")?.();
				break;
			default:
				return;
		}
		tuiRef?.requestRender();
		scheduleRender();
	};

	// ---------- surface lifecycle ----------
	const openSurface = () => {
		sf = `pi:${++shared.surfaces}`;
		seq = 0;
		unacked = [];
		lastFocus = undefined;
		reconciler.reset();
		blobAnnounced.clear();
		blobQueries.length = 0;
		backlog = [];
		const open = { id: sf, mode: "inline", title: "pi", role: "omp.session" };
		log("out", "o", open);
		rawWrite(encode("o", open));
		sendLogo();
		if (hello?.features?.includes("styles")) rawWrite(encode("s", { sf, name: "pi", css: PI_STYLES }));
		send([
			["add", "main", sf, null, { id: "main", k: "col" }],
			["add", "dock", sf, null, { id: "dock", k: "col" }],
			["add", "layer", sf, null, { id: "layer", k: "col" }],
		]);
		scheduleRender(0);
	};

	/**
	 * Content-addressed blobs (as omp does): written into Tern's blob cache when it has one and
	 * announced with a `blobs` query; sent inline (chunked) when Tern says it does not have them.
	 */
	const blobStore = new Map<string, { bytes: Buffer; mime: string }>();
	const blobAnnounced = new Set<string>();
	const blobQueries: string[][] = [];
	const registerBlob = (bytes: Buffer, mime: string, knownId?: string): string => {
		const id = knownId ?? createHash("sha256").update(bytes).digest("hex");
		if (blobAnnounced.has(id)) return id;
		blobAnnounced.add(id);
		blobStore.set(id, { bytes, mime });
		const dir = process.env.TERN_BLOB_DIR;
		if (dir) {
			try {
				const file = join(dir, id);
				if (!existsSync(file)) writeFileSync(file, bytes);
				blobQueries.push([id]);
				rawWrite(encode("q", { q: "blobs", ids: [id] }));
				return id;
			} catch {
				/* fall through to inline */
			}
		}
		sendBlobInline(id);
		return id;
	};
	const sendBlobInline = (id: string) => {
		const blob = blobStore.get(id);
		if (blob) rawWrite(encodeRaw("b", { id, mime: blob.mime }, blob.bytes.toString("base64"), apcLimit));
	};
	const sendLogo = () => void registerBlob(PI_LOGO.bytes, PI_LOGO.mime, PI_LOGO.id);

	/** Image files referenced by path in a message, each registered as a blob. */
	type Attachment = { n: number; path: string; from: number; to: number; id: string; w?: number; h?: number };
	const imageFiles = new Map<string, { mtime: number; id: string; w?: number; h?: number } | null>();
	const imageFile = (path: string) => {
		try {
			const st = statSync(path);
			if (!st.isFile() || st.size === 0 || st.size > MAX_IMAGE_BYTES) return null;
			const cached = imageFiles.get(path);
			if (cached && cached.mtime === st.mtimeMs) return cached;
			const bytes = readFileSync(path);
			const ext = path.split(".").pop()!.toLowerCase();
			const entry = { mtime: st.mtimeMs, id: registerBlob(bytes, IMAGE_MIME[ext] ?? "image/png"), ...imageSize(bytes) };
			imageFiles.set(path, entry);
			return entry;
		} catch {
			return null;
		}
	};
	const findImages = (text: string): Attachment[] => {
		const out: Attachment[] = [];
		for (const m of text.matchAll(IMAGE_PATH)) {
			const info = imageFile(m[0]);
			if (!info) continue;
			out.push({ n: out.length + 1, path: m[0], from: m.index!, to: m.index! + m[0].length, id: info.id, w: info.w, h: info.h });
		}
		return out;
	};
	/** Text with the attachment paths taken out and the leftover whitespace tidied. */
	const withoutImages = (text: string, images: Attachment[]) => {
		let out = text;
		for (const a of [...images].reverse()) out = out.slice(0, a.from) + out.slice(a.to);
		return out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "").trim();
	};
	let composerImages: Attachment[] = [];

	const send = (ops: Op[]) => {
		seq++;
		unacked.push(Date.now());
		log("out", "f", { sf, s: seq, ops });
		rawWrite(encode("f", { sf, s: seq, ops }, apcLimit));
	};

	const scheduleRender = (delay = 16) => {
		if (!active || renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			render();
		}, delay);
	};

	/**
	 * Large updates (opening a long session) are split into frames of about FRAME_BUDGET characters
	 * and sent in order as Tern acknowledges them. One multi-megabyte frame arrived corrupted through
	 * the Windows console layer ("malformed f body"), and smaller frames keep Tern responsive.
	 */
	const FRAME_BUDGET = 160_000;
	let backlog: Op[][] = [];

	/** True when a frame may go out now; otherwise arranges a retry when credits come back. */
	const haveCredit = (): boolean => {
		if (unacked.length < credits) return true;
		const waited = Date.now() - unacked[0]!;
		if (waited < 5000) {
			if (!stallTimer) stallTimer = setTimeout(() => ((stallTimer = undefined), scheduleRender(0)), 5000 - waited);
			return false;
		}
		unacked = []; // terminal stopped acknowledging: carry on without credits, as omp does
		return true;
	};

	const flushBacklog = (): boolean => {
		while (backlog.length > 0) {
			if (!haveCredit()) return false;
			send(backlog.shift()!);
		}
		return true;
	};

	const queueFrames = (ops: Op[]) => {
		let batch: Op[] = [];
		let size = 0;
		for (const op of ops) {
			const opSize = JSON.stringify(op).length;
			if (batch.length > 0 && size + opSize > FRAME_BUDGET) {
				backlog.push(batch);
				batch = [];
				size = 0;
			}
			batch.push(op);
			size += opSize;
		}
		if (batch.length > 0) backlog.push(batch);
	};

	const render = () => {
		if (!active || !ctxRef) return;
		// Earlier frames first: the reconciler already counts them as sent.
		if (!flushBacklog() || !haveCredit()) return;
		let ops: Op[] = [];
		const began = performance.now();
		try {
			reconciler.region("main", describeMain(), ops);
			const dock = describeDock();
			reconciler.region("dock", dock.nodes, ops);
			const overlay = autocompleteOverlay();
			const card = usageCard();
			const selector = shownSelector();
			const layer = [overlay, card, selector ? selectorPicker(selector) : null, currentSheet()?.node ?? null, ...overlayNodes()];
			reconciler.region("layer", layer.filter((x): x is TspNode => !!x), ops);
			if (dock.focus !== lastFocus) {
				ops.push(["focus", dock.focus]);
				lastFocus = dock.focus;
			}
		} catch (error) {
			ops = [];
			ctxRef.ui.notify(`tern-native: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		if (logPath) log("perf", "render", { ms: +(performance.now() - began).toFixed(2), ops: ops.length });
		if (ops.length > 0) {
			queueFrames(ops);
			flushBacklog();
		}
	};

	// ---------- describe: transcript ----------
	const containers = () => {
		const kids = (tuiRef as unknown as { children?: Component[] } | undefined)?.children ?? [];
		const doc = kids[0] as unknown as { children?: Component[] } | undefined;
		return {
			chat: doc?.children?.[2] as unknown as { children: Component[] } | undefined,
			pending: kids[1],
			status: kids[2],
			above: kids[3],
			editor: kids[4] as unknown as { children: Component[] } | undefined,
			below: kids[5],
		};
	};

	/** SGR foreground → Tern style, learned from the active pi theme. */
	let sgrStyles: { theme: unknown; map: Map<string, string> } | undefined;
	const styleOfSgr = (sgr: string): string | undefined => {
		const theme = ctxRef?.ui.theme;
		if (!theme) return undefined;
		if (sgrStyles?.theme !== theme) {
			const map = new Map<string, string>();
			for (const token of ["error", "warning", "success", "accent", "muted", "dim"] as const) {
				const probe = theme.fg(token, "\u0000");
				const m = /\x1b\[([0-9;:]*)m/.exec(probe);
				if (m?.[1] && !map.has(m[1])) map.set(m[1], token);
			}
			sgrStyles = { theme, map };
		}
		return sgrStyles.map.get(sgr);
	};

	/** Tern's chat column is narrower than the pane: render fallbacks to fit it. */
	const readerCols = () => Math.max(20, Math.min(cols - 4, 104));

	const ansiNode = (comp: Component, idPrefix: string, role: string, width = readerCols()): TspNode | null => {
		let lines: string[];
		try {
			lines = trimBlank(comp.render(width));
		} catch {
			return null;
		}
		if (lines.length === 0) return null;
		lines = lines.map(trimRight);
		const key = `${width}\n${lines.join("\n")}`;
		const cached = nodeCache.get(comp);
		if (cached?.key === key) return cached.node;
		const node = n("ansi", { role, text: lines.join("\n") }, undefined, idOf(comp, idPrefix));
		nodeCache.set(comp, { key, node });
		return node;
	};

	let welcomeCache: { tip: number; node: TspNode } | undefined;
	const welcome = (): TspNode => {
		if (welcomeCache?.tip === tipIndex) return welcomeCache.node;
		const node = buildWelcome();
		welcomeCache = { tip: tipIndex, node };
		return node;
	};
	const buildWelcome = (): TspNode =>
		n(
			"card",
			{ role: "omp.welcome" },
			[
				row(
					[
						n("image", { blob: PI_LOGO.id, alt: "pi", w: 128, role: "omp.welcome.logo" }, undefined, "logo"),
						col(
							[
								spans([span("pi", "strong")], { wrap: "none", role: "omp.welcome.wordmark" }, "wordmark"),
								spans([span(`v${VERSION}`, "dim mono")], { wrap: "none", role: "omp.welcome.version" }, "version"),
							],
							{ role: "omp.welcome.mark" },
							"mark",
						),
					],
					{ align: "center", gap: "md", role: "omp.welcome.lockup" },
					"lockup",
				),
				row(
					[icon("lightbulb", { role: "omp.welcome.tip-icon" }, "icon"), text(TIPS[tipIndex]!, { wrap: "word", role: "omp.welcome.tip-text" }, "text")],
					{ gap: "sm", align: "start", role: "omp.welcome.tip" },
					"tip",
				),
			],
			"welcome",
		);

	/** omp's transient toasts: added to the transcript, gone after their ttl. */
	let toasts: { id: string; text: string; until: number }[] = [];
	let toastSeq = 0;
	const toast = (message: string, ttl = 2400) => {
		toasts.push({ id: `toast${toastSeq++}`, text: message, until: Date.now() + ttl + 400 });
		setTimeout(() => scheduleRender(), ttl + 500);
		scheduleRender(0);
	};

	const describeMain = (): TspNode[] => {
		const out: TspNode[] = [n("spacer", { size: "sm" }, undefined, "top"), welcome()];
		const chat = containers().chat;
		const live = new Set<string>();
		for (const comp of chat?.children ?? []) {
			const node = describeChat(comp);
			if (!node) continue;
			out.push(node);
			if (node.id) live.add(node.id);
		}
		// copy texts of messages no longer shown (after /new, /resume, /tree) can go
		if (copyTexts.size > live.size) for (const id of copyTexts.keys()) if (!live.has(id)) copyTexts.delete(id);
		const now = Date.now();
		toasts = toasts.filter((t) => t.until > now);
		for (const t of toasts) out.push(n("toast", { text: t.text, ttl: 2400, role: "omp.toast.status" }, undefined, t.id));
		out.push(n("spacer", { size: "sm" }, undefined, "end"));
		return out;
	};

	const memo = (comp: object, key: string, build: () => TspNode): TspNode => {
		const cached = nodeCache.get(comp);
		if (cached?.key === key) return cached.node;
		const node = build();
		nodeCache.set(comp, { key, node });
		return node;
	};

	const describeChat = (comp: Component): TspNode | null => {
		if (comp instanceof Spacer || comp instanceof DynamicBorder) return null;
		if (comp instanceof UserMessageComponent) return userNode(comp);
		if (comp instanceof AssistantMessageComponent) return assistantNode(comp);
		if (comp instanceof ToolExecutionComponent) return toolNode(comp);
		if (comp instanceof BashExecutionComponent) return userBashNode(comp);
		if (comp instanceof CompactionSummaryMessageComponent) return summaryNode(comp, "compaction");
		if (comp instanceof BranchSummaryMessageComponent) return summaryNode(comp, "branch");
		if (comp instanceof SkillInvocationMessageComponent) return skillNode(comp);
		if (comp instanceof CustomMessageComponent) {
			const node = customNode(comp);
			if (node) return node;
		}
		// Plain text and markdown travel unwrapped, so Tern wraps them to its own column.
		if (comp instanceof Markdown) {
			const raw = (comp as unknown as { text?: string }).text;
			if (typeof raw === "string" && raw.trim()) return memo(comp, raw, () => md(raw.trim(), {}, idOf(comp, "m")));
		}
		if (comp instanceof Text) {
			const raw = (comp as unknown as { text?: string }).text;
			if (typeof raw === "string" && stripAnsi(raw).trim()) {
				return memo(comp, raw, () => noticeNode(raw.trim(), idOf(comp, "n")));
			}
		}
		return ansiNode(comp, "x", "pi.block");
	};

	/** pi's status lines as omp's transcript notices: an icon and word-wrapped text. */
	const noticeNode = (raw: string, id: string): TspNode => {
		let parts = ansiToSpans(raw, styleOfSgr);
		const styles = new Set(parts.map((p) => p.s?.split(" ").find((t) => t === "error" || t === "warning" || t === "success")));
		const kind = styles.has("error") ? "error" : styles.has("warning") ? "warning" : styles.has("success") ? "success" : "info";
		// The icon carries the label, as in omp: drop a leading "Warning:" / "Error:".
		if (parts[0]) {
			const t = parts[0].t.replace(/^\s*(warning|error)\s*:\s*/i, "");
			parts = t ? [{ ...parts[0], t }, ...parts.slice(1)] : parts.slice(1);
		}
		const plain = parts.map((p) => ({ t: p.t, s: p.s?.split(" ").filter((t) => t === "strong" || t === "em").join(" ") || undefined }));
		return row(
			[
				icon(kind, { tone: kind === "info" ? undefined : kind, aria: kind === "warning" ? "Warning" : kind === "error" ? "Error" : undefined }, "icon"),
				spans(plain, { wrap: "word", grow: 1, shrink: 1 }, "text"),
			],
			{ role: `omp.notice.${kind}`, tone: kind, gap: "sm", align: "start" },
			id,
		);
	};

	/**
	 * History-collapse points as omp draws them: a slim collapsible divider ("Compacted · 142K
	 * tokens before", "Branch summarized") whose body is the summary.
	 */
	const summaryNode = (comp: object, kind: "compaction" | "branch"): TspNode => {
		const m = (comp as { message?: { summary?: string; tokensBefore?: number } }).message ?? {};
		const summary = String(m.summary ?? "").trim();
		const before = typeof m.tokensBefore === "number" ? m.tokensBefore : 0;
		return memo(comp, `${kind}|${before}|${summary}`, () =>
			n(
				"section",
				{
					role: kind === "compaction" ? "omp.compaction" : "omp.branch",
					head:
						kind === "compaction"
							? [span("Compacted", "muted"), ...(before > 0 ? [span(` \u00b7 ${fmtTokens(before)} tokens before`, "muted mono")] : [])]
							: [span("Branch summarized", "muted")],
					collapsible: true,
					collapsed: true,
				},
				[
					...(kind === "compaction"
						? [spans([span("Summary of the earlier conversation", "dim")], { role: "omp.compaction.caption" }, "caption")]
						: []),
					md(summary || "(no summary)", {}, "summary"),
				],
				idOf(comp, kind === "compaction" ? "c" : "r"),
			),
		);
	};

	/** A skill invocation: collapsed "Skill <name>", the skill's instructions inside. */
	const skillNode = (comp: SkillInvocationMessageComponent): TspNode => {
		const b = (comp as unknown as { skillBlock?: { name?: string; location?: string; content?: string } }).skillBlock ?? {};
		const name = String(b.name ?? "skill");
		const content = String(b.content ?? "").trim();
		return memo(comp, `${name}|${content}`, () =>
			n(
				"section",
				{ role: "omp.skill", head: [span("Skill ", "muted"), span(name, "strong")], title: b.location, collapsible: true, collapsed: true },
				content ? [md(content, {}, "body")] : [],
				idOf(comp, "k"),
			),
		);
	};

	/**
	 * An extension's message (`pi.sendMessage`) without a renderer of its own: its type as the head
	 * and the text as markdown. Messages an extension renders itself stay its own rendering (null).
	 */
	const customNode = (comp: CustomMessageComponent): TspNode | null => {
		const c = comp as unknown as { customComponent?: unknown; message?: { customType?: string; content?: unknown } };
		if (c.customComponent || !c.message) return null;
		const content = c.message.content;
		const body = (
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((p: any) => p?.type === "text" && typeof p.text === "string")
							.map((p: any) => p.text)
							.join("\n")
					: ""
		).trim();
		const type = String(c.message.customType ?? "message");
		return memo(comp, `${type}|${body}`, () =>
			n("card", { role: "omp.custom", head: [span(type, "strong")] }, body ? [md(body, {}, "body")] : [], idOf(comp, "x")),
		);
	};

	/** Copyable text per transcript node, for the copy buttons and hold menus. */
	const copyTexts = new Map<string, string>();

	const userNode = (comp: UserMessageComponent): TspNode => {
		const c = comp as unknown as { text: string; timestamp?: string };
		const cached = nodeCache.get(comp);
		if (cached) return cached.node;
		const time = clock(c.timestamp ?? Date.now());
		const id = idOf(comp, "u");
		copyTexts.set(id, c.text);
		const images = findImages(c.text);
		const body = images.length > 0 ? withoutImages(c.text, images) : c.text;
		const stamp = c.timestamp ? new Date(c.timestamp) : undefined;
		const node = n(
			"card",
			{
				role: "omp.user",
				tone: "user",
				actions: { hold: [{ id: "copy-message", label: "Copy message", icon: "copy" }] },
			},
			[
				row(
					[
						icon("copy", { role: "omp.user.tool", title: "Copy message", aria: "Copy message", actions: { click: "copy-message" } }, "copy"),
						...(time
							? [
									text("\u00b7", {}, "dot"),
									spans([span(time, "dim mono")], { role: "omp.user.time", title: stamp && !Number.isNaN(stamp.getTime()) ? stamp.toLocaleString() : undefined }, "time"),
								]
							: []),
					],
					{ gap: "xs", align: "center", role: "omp.user.tools" },
					"tools",
				),
				...(images.length > 0
					? [
							row(
								images.map((a) => n("image", { blob: a.id, alt: `#${a.n}`, title: `#${a.n}`, w: a.w, h: a.h }, undefined, `i${a.n}`)),
								{ gap: "sm", wrap: true, align: "start", role: "omp.user.images" },
								"images",
							),
						]
					: []),
				...(body ? [md(body, {}, "body")] : []),
			],
			id,
		);
		nodeCache.set(comp, { key: "", node });
		return node;
	};

	/** When each thinking block was seen live, for omp's "Thought for 4s" heads. */
	const thinkingClock = new WeakMap<object, Map<number, { start: number; end?: number }>>();
	const markThinking = (comp: object, index: number, live: boolean) => {
		let blocks = thinkingClock.get(comp);
		if (!blocks) thinkingClock.set(comp, (blocks = new Map()));
		const entry = blocks.get(index);
		if (live && !entry) blocks.set(index, { start: Date.now() });
		else if (!live && entry && entry.end === undefined) entry.end = Date.now();
	};
	const thoughtLabel = (comp: object, index: number) => {
		const entry = thinkingClock.get(comp)?.get(index);
		if (!entry?.end) return "Thought";
		const ms = entry.end - entry.start;
		return `Thought for ${ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`}`;
	};

	/** Turn totals (all assistant messages of one run) and the run's duration, for omp.turn.usage. */
	const turnUsage = new WeakMap<object, { ms?: number; input: number; output: number; cost: number }>();
	let runStats = { start: 0, input: 0, output: 0, cost: 0 };

	const assistantNode = (comp: AssistantMessageComponent): TspNode | null => {
		const c = comp as unknown as { lastMessage?: AssistantMessage; isStreaming?: boolean; hideThinkingBlock?: boolean };
		const msg = c.lastMessage;
		if (!msg) return null;
		const streaming = c.isStreaming === true;
		const sig = [
			streaming,
			msg.stopReason,
			msg.usage?.output ?? 0,
			c.hideThinkingBlock === true,
			...(msg.content ?? []).map((b: any) => `${b.type}:${(b.text ?? b.thinking ?? "").length}`),
		].join("|");
		const cached = nodeCache.get(comp);
		if (cached?.key === sig) return cached.node;

		const kids: TspNode[] = [];
		const blocks = msg.content ?? [];
		blocks.forEach((block: any, i: number) => {
			const last = i === blocks.length - 1;
			if (block.type === "text" && block.text?.trim()) {
				kids.push(md(block.text.trim(), streaming && last ? { stream: true } : {}, `t${i}`));
			} else if (block.type === "thinking" && block.thinking?.trim() && !c.hideThinkingBlock) {
				const live = streaming && last;
				markThinking(comp, i, live);
				kids.push(
					n(
						"section",
						{ role: live ? "omp.thinking.live" : "omp.thinking", collapsible: true, collapsed: !live },
						[
							live
								? row(
										[n("spinner", { style: "starburst", role: "omp.thinking.spin" }), spans([span("Thinking…", "muted")])],
										{ gap: "sm" },
										"head",
									)
								: spans([span(thoughtLabel(comp, i), "muted")], {}, "head"),
							md(block.thinking.trim(), live ? { stream: true } : {}, "body"),
						],
						`k${i}`,
					),
				);
			}
		});

		const hasTools = blocks.some((b: any) => b.type === "toolCall");
		if (!streaming && (msg.stopReason === "error" || msg.stopReason === "aborted") && !hasTools) {
			const message = (msg.errorMessage ?? "").trim() || (msg.stopReason === "aborted" ? "Interrupted" : "Unknown error");
			if (msg.stopReason === "aborted") {
				kids.push(spans([span(message, "error")], { wrap: "word", role: "omp.assistant.abort" }, "error"));
			} else {
				kids.push(
					n(
						"card",
						{ role: "omp.error", tone: "error" },
						[
							row([spans([span("Request failed", "error strong")])], { gap: "sm" }, "head"),
							spans([span(message, "mono")], { wrap: "word", role: "omp.error.message" }, "message"),
						],
						"error",
					),
				);
			}
		}

		const id = idOf(comp, "a");
		const answer = blocks
			.filter((b: any) => b.type === "text" && b.text?.trim())
			.map((b: any) => b.text.trim())
			.join("\n\n");
		if (answer) copyTexts.set(id, answer);
		const final = !streaming && msg.stopReason === "stop" && !!msg.usage;
		if (final) {
			let totals = turnUsage.get(comp);
			if (!totals) {
				const u = msg.usage!;
				const own = { input: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), output: u.output ?? 0, cost: u.cost?.total ?? 0 };
				const live = runStats.start > 0 && (running || Date.now() - runStats.start < 600_000) && runStats.input > 0;
				totals = live
					? { ms: Date.now() - runStats.start, input: runStats.input, output: runStats.output, cost: runStats.cost }
					: own;
				turnUsage.set(comp, totals);
			}
			const tokens = totals.input + totals.output;
			const parts: string[] = [];
			if (totals.ms !== undefined) parts.push(`${(totals.ms / 1000).toFixed(1)}s`);
			parts.push(`${fmtTokens(tokens)} tok`);
			if (totals.cost >= 0.005) parts.push(`$${totals.cost.toFixed(2)}`);
			kids.push(
				row(
					[
						...(answer
							? [
									icon("copy", { role: "omp.turn.copy", title: "Copy answer", aria: "Copy answer", actions: { click: "copy-answer" } }, "copy"),
									text("\u00b7", {}, "dot"),
								]
							: []),
						text(`${parts.join(" \u00b7 ")} this turn`, {}, "text"),
					],
					{
						role: "omp.turn.usage",
						gap: "xs",
						align: "center",
						title: `This turn: ${[
							totals.ms !== undefined ? `${(totals.ms / 1000).toFixed(1)}s` : undefined,
							`${tokens.toLocaleString()} tokens (${totals.input.toLocaleString()} in \u00b7 ${totals.output.toLocaleString()} out)`,
							totals.cost >= 0.005 ? `$${totals.cost.toFixed(2)}` : undefined,
						]
							.filter(Boolean)
							.join(" \u00b7 ")}`,
					},
					"turn-usage",
				),
			);
		}

		if (kids.length === 0) return null;
		const node = col(
			kids,
			final && answer ? { role: "omp.assistant", actions: { hold: [{ id: "copy-answer", label: "Copy reply", icon: "copy" }] } } : { role: "omp.assistant" },
			id,
		);
		nodeCache.set(comp, { key: sig, node });
		return node;
	};

	const runFoot = (status: string, age: number | undefined, took: number | undefined, exit?: number): TspNode => {
		const state =
			status === "running"
				? spans([span("Running")], { role: "omp.run.state", tone: "pending" }, "state")
				: status === "error"
					? spans([span(exit !== undefined ? `Exit ${exit}` : "Failed")], { role: "omp.run.state", tone: "error" }, "state")
					: spans([span("Done")], { role: "omp.run.state", tone: "success" }, "state");
		const elapsed =
			took !== undefined
				? n("elapsed", { role: "omp.run.time", age: took, stopped: took, format: "short" }, undefined, "time")
				: n("elapsed", { role: "omp.run.time", age: age ?? 0, format: "short" }, undefined, "time");
		return row([state, elapsed], { role: "omp.run.foot", gap: "sm", align: "center" }, "foot");
	};

	const toolNode = (comp: ToolExecutionComponent): TspNode => {
		const c = comp as unknown as {
			toolName: string;
			toolCallId: string;
			args: any;
			result?: { content: any[]; details?: any; isError: boolean; durationMs?: number };
			isPartial?: boolean;
		};
		const done = !!c.result && !c.isPartial;
		const cached = nodeCache.get(comp);
		if (done && cached?.key === `done:${cols}`) return cached.node;

		const clockEntry = toolClock.get(comp) ?? { start: Date.now() };
		toolClock.set(comp, clockEntry);
		if (done && clockEntry.end === undefined) clockEntry.end = Date.now();
		const status = !done ? "running" : c.result!.isError ? "error" : "done";
		const took = done ? (c.result!.durationMs ?? clockEntry.end! - clockEntry.start) : undefined;
		const age = done ? undefined : 0;
		const args = c.args ?? {};
		const out = resultText(c.result);
		const name = c.toolName;
		const resultImages = done
			? (c.result!.content ?? [])
					.filter((part: any) => part?.type === "image" && typeof part.data === "string")
					.map((part: any) => {
						const bytes = Buffer.from(part.data, "base64");
						return { id: registerBlob(bytes, part.mimeType ?? "image/png"), ...imageSize(bytes) };
					})
			: [];
		const base = {
			role: `omp.tool.${name}`,
			key: c.toolCallId,
			name,
			status,
			age,
			took,
			collapsible: true,
		};
		let node: TspNode;

		if (name === "bash") {
			const exit = typeof c.result?.details?.exitCode === "number" ? c.result.details.exitCode : undefined;
			node = n(
				"tool",
				{ ...base, title: "Bash", command: args.command, frame: "inline", collapsed: true, preview: "children" },
				[
					col(
						[
							n("code", { role: "omp.tool.bash.command", lang: "bash", wrap: true, preview: { lines: 6 }, text: String(args.command ?? "") }, undefined, "input"),
							...(out ? [n("ansi", { role: "omp.tool.bash.output", follow: true, preview: { lines: 10 }, text: out }, undefined, "output")] : []),
							runFoot(status, age, took, exit),
						],
						{ role: "omp.run", gap: "none" },
						"run",
					),
				],
				idOf(comp, "t"),
			);
		} else if (name === "read" && resultImages.length > 0) {
			const path = args.path ?? args.file_path;
			node = n(
				"tool",
				{ ...base, title: "Read", target: path, targetKind: "file", frame: "card", collapsed: false },
				resultImages.map((img, i) =>
					n("image", { blob: img.id, alt: path, title: path, w: img.w, h: img.h, max: { h: "14lines" }, role: "omp.tool.read.image" }, undefined, `img${i}`),
				),
				idOf(comp, "t"),
			);
		} else if (name === "read" || name === "write") {
			const path = args.path ?? args.file_path;
			const body = name === "write" ? String(args.content ?? "") : out;
			node = n(
				"tool",
				{
					...base,
					title: name === "read" ? "Read" : "Write",
					target: path,
					targetKind: "file",
					lang: langOf(path),
					frame: "card",
					collapsed: true,
					preview: { lines: 8 },
				},
				status === "error"
					? [spans([span(out || "Failed", "error")], { wrap: "word", role: "omp.tool.error" }, "error")]
					: body
						? [n("code", { role: `omp.tool.${name}.preview`, lang: langOf(path), text: body }, undefined, "body")]
						: [],
				idOf(comp, "t"),
			);
		} else if (name === "edit") {
			const path = args.path ?? args.file_path;
			const patch: string | undefined = c.result?.details?.patch ?? c.result?.details?.diff;
			node = n(
				"tool",
				{ ...base, title: "Edit", target: path, targetKind: "file", lang: langOf(path), frame: "card", collapsed: false, preview: { lines: 16 } },
				status === "error"
					? [spans([span(out || "Failed", "error")], { wrap: "word", role: "omp.tool.error" }, "error")]
					: patch
						? [n("diff", { text: patch, lang: langOf(path) }, undefined, "diff")]
						: [],
				idOf(comp, "t"),
			);
		} else {
			const summary = Object.entries(args)
				.filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
				.map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").slice(0, 80)}`)
				.join("  ");
			const title = name.charAt(0).toUpperCase() + name.slice(1);
			node = n(
				"tool",
				{ ...base, title, meta: summary || undefined, frame: "card", collapsed: true, preview: { lines: 8 } },
				out ? [n("ansi", { role: "omp.tool.output", text: out }, undefined, "output")] : [],
				idOf(comp, "t"),
			);
		}
		if (done) nodeCache.set(comp, { key: `done:${cols}`, node });
		return node;
	};

	const userBashNode = (comp: BashExecutionComponent): TspNode => {
		const c = comp as unknown as { command: string; status?: string; exitCode?: number; getOutput(): string };
		const status = c.status === "running" ? "running" : c.status === "complete" && (c.exitCode ?? 0) === 0 ? "done" : c.status === "running" ? "running" : "error";
		const clockEntry = toolClock.get(comp) ?? { start: Date.now() };
		toolClock.set(comp, clockEntry);
		if (status !== "running" && clockEntry.end === undefined) clockEntry.end = Date.now();
		const took = status === "running" ? undefined : clockEntry.end! - clockEntry.start;
		const output = stripAnsi(c.getOutput?.() ?? "").replace(/\s+$/, "");
		return n(
			"tool",
			{ role: "omp.tool.bash", name: "bash", title: "Bash", command: c.command, status, age: status === "running" ? 0 : undefined, took, frame: "inline", collapsible: true, collapsed: true, preview: "children" },
			[
				col(
					[
						n("code", { role: "omp.tool.bash.command", lang: "bash", wrap: true, text: c.command }, undefined, "input"),
						...(output ? [n("ansi", { role: "omp.tool.bash.output", follow: true, preview: { lines: 10 }, text: output }, undefined, "output")] : []),
						runFoot(status, status === "running" ? 0 : undefined, took, c.exitCode),
					],
					{ role: "omp.run", gap: "none" },
					"run",
				),
			],
			idOf(comp, "b"),
		);
	};

	// ---------- describe: dock ----------
	const describeDock = (): { nodes: TspNode[]; focus: string | null } => {
		const k = containers();
		const nodes: TspNode[] = [];
		const push = (node: TspNode | null) => node && nodes.push(node);
		if (k.pending) {
			const described = pendingNodes(k.pending);
			if (described) nodes.push(...described);
			else push(ansiNode(k.pending, "p", "pi.pending"));
		}
		if (running) nodes.push(hud());
		else if (k.status) push(ansiNode(k.status, "s", "pi.status"));
		if (k.above) push(ansiNode(k.above, "wa", "pi.widgets"));

		let focus: string | null = null;
		const shown = k.editor?.children?.[0];
		if (composer && shown === composer) {
			nodes.push(composerNode(composer));
			focus = "composer.line/input";
		} else if (activeTextDialog()) {
			nodes.push(inputDialogNode(activeTextDialog()!));
			focus = DIALOG_INPUT;
		} else if (shown instanceof ExtensionSelectorComponent || isSheet(shown)) {
			// drawn as a picker sheet in the layer (selectorPicker, currentSheet); keys still reach it through the pty
		} else if (shown) {
			// a selector, dialog or custom component replaced the editor: keys go to it through the pty
			push(ansiNode(shown, "d", "pi.dialog"));
		}
		if (k.below) push(ansiNode(k.below, "wb", "pi.widgets"));
		// an extension overlay holding the keyboard: the composer must not look focused under it
		if (focusedOverlay()) focus = null;
		return { nodes, focus };
	};

	/**
	 * pi's pending area: `!` commands still running while the agent works, then the queued steering
	 * and follow-up messages as text lines. Described natively when it holds only those (bash cards
	 * and omp's queue pills); anything else and the area falls back to pi's own rendering (null).
	 */
	const pendingNodes = (pending: Component): TspNode[] | null => {
		const kids = (pending as unknown as { children?: Component[] }).children ?? [];
		const out: TspNode[] = [];
		const queued: { kind: string; text: string }[] = [];
		for (const kid of kids) {
			if (kid instanceof Spacer) continue;
			if (kid instanceof BashExecutionComponent) {
				out.push(userBashNode(kid));
				continue;
			}
			const raw = (kid as unknown as { text?: unknown }).text;
			if (typeof raw !== "string") return null;
			const line = stripAnsi(raw);
			const m = /^\s*(Steering|Follow-up): ([\s\S]*)$/.exec(line);
			if (m) queued.push({ kind: m[1]!, text: m[2]! });
			else if (!/to edit all queued messages\s*$/.test(line)) return null;
		}
		if (queued.length > 0) out.push(queueNode(queued));
		return out;
	};

	const queueNode = (queued: { kind: string; text: string }[]): TspNode => {
		const key = keybindingsRef?.getKeys("app.message.dequeue" as never)?.[0] as string | undefined;
		const caps = key ? key.split("+").map((k) => (k === "escape" ? "esc" : k)) : [];
		const count = queued.length;
		return col(
			queued.map((q, i) =>
				row(
					[
						icon("corner-down-right", {}, "icon"),
						text(q.text.replace(/\t/g, "    ").replace(/\s*\r?\n\s*/g, " \u21b5 "), { wrap: "none", truncate: "end", grow: 1, shrink: 1 }, "text"),
						...(i === 0 && count > 1 ? [n("badge", { text: `${count} queued`, title: `${count} messages queued`, role: "omp.queue.count" }, undefined, "count")] : []),
						row(
							[...(caps.length > 0 ? [n("kbd", { keys: caps }, undefined, "key")] : []), text("Edit", {}, "label")],
							{ role: "omp.queue.edit", gap: "xs", align: "center", title: key ? `Edit  ${key}` : "Edit", actions: { click: "queue.edit" } },
							"edit",
						),
					],
					{ role: "omp.queue.item", align: "center", gap: "sm", title: q.kind },
					`${q.kind === "Steering" ? "steer" : "follow"}-${i}`,
				),
			),
			{ role: "omp.queue", gap: "xs" },
			"queue",
		);
	};

	// ---------- describe: dialogs and overlays ----------

	/** A dialog's title as plain text, split into its first line and the rest. */
	const dialogTitle = (dlg: object): { title: string; detail: string } => {
		const d = dlg as { titleText?: { text?: string }; baseTitle?: string; listContainer?: object; input?: object; children?: Component[] };
		const [title = "", ...rest] = stripAnsi(d.titleText?.text ?? d.baseTitle ?? "").trim().split(/\r?\n/);
		// the optional description is a Text between the title and the list (or the input field)
		const kids = d.children ?? [];
		const from = kids.indexOf(d.titleText as Component);
		const to = kids.indexOf((d.listContainer ?? d.input) as Component);
		const description =
			from >= 0 && to > from
				? kids
						.slice(from + 1, to)
						.filter((c): c is Text => c instanceof Text)
						.map((c) => stripAnsi((c as unknown as { text?: string }).text ?? "").trim())
						.filter(Boolean)
				: [];
		return { title: title.trim(), detail: [...rest, ...description].join("\n").trim() };
	};

	/** `ctx.ui.select` / `ctx.ui.confirm` as Tern's picker sheet, the way omp draws its hook selector. */
	const SELECT_ID = "select";
	const selectorPicker = (sel: ExtensionSelectorComponent): TspNode => {
		const s = sel as unknown as { options: string[]; selectedIndex: number };
		const { title, detail } = dialogTitle(sel);
		return n(
			"picker",
			{
				role: "omp.overlay.hook-select",
				title,
				subtitle: detail || undefined,
				noun: "options",
				size: "md",
				layout: "rows",
				preview: "none",
				query: null,
				items: s.options.map((label, i) => ({ id: String(i), label })),
				selected: String(s.selectedIndex),
				total: s.options.length,
				actions: [
					{ id: "confirm", label: "Select", keys: ["enter"], primary: true },
					{ id: "close", label: "Cancel", keys: ["esc"], end: true },
				],
			},
			undefined,
			SELECT_ID,
		);
	};
	/**
	 * pi's own selectors (`/model`, `/thinking`, theme, …) as Tern picker sheets: whichever one sits
	 * in the editor slot is described as one `picker` in the layer, with handlers for its pointer
	 * events. Keys still reach the selector through the pty, so search and arrows work as in pi.
	 */
	type Sheet = { node: TspNode; pick(activate: boolean, item: string): void; act(act: string, value?: string): void };
	const SHEET_ID = "sheet";
	const CONFIRM_ACTION = { id: "confirm", label: "Select", keys: ["enter"], primary: true };
	const CLOSE_ACTION = { id: "close", label: "Close", keys: ["esc"], end: true };
	const keyCaps = (binding: string): string[] | undefined => {
		const key = keybindingsRef?.getKeys(binding as never)?.[0] as string | undefined;
		return key ? key.split("+").map((k) => (k === "escape" ? "esc" : k)) : undefined;
	};
	/** `keys` for a picker action from a keybinding, when it is bound. */
	const withKeys = (binding: string) => {
		const keys = keyCaps(binding);
		return keys ? { keys } : {};
	};
	const selectListOf = (comp: unknown): SelectList | undefined => {
		const list = (comp as { selectList?: unknown } | undefined)?.selectList;
		return list instanceof SelectList ? list : undefined;
	};
	const isSessionList = (comp: unknown): comp is SessionSelectorComponent =>
		comp instanceof SessionSelectorComponent && (comp as unknown as { mode?: string }).mode !== "rename";
	const isSheet = (comp: unknown) => comp instanceof ModelSelectorComponent || isSessionList(comp) || !!selectListOf(comp);
	const currentSheet = (): Sheet | undefined => {
		const shown = containers().editor?.children?.[0];
		if (shown instanceof ModelSelectorComponent) return modelSheet(shown);
		if (isSessionList(shown)) return sessionSheet(shown);
		const list = selectListOf(shown);
		return list ? selectListSheet(shown!, list) : undefined;
	};
	/** The search field of a selector that has one, as the picker's query and caret. */
	const sheetQuery = (comp: unknown) => {
		const input = (comp as { searchInput?: { getValue(): string; cursor?: number } }).searchInput;
		return input ? { query: input.getValue(), cursor: input.cursor } : { query: null };
	};

	const modelSheet = (sel: ModelSelectorComponent): Sheet => {
		type Item = { provider: string; id: string; model: { provider: string; id: string; name?: string } };
		const s = sel as unknown as {
			activeModels: Item[];
			filteredModels: Item[];
			allModels: Item[];
			scopedModelItems: Item[];
			selectedIndex: number;
			scope: "all" | "scoped";
			currentModel?: { provider: string; id: string };
			defaultModel?: { provider: string; id: string };
			errorMessage?: string;
			refreshStatusMessage?: string;
			updateList(): void;
			setScope(scope: string): void;
			handleSelect(model: unknown): void;
			dispose(): void;
			onCancelCallback(): void;
			onSelectAsDefaultCallback?: (model: unknown) => void;
		};
		const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
		const filtered = s.filteredModels ?? [];
		const selected = filtered[s.selectedIndex];
		const defaultKey = s.defaultModel ? key(s.defaultModel) : undefined;
		const saveKeys = keyCaps("app.models.save");
		const node = n(
			"picker",
			{
				role: "omp.overlay.model-picker",
				title: "Models",
				icon: "model",
				noun: "models",
				size: "md",
				layout: "rows",
				preview: "none",
				...sheetQuery(sel),
				items: (s.activeModels ?? []).map((it) => ({
					id: key(it),
					label: it.id,
					mono: true,
					detail: it.model?.name && it.model.name !== it.id ? `${it.model.name} \u00b7 ${it.provider}` : it.provider,
					mark: { text: it.provider, icon: `provider:${it.provider}` },
					...(key(it) === defaultKey ? { badges: [{ text: "default" }] } : {}),
				})),
				order: filtered.map(key),
				selected: selected ? key(selected) : null,
				current: s.currentModel ? [key(s.currentModel)] : [],
				total: (s.activeModels ?? []).length,
				...(s.scopedModelItems?.length
					? {
							tabs: [
								{ id: "all", label: "All", count: s.allModels.length },
								{ id: "scoped", label: "Scoped", count: s.scopedModelItems.length },
							],
							tab: s.scope,
						}
					: {}),
				state: s.errorMessage ? "error" : "ready",
				message: s.errorMessage || s.refreshStatusMessage || undefined,
				empty: "No matching models",
				actions: [
					CONFIRM_ACTION,
					...(s.onSelectAsDefaultCallback ? [{ id: "default", label: "Set as default", ...(saveKeys ? { keys: saveKeys } : {}) }] : []),
					CLOSE_ACTION,
				],
			},
			undefined,
			SHEET_ID,
		);
		const chosen = () => s.filteredModels[s.selectedIndex];
		return {
			node,
			pick(activate, item) {
				const index = s.filteredModels.findIndex((it) => key(it) === item);
				if (index < 0) return;
				s.selectedIndex = index;
				s.updateList();
				if (activate) s.handleSelect(s.filteredModels[index]!.model);
			},
			act(act, value) {
				const it = chosen();
				if (act === "confirm" && it) s.handleSelect(it.model);
				else if (act === "default" && it && s.onSelectAsDefaultCallback) {
					s.dispose();
					s.onSelectAsDefaultCallback(it.model);
				} else if (act === "close") {
					s.dispose();
					s.onCancelCallback();
				} else if ((value === "all" || value === "scoped") && s.scopedModelItems?.length) s.setScope(value);
			},
		};
	};

	/** "3h", "2d": how long ago, for picker columns (a fixed string, so the catalogue does not change every render). */
	const ago = (at: unknown): string => {
		const t = at instanceof Date ? at.getTime() : typeof at === "number" || typeof at === "string" ? new Date(at).getTime() : Number.NaN;
		if (!Number.isFinite(t)) return "";
		const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
		if (s < 60) return "now";
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h`;
		const d = Math.floor(h / 24);
		if (d < 30) return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
		return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
	};
	const homeShort = (p: unknown) => {
		const home = process.env.USERPROFILE ?? process.env.HOME;
		const s = String(p ?? "");
		return home && s.toLowerCase().startsWith(home.toLowerCase()) ? `~${s.slice(home.length)}` : s;
	};

	/**
	 * `/resume` as omp's session picker: this folder / all tabs, the sessions as a tree while threaded
	 * (a flat list when sorted or searched), message count and age columns, and Resume, Rename and
	 * Delete (with Tern's confirm strip) as actions. Search keys still go to pi's own field.
	 */
	const sessionSheet = (sel: SessionSelectorComponent): Sheet => {
		type Info = { path: string; name?: string; firstMessage?: string; messageCount?: number; modified?: unknown; cwd?: string };
		type Row = { session: Info; depth: number };
		const c = sel as unknown as {
			sessionList: {
				filteredSessions: Row[];
				allSessions: Info[];
				selectedIndex: number;
				selectionTouched: boolean;
				searchInput: { getValue(): string; cursor?: number };
				confirmingDeletePath: string | null;
				isCurrentSessionPath(p: string): boolean;
				onSelect?: (p: string) => void;
				onCancel?: () => void;
				onRenameSession?: (p: string) => void;
				onDeleteSession?: (p: string) => void;
				startDeleteConfirmationForSelectedSession(): void;
				setConfirmingDeletePath(p: string | null): void;
			};
			header: { loading?: boolean; loadProgress?: { loaded: number; total: number } | null; statusMessage?: { type: string; message: string } | null };
			scope: "current" | "all";
			sortMode: "threaded" | "recent" | "relevance";
			nameFilter: "all" | "named";
			canRename: boolean;
			toggleScope(): void;
			toggleSortMode(): void;
			toggleNameFilter(): void;
		};
		const list = c.sessionList;
		const rows = list.filteredSessions ?? [];
		const query = list.searchInput.getValue();
		const tree = c.sortMode === "threaded" && !query.trim();
		const current: string[] = [];
		const items = rows.map(({ session: s, depth }) => {
			if (list.isCurrentSessionPath(s.path)) current.push(s.path);
			const label = String(s.name ?? s.firstMessage ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim() || "(empty session)";
			return {
				id: s.path,
				label,
				...(c.scope === "all" && s.cwd ? { detail: homeShort(s.cwd) } : {}),
				...(s.name ? { tone: "warning" } : {}),
				...(tree ? { depth } : {}),
				facts: { msgs: s.messageCount ?? 0, age: ago(s.modified) },
				title: homeShort(s.path),
			};
		});
		const sortLabel = c.sortMode === "threaded" ? "Threaded" : c.sortMode === "recent" ? "Recent" : "Fuzzy";
		const deleting = list.confirmingDeletePath;
		const status = c.header.statusMessage;
		const progress = c.header.loadProgress;
		const node = n(
			"picker",
			{
				role: "omp.overlay.sessions",
				title: "Resume session",
				icon: "history",
				noun: "sessions",
				size: "lg",
				layout: tree ? "tree" : "rows",
				preview: "none",
				query,
				cursor: list.searchInput.cursor,
				placeholder: "Search sessions",
				tabs: [
					{ id: "current", label: "This folder" },
					{ id: "all", label: "All" },
				],
				tab: c.scope,
				columns: [
					{ id: "msgs", head: "Msgs", format: "num", priority: 1 },
					{ id: "age", head: "Updated", format: "dim", priority: 2 },
				],
				items,
				selected: rows[list.selectedIndex]?.session.path ?? null,
				current,
				total: (list.allSessions ?? []).length,
				state: c.header.loading ? "loading" : status?.type === "error" ? "error" : "ready",
				message: c.header.loading ? (progress ? `Loading ${progress.loaded}/${progress.total}` : "Loading") : status?.message,
				empty: c.nameFilter === "named" ? "No named sessions" : c.scope === "current" ? "No sessions in this folder" : "No sessions",
				confirm: deleting ? { text: "Delete this session?", act: "delete.confirm", label: "Delete" } : null,
				actions: [
					{ ...CONFIRM_ACTION, label: "Resume" },
					...(c.canRename ? [{ id: "rename", label: "Rename", ...withKeys("app.session.rename") }] : []),
					{ id: "delete", label: "Delete", danger: true, ...withKeys("app.session.delete") },
					{ id: "sort", label: `Sort: ${sortLabel}`, ...withKeys("app.session.toggleSort") },
					{ id: "named", label: "Named only", on: c.nameFilter === "named", ...withKeys("app.session.toggleNamedFilter") },
					CLOSE_ACTION,
				],
			},
			undefined,
			SHEET_ID,
		);
		const selectedPath = () => list.filteredSessions[list.selectedIndex]?.session.path;
		return {
			node,
			pick(activate, item) {
				const index = list.filteredSessions.findIndex((r) => r.session.path === item);
				if (index < 0) return;
				list.selectedIndex = index;
				list.selectionTouched = true;
				if (activate) list.onSelect?.(item);
			},
			act(act, value) {
				const path = selectedPath();
				if (act === "confirm" && path) list.onSelect?.(path);
				else if (act === "close") list.onCancel?.();
				else if (act === "rename" && path) list.onRenameSession?.(path);
				else if (act === "delete") list.startDeleteConfirmationForSelectedSession();
				else if (act === "delete.confirm" && list.confirmingDeletePath) {
					const target = list.confirmingDeletePath;
					list.setConfirmingDeletePath(null);
					list.onDeleteSession?.(target);
				} else if (act === "cancel" && list.confirmingDeletePath) list.setConfirmingDeletePath(null); // Tern's "Keep"
				else if (act === "sort") c.toggleSortMode();
				else if (act === "named") c.toggleNameFilter();
				else if ((value === "current" || value === "all") && value !== c.scope) c.toggleScope();
			},
		};
	};

	/** Any selector built on pi-tui's SelectList (thinking level, theme, …): its texts above the list head the sheet. */
	const selectListSheet = (comp: Component, list: SelectList): Sheet => {
		type Item = { value: string; label?: string; description?: string };
		const l = list as unknown as { filteredItems: Item[]; selectedIndex: number; onSelect?: (i: Item) => void; onCancel?: () => void; onSelectionChange?: (i: Item) => void };
		const kids = (comp as unknown as { children?: Component[] }).children ?? [];
		const before = kids.slice(0, Math.max(0, kids.indexOf(list as unknown as Component)));
		const texts = before
			.filter((c): c is Text => c instanceof Text)
			.map((c) => stripAnsi((c as unknown as { text?: string }).text ?? "").trim())
			.filter(Boolean);
		const items = l.filteredItems ?? [];
		const current: string[] = [];
		const node = n(
			"picker",
			{
				role: "omp.overlay.select",
				title: texts[0] ?? "Select",
				subtitle: texts.slice(1).join("\n") || undefined,
				noun: "options",
				size: "md",
				layout: "rows",
				preview: "none",
				...sheetQuery(comp),
				items: items.map((it) => {
					const raw = stripAnsi(it.label ?? it.value);
					if (/^\s*\u2713/.test(raw)) current.push(it.value);
					return { id: it.value, label: raw.replace(/^[\s\u2713]+/, "") || it.value, ...(it.description ? { detail: stripAnsi(it.description) } : {}) };
				}),
				selected: items[l.selectedIndex]?.value ?? null,
				current,
				empty: "No matching options",
				actions: [CONFIRM_ACTION, CLOSE_ACTION],
			},
			undefined,
			SHEET_ID,
		);
		return {
			node,
			pick(activate, item) {
				const index = l.filteredItems.findIndex((it) => it.value === item);
				if (index < 0) return;
				list.setSelectedIndex(index);
				l.onSelectionChange?.(l.filteredItems[index]!);
				if (activate) l.onSelect?.(l.filteredItems[index]!);
			},
			act(act) {
				const it = l.filteredItems[l.selectedIndex];
				if (act === "confirm" && it) l.onSelect?.(it);
				else if (act === "close") l.onCancel?.();
			},
		};
	};

	const shownSelector = (): ExtensionSelectorComponent | undefined => {
		const shown = containers().editor?.children?.[0];
		return shown instanceof ExtensionSelectorComponent ? shown : undefined;
	};

	/**
	 * A one-line text prompt in the composer's place: `ctx.ui.input`, or renaming a session in
	 * `/resume`. Described as omp's hook input card; its field takes Tern's edits, its buttons submit
	 * or cancel through the dialog's own callbacks.
	 */
	type TextDialog = { title: string; detail: string; field: DialogField; submit(): void; cancel(): void };
	const activeTextDialog = (): TextDialog | undefined => {
		const shown = containers().editor?.children?.[0];
		if (shown instanceof ExtensionInputComponent) {
			const d = shown as unknown as { input: DialogField; onSubmitCallback(v: string): void; onCancelCallback(): void };
			return { ...dialogTitle(shown), field: d.input, submit: () => d.onSubmitCallback(d.input.getValue()), cancel: () => d.onCancelCallback() };
		}
		if (shown instanceof SessionSelectorComponent) {
			const s = shown as unknown as { mode: string; renameInput: DialogField & { onSubmit?: (v: string) => void }; exitRenameMode(): void };
			if (s.mode !== "rename") return undefined;
			return {
				title: "Rename session",
				detail: "An empty name removes it",
				field: s.renameInput,
				submit: () => s.renameInput.onSubmit?.(s.renameInput.getValue()),
				cancel: () => s.exitRenameMode(),
			};
		}
		return undefined;
	};
	const DIALOG_INPUT = "dialog.field/input";
	const inputDialogNode = (dlg: TextDialog): TspNode => {
		const field = dlg.field;
		const value = field.getValue();
		const { title, detail } = dlg;
		return col(
			[
				col(
					[
						spans([span(title)], { wrap: "word", role: "omp.hook-input.title" }, "title"),
						...(detail ? [spans([span(detail)], { wrap: "word", role: "omp.hook-input.detail" }, "detail")] : []),
					],
					{ role: "omp.hook-input.head", gap: "xs" },
					"head",
				),
				col(
					[n("input", { text: value, cursor: Math.min(value.length, field.cursor ?? value.length), sendable: false }, undefined, "input")],
					{ role: "omp.hook-input.field" },
					"field",
				),
				row(
					[
						n("spacer", { grow: 1 }, undefined, "fill"),
						n("button", { role: "omp.btn", text: "Cancel", keys: ["esc"], title: "Cancel  esc", actions: { click: "dialog.cancel" } }, undefined, "cancel"),
						n(
							"button",
							{ role: "omp.btn", text: "Submit", keys: ["enter"], variant: "primary", tone: "accent", title: "Submit  \u23ce", actions: { click: "dialog.submit" } },
							undefined,
							"submit",
						),
					],
					{ role: "omp.actions", gap: "sm", align: "center" },
					"actions",
				),
			],
			{ role: "omp.overlay.hook-input" },
			"dialog",
		);
	};

	/**
	 * Overlays extensions open with `ctx.ui.custom(..., { overlay: true })` live in pi-tui's overlay
	 * stack, not in its children: each visible one becomes an `overlay` node in the layer, its
	 * content rendered by the component itself at the width it asked for.
	 */
	type OverlayEntry = { component: Component; options?: { width?: number | string; minWidth?: number; anchor?: string; nonCapturing?: boolean }; hidden?: boolean };
	const visibleOverlays = (): OverlayEntry[] => {
		const t = tuiRef as unknown as { overlayStack?: OverlayEntry[]; isOverlayVisible?: (e: OverlayEntry) => boolean } | undefined;
		return (t?.overlayStack ?? []).filter((e) => {
			try {
				return t?.isOverlayVisible ? t.isOverlayVisible(e) : !e.hidden;
			} catch {
				return !e.hidden;
			}
		});
	};
	const focusedOverlay = (): OverlayEntry | undefined => {
		const focused = (tuiRef as unknown as { focusedComponent?: Component | null } | undefined)?.focusedComponent;
		return focused ? visibleOverlays().find((e) => e.component === focused) : undefined;
	};
	const overlayNodes = (): TspNode[] => {
		const focused = focusedOverlay();
		const out: TspNode[] = [];
		for (const entry of visibleOverlays()) {
			const o = entry.options ?? {};
			const room = Math.max(20, cols - 6);
			let width = typeof o.width === "number" ? o.width : typeof o.width === "string" && o.width.endsWith("%") ? Math.floor((cols * Number.parseFloat(o.width)) / 100) : Math.min(80, room);
			if (!Number.isFinite(width)) width = Math.min(80, room);
			if (o.minWidth) width = Math.max(width, o.minWidth);
			width = Math.max(20, Math.min(room, width));
			const fraction = width / Math.max(1, cols);
			const size = fraction >= 0.75 ? "lg" : fraction >= 0.45 ? "md" : "sm";
			const anchor = o.anchor?.startsWith("top") ? "top" : o.anchor?.startsWith("bottom") ? "bottom" : "center";
			const body = ansiNode(entry.component, "ov", "pi.overlay", width);
			if (!body) continue;
			const id = `ov-${idOf(entry.component, "o")}`;
			out.push(n("overlay", { anchor, size, modal: entry === focused, role: "pi.overlay" }, [body], id));
		}
		return out;
	};

	let hudNode: TspNode | undefined;
	const hud = (): TspNode => (hudNode ??= buildHud());
	const buildHud = (): TspNode =>
		row(
			[
				col(
					[
						row(
							[
								n("spinner", { style: "starburst", tone: "accent" }, undefined, "spinner"),
								n("elapsed", { age: 0, format: "short" }, undefined, "elapsed"),
								text("·", { role: "omp.working.sep" }, "sep"),
								n("shimmer", { spans: [span("Working…", "muted")], mode: "classic", palette: { low: "dim", mid: "muted", high: "accent" }, role: "omp.working.label" }, undefined, "label"),
								row([], { grow: 1 }, "fill"),
								row([n("kbd", { keys: ["escape"] }, undefined, "key"), text("Stop", {}, "label")], { role: "omp.working.stop", gap: "xs", align: "center", title: "Stop  esc", actions: { click: "interrupt" } }, "stop"),
							],
							{ role: "omp.working", align: "center", gap: "sm" },
							"working",
						),
					],
					{ role: "omp.hud.status" },
					"status",
				),
			],
			{ role: "omp.hud.activity", align: "center", gap: "sm" },
			"hud",
		);

	/** The usage card: the full numbers behind the cost chip, as a small popover above the composer. */
	let usageOpen = false;
	const usageCard = (): TspNode | null => {
		if (!usageOpen || !ctxRef) return null;
		const ctx = ctxRef;
		const u = sessionUsage();
		const ctxUsage = ctx.getContextUsage();
		const window = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const pct = ctxUsage?.percent ?? null;
		const auto = autoCompact(window);
		const kv = (rows: [string, string | undefined][]) =>
			n("kv", { items: rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => ({ k: [span(k, "muted")], v })) });
		const head = (label: string, id: string) => spans([span(label, "strong")], { wrap: "none" }, id);
		return n(
			"overlay",
			{ anchor: "bottom", size: "sm", modal: false, role: "omp.overlay.usage" },
			[
				col(
					[
						row(
							[
								spans([span("Usage", "strong")], { wrap: "none" }, "title"),
								row([], { grow: 1 }, "fill"),
								row([n("kbd", { keys: ["escape"] }, undefined, "key"), text("Close", {}, "label")], { gap: "xs", align: "center", title: "Close", actions: { click: "usage.close" } }, "close"),
							],
							{ align: "center", gap: "sm" },
							"head",
						),
						head("Cost", "cost-head"),
						n(
							"kv",
							{
								items: [
									{ k: [span("Session", "muted")], v: u.cost > 0 ? money(u.cost) : "\u2014" },
									{ k: [span("Billing", "muted")], v: u.sub ? "Subscription login: estimated at API prices" : "API key" },
								],
							},
							undefined,
							"cost",
						),
						head("Tokens", "tokens-head"),
						{ ...kv([
							["Input (uncached)", u.input.toLocaleString()],
							["Output", u.output.toLocaleString()],
							["Cache read", u.cacheRead ? u.cacheRead.toLocaleString() : undefined],
							["Cache written", u.cacheWrite ? u.cacheWrite.toLocaleString() : undefined],
							["Cache hit (last request)", u.hit !== undefined ? pct1(u.hit) : undefined],
							["Requests", String(u.requests)],
						]), id: "tokens" },
						head("Context", "context-head"),
						{ ...kv([
							["Used", pct === null ? "unknown" : `${pct1(pct)} \u00b7 ${fmtTokens(ctxUsage?.tokens ?? 0)} of ${fmtTokens(window)}`],
							["Auto-compaction", auto.on ? (auto.at !== undefined ? `on \u00b7 starts at ${Math.round(auto.at * 100)}%` : "on") : "off"],
							["Model", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined],
						]), id: "context" },
					],
					{ gap: "sm", role: "omp.usage" },
					"body",
				),
			],
			"usage",
		);
	};

	/** Autocomplete row key → index into pi's filtered items, for pointer picks. */
	let autocompleteKeys = new Map<string, number>();

	/** pi's autocomplete as omp's native picker: a `list` overlay in the layer, anchored at the caret. */
	const autocompleteOverlay = (): TspNode | null => {
		const ed = composer;
		const k = containers();
		if (!ed || k.editor?.children?.[0] !== ed || !ed.isShowingAutocomplete()) return null;
		const st = ed as unknown as {
			autocompleteList?: { filteredItems?: { value: string; label: string; description?: string }[]; selectedIndex?: number };
			autocompletePrefix?: string;
		};
		const items = st.autocompleteList?.filteredItems ?? [];
		if (items.length === 0) return null;
		const sel = Math.max(0, Math.min(items.length - 1, st.autocompleteList?.selectedIndex ?? 0));
		const first = Math.max(0, Math.min(sel - 4, items.length - 10));
		const shown = items.slice(first, first + 10);
		const keyFor = new Map<object, string>();
		const seen = new Map<string, number>();
		autocompleteKeys = new Map();
		items.forEach((it, index) => {
			const base = it.value.replace(/[\s/.]+/g, "_") || "_";
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			const key = count === 0 ? base : `${base}~${count}`;
			keyFor.set(it, key);
			autocompleteKeys.set(key, index);
		});
		const prefix = (st.autocompletePrefix ?? "").replace(/^[/@]/, "").toLowerCase();
		const label = (text: string) => {
			const m = prefix && text.toLowerCase().startsWith(prefix) ? prefix.length : 0;
			return m === 0 ? [span(text)] : m === text.length ? [span(text, "mark")] : [span(text.slice(0, m), "mark"), span(text.slice(m))];
		};
		const listId = "complete.sel/list";
		return n(
			"overlay",
			{ anchor: { caret: "composer.line/input" }, role: "omp.autocomplete" },
			[
				col(
					[
						n(
							"list",
							{ selected: `${listId}/${keyFor.get(items[sel]!)}`, empty: "No items", max: { lines: 10 } },
							shown.map((it) =>
								n(
									"item",
									{
										label: label(it.label || it.value),
										detail: it.description ? [span(stripAnsi(it.description), "muted")] : undefined,
									},
									undefined,
									keyFor.get(it),
								),
							),
							"list",
						),
						...(items.length > shown.length ? [spans([span(`${sel + 1}/${items.length}`, "muted")], { wrap: "none" }, "status")] : []),
					],
					{ role: "omp.select" },
					"sel",
				),
			],
			"complete",
		);
	};

	/**
	 * Session usage, computed exactly like pi's footer: totals over every entry (assistant messages,
	 * tool results with usage, compactions, branch summaries, usage entries), and the cache hit rate
	 * of the latest assistant request. Cached per entry count and leaf.
	 */
	type Usage = {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		hit?: number;
		requests: number;
		sub: boolean;
	};
	let usageCache: { key: string; usage: Usage } | undefined;
	const sessionUsage = (): Usage => {
		const ctx = ctxRef!;
		const entries = ctx.sessionManager.getEntries();
		const sub = !!ctx.model && (ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model));
		const key = `${entries.length}|${ctx.sessionManager.getLeafId?.() ?? ""}|${sub}`;
		if (usageCache?.key === key) return usageCache.usage;
		const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0, sub };
		const add = (x: any) => {
			if (!x) return;
			u.input += x.input ?? 0;
			u.output += x.output ?? 0;
			u.cacheRead += x.cacheRead ?? 0;
			u.cacheWrite += x.cacheWrite ?? 0;
			u.cost += x.cost?.total ?? 0;
		};
		for (const e of entries as any[]) {
			if (e.type === "usage") add(e.usage);
			else if (e.type === "message" && e.message?.role === "assistant") {
				const m = e.message.usage;
				add(m);
				if (!m) continue;
				const prompt = (m.input ?? 0) + (m.cacheRead ?? 0) + (m.cacheWrite ?? 0);
				u.hit = prompt > 0 ? ((m.cacheRead ?? 0) / prompt) * 100 : undefined;
				u.requests++;
			} else if (e.type === "message" && e.message?.role === "toolResult" && e.message.usage) add(e.message.usage);
			else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) add(e.usage);
		}
		usageCache = { key, usage: u };
		return u;
	};
	const pct1 = (v: number) => `${v.toFixed(1)}%`;
	const money = (v: number) => `$${v.toFixed(2)}`;
	const autoCompact = (window: number) => {
		const settings = (pi.getSettings?.() ?? {}) as { compaction?: { enabled?: boolean; reserveTokens?: number } };
		if (settings.compaction?.enabled === false) return { on: false as const };
		const reserve = settings.compaction?.reserveTokens ?? 16_384;
		return { on: true as const, at: window > 0 ? Math.max(0, Math.min(1, (window - reserve) / window)) : undefined };
	};
	/** The cache hit rate is only news when it drops after the cache has been warm. */
	const cacheTrouble = (u: Usage) => u.requests >= 2 && u.hit !== undefined && u.hit < 80 && u.cacheRead + u.cacheWrite > 0;

	/** Where pi's auto-compaction starts (compaction.reserveTokens free), as a meter mark. */
	const compactMark = (window: number) => {
		if (!window) return undefined;
		const settings = (pi.getSettings?.() ?? {}) as { compaction?: { enabled?: boolean; reserveTokens?: number } };
		if (settings.compaction?.enabled === false) return undefined;
		const reserve = settings.compaction?.reserveTokens ?? 16_384;
		const at = Math.max(0, Math.min(1, (window - reserve) / window));
		if (at > 0.94) return undefined; // too close to the end: it would sit on the total label
		return [{ at, icon: "context.compaction", title: `Auto-compact at ${Math.round(at * 100)}%` }];
	};

	const composerNode = (ed: TernComposer): TspNode => {
		const ctx = ctxRef!;
		const value = ed.getText();
		const lines = ed.getLines();
		const cur = ed.getCursor();
		let cursor = cur.col;
		for (let i = 0; i < cur.line; i++) cursor += (lines[i]?.length ?? 0) + 1;

		const name = pi.getSessionName?.();
		const placeholder = value ? undefined : name ? [span(`\u201C${name}\u201D`, "em")] : PLACEHOLDER;
		const shell = value.startsWith("!");
		const kids: TspNode[] = [];

		// context meter
		const usage = ctx.getContextUsage();
		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const pct = usage?.percent ?? null;
		kids.push(
			n(
				"meter",
				{
					role: "omp.composer.context",
					value: pct === null ? null : Math.min(1, pct / 100),
					style: "bar",
					thresholds: window
						? { warn: Math.min(50, (150_000 / window) * 100) / 100, bad: Math.min(90, (500_000 / window) * 100) / 100 }
						: { warn: 0.5, bad: 0.9 },
					marks: compactMark(window),
					label: pct === null ? undefined : `${Math.round(pct)}%`,
					total: window ? fmtTokens(window) : undefined,
					title: [
						pct === null ? "Context usage unknown" : `Context ${pct1(pct)} used`,
						window ? `${fmtTokens(usage?.tokens ?? 0)} of ${fmtTokens(window)} tokens` : "No context window",
						(() => {
							const auto = autoCompact(window);
							if (!auto.on) return "Auto-compaction off";
							return auto.at !== undefined ? `Auto-compaction on \u00b7 starts at ${Math.round(auto.at * 100)}%` : "Auto-compaction on";
						})(),
					].join("\n"),
				},
				undefined,
				"context",
			),
		);

		// attachments: pasted images as chips, their paths hidden in the editor
		const images = shell ? [] : findImages(value);
		composerImages = images;
		if (images.length > 0) {
			kids.push(
				row(
					images.map((a) =>
						n(
							"card",
							{ role: "omp.composer.chip", tone: "accent", head: [span(`Image #${a.n}`, "strong")], title: a.path },
							[
								n("image", { blob: a.id, alt: `Image #${a.n}`, title: a.path, w: a.w, h: a.h, max: { w: "12ch", h: "4lines" } }, undefined, "img"),
								row(
									[
										...(a.w && a.h ? [spans([span(`${a.w}\u00d7${a.h}`, "dim")], { wrap: "none" }, "size")] : []),
										icon("trash", { title: "Remove image", aria: "Remove image", actions: { click: "remove-image" } }, "remove"),
									],
									{ gap: "sm", align: "center" },
									"foot",
								),
							],
							`img${a.n}`,
						),
					),
					{ gap: "sm", wrap: true, role: "omp.composer.chips" },
					"chips",
				),
			);
		}

		// input line
		kids.push(
			row(
				[
					...(shell
						? [row([spans([span("bash", "bashMode")], { wrap: "none" }, "label")], { role: "omp.composer.mode", gap: "xs", align: "center", title: "Runs in your shell" }, "mode")]
						: []),
					n(
						"editor",
						{
							text: value,
							cursor,
							sendable: true,
							placeholder,
							maxLines: 18,
							lang: shell ? "bash" : undefined,
							decor: images.length > 0 ? images.map((a) => ({ from: a.from, to: a.to, s: "hide" })) : undefined,
						},
						undefined,
						"input",
					),
				],
				{ role: "omp.composer.line", align: "start", gap: "sm" },
				"line",
			),
		);

		// bar: model · effort · facts · cost · send/stop
		const model = ctx.model;
		const bar: TspNode[] = [];
		if (model) {
			bar.push(
				row(
					[icon("model", {}, "icon"), spans([span((model.name || model.id).replace(/^claude\s+/i, ""), "statusLineModel")], { wrap: "none" }, "name"), icon("chev", {}, "chev")],
					{ role: "omp.composer.model", gap: "xs", align: "center", title: "Switch model", actions: { click: "status.model" } },
					"model",
				),
			);
			if (model.reasoning) {
				const level = pi.getThinkingLevel();
				bar.push(
					row([n("effort", { level }, undefined, "glyph"), text(level, { wrap: "none" }, "level")], { role: "omp.composer.effort", gap: "xs", align: "center", title: "Thinking effort  ⇧⇥", actions: { click: "thinking.cycle" } }, "effort"),
				);
			}
		}

		const facts: TspNode[] = [];
		{
			const u = sessionUsage();
			if (cacheTrouble(u)) {
				facts.push(
					n(
						"seg",
						{
							role: "omp.composer.fact",
							priority: 1100,
							icon: "warning",
							tone: "warning",
							spans: [span(`cache ${Math.round(u.hit!)}%`, "warning")],
							title: `The last request reused only ${pct1(u.hit!)} of the prompt from the cache, so most of the context was sent at full price.\nThis usually follows a model switch, a compaction or a changed system prompt, and recovers on the next turn.\nClick for details`,
							actions: { click: "status.cost" },
						},
						undefined,
						"cache",
					),
				);
			}
		}
		const branch = footerData?.getGitBranch() ?? git.branch;
		if (branch) {
			const dirty = git.untracked + git.changed > 0;
			const sp = [span(branch, dirty ? "statusLineGitDirty" : "statusLineGitClean")];
			if (git.changed) sp.push(span(` ~${git.changed}`, "statusLineGitDirty"));
			if (git.untracked) sp.push(span(` ?${git.untracked}`, "statusLineUntracked"));
			facts.push(n("seg", { role: "omp.composer.fact", priority: 1004, spans: sp, icon: "branch", tone: dirty ? "warning" : undefined }, undefined, "git"));
		}
		let hook = 0;
		for (const status of footerData?.getExtensionStatuses().values() ?? []) {
			const plain = stripAnsi(status).replace(/\s+/g, " ").trim();
			if (plain) facts.push(n("seg", { role: "omp.composer.fact", priority: 0, spans: [span(plain)] }, undefined, `hook-${hook++}`));
		}
		bar.push(n("status", { role: "omp.composer.extras", transparent: true, grow: 1 }, facts, "extras"));

		const u = sessionUsage();
		if (running && rate.shown !== undefined) {
			bar.push(n("rate", { value: rate.shown, unit: "tok/s", role: "omp.composer.rate", title: "Generation rate" }, undefined, "rate"));
		}
		const costTitle = [
			`Session cost  ${u.cost > 0 ? money(u.cost) : "\u2014"}${u.sub ? " (subscription)" : ""}`,
			`Tokens  ${fmtTokens(u.input)} in \u00b7 ${fmtTokens(u.output)} out`,
			u.cacheRead + u.cacheWrite > 0
				? `Prompt cache  ${fmtTokens(u.cacheRead)} read \u00b7 ${fmtTokens(u.cacheWrite)} written${u.hit !== undefined ? ` \u00b7 ${pct1(u.hit)} hit` : ""}`
				: undefined,
			"Click for details",
		]
			.filter(Boolean)
			.join("\n");
		bar.push(
			spans(u.cost > 0 ? [span(COST_ICON, "icon"), span(u.cost.toFixed(2), u.sub ? "dim" : undefined)] : [span(COST_ICON, "icon")], {
				role: "omp.composer.usage",
				wrap: "none",
				title: costTitle,
				actions: { click: "status.cost" },
			}, "usage"),
		);
		bar.push(
			running
				? text("Stop", { role: "omp.composer.stop", tone: "error", title: "Stop  esc", actions: { click: "interrupt" } }, "stop")
				: n("kbd", { role: "omp.composer.send", keys: ["enter"], title: "Send  ⏎", actions: { click: "submit" } }, undefined, "send"),
		);
		kids.push(row(bar, { role: "omp.composer.bar", gap: "sm", align: "center" }, "bar"));

		return col(kids, { role: shell ? "omp.editor.bash" : "omp.editor", tone: running ? "pending" : undefined }, "composer");
	};

	// ---------- generation rate ----------

	/**
	 * omp's tok/s chip. Per assistant message: output tokens over the time since its first streamed
	 * token. While streaming the count is estimated from the text (4 characters a token); once the
	 * provider reports `usage.output` that number is used. Shown only while pi works, and changed at
	 * most twice a second so the chip reads calmly.
	 */
	let rate: { shown?: number; at: number; msg?: unknown; first?: number } = { at: 0 };
	const RATE_MIN_MS = 1000;
	const RATE_MIN_TOKENS = 16;
	const trackRate = (m: any, ended: boolean) => {
		if (m?.role !== "assistant") return;
		const now = Date.now();
		// updates carry snapshots, not the same object: the start time identifies the message
		const key = m.timestamp ?? m;
		if (rate.msg !== key) rate = { ...rate, msg: key, first: undefined };
		let chars = 0;
		for (const b of m.content ?? []) {
			if (typeof b?.text === "string") chars += b.text.length;
			else if (typeof b?.thinking === "string") chars += b.thinking.length;
			else if (b?.type === "toolCall" && b.arguments) chars += JSON.stringify(b.arguments).length;
		}
		if (chars === 0) return;
		rate.first ??= now;
		const reported = typeof m.usage?.output === "number" && m.usage.output > 0 && (ended || m.stopReason) ? m.usage.output : undefined;
		const tokens = reported ?? chars / 4;
		const ms = now - rate.first;
		if (ms < RATE_MIN_MS || tokens < RATE_MIN_TOKENS) return;
		if (!ended && now - rate.at < 500) return;
		const value = Math.round((tokens * 1000) / ms);
		if (value !== rate.shown) {
			rate.shown = value;
			rate.at = now;
			scheduleRender();
		}
	};

	// ---------- git ----------
	const refreshGit = async () => {
		const ctx = ctxRef;
		if (!ctx) return;
		const r = await pi.exec("git", ["status", "--porcelain=v1", "--branch"], { cwd: ctx.cwd, timeout: 5000 }).catch(() => undefined);
		if (!r || r.code !== 0) git = { untracked: 0, changed: 0 };
		else {
			let branch: string | undefined;
			let untracked = 0;
			let changed = 0;
			for (const line of r.stdout.split(/\r?\n/)) {
				if (!line) continue;
				if (line.startsWith("## ")) {
					const head = line.slice(3);
					branch = head.startsWith("No commits yet on ") ? head.slice(18) : head.split("...")[0]?.split(" ")[0];
				} else if (line.startsWith("??")) untracked++;
				else changed++;
			}
			git = { branch, untracked, changed };
		}
		scheduleRender();
	};
	const scheduleGit = () => {
		if (gitTimer) clearTimeout(gitTimer);
		gitTimer = setTimeout(() => void refreshGit(), 300);
	};

	// ---------- engage / disengage ----------
	const engage = async (ctx: ExtensionContext) => {
		trace("engage");
		ctxRef = ctx;
		// Capture the TUI and footer data, and silence the stock footer (the composer shows its facts).
		ctx.ui.setFooter((tui, _theme, data) => {
			tuiRef = tui;
			footerData = data;
			const unsub = data.onBranchChange(() => scheduleGit());
			return { render: () => [], invalidate() {}, dispose: unsub };
		});
		ctx.ui.setEditorComponent((tui, theme, kb) => new TernComposer(tui, theme, kb));
		ctx.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
		trace(`tui=${!!tuiRef}`);
		if (!tuiRef) return;

		unsubInput?.();
		unsubInput = ctx.ui.onTerminalInput(onInput);

		// Hold pi's ANSI output while we ask; the reply decides who draws.
		const terminal = (tuiRef as unknown as { terminal: { write: (d: string) => void } }).terminal;
		const original = terminal.write;
		const held: string[] = [];
		terminal.write = (d: string) => void held.push(d);

		hello = await new Promise<Hello | undefined>((resolve) => {
			const timer = setTimeout(() => {
				helloWaiter = undefined;
				resolve(undefined);
			}, 2500);
			helloWaiter = (h) => {
				clearTimeout(timer);
				resolve(h);
			};
			rawWrite(encodeHello(VERSION));
		});

		trace(`hello=${JSON.stringify(hello)}`);
		if (!hello) {
			// Not a TSP terminal after all: give pi its terminal back untouched.
			terminal.write = original;
			for (const d of held) original.call(terminal, d);
			uninstall(ctx);
			tuiRef.requestRender(true);
			return;
		}

		credits = typeof hello.credits === "number" && hello.credits > 0 ? hello.credits : 2;
		apcLimit = typeof hello.apc === "number" && hello.apc > 1024 ? hello.apc : 65536;
		cols = typeof hello.cols === "number" && hello.cols > 0 ? hello.cols : (process.stdout.columns ?? 80);

		// From now on pi-tui renders into the void; each of its renders triggers a native describe.
		terminal.write = (d: string) => {
			if (OSC_ONLY.test(d)) original.call(terminal, d); // window title, progress
			scheduleRender();
		};
		restoreWrite = () => {
			terminal.write = original;
		};
		// Inline surfaces live on the main screen: leave the alternate screen if pi entered it.
		// pi's fullscreen mode (its default) also turns on mouse tracking; while that is on, Tern
		// sends wheel and touchpad scrolling to the program as mouse codes instead of scrolling the
		// transcript. Tern owns scrolling now, so switch every tracking mode off.
		rawWrite("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1049l\x1b[2J\x1b[H");
		active = true;
		openSurface();
		reportCwd(ctx.cwd);
		void refreshGit();
	};

	/** OSC 7, as omp sends it: Tern then knows where the agent works. */
	const reportCwd = (cwd: string) => {
		try {
			rawWrite(`\x1b]7;file://${hostname()}${pathToFileURL(cwd).pathname}\x07`);
		} catch {
			/* not a path Tern can use */
		}
	};

	const uninstall = (ctx: ExtensionContext) => {
		unsubInput?.();
		unsubInput = undefined;
		ctx.ui.setFooter(undefined);
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setHeader(undefined);
	};

	const disengage = (keep: boolean) => {
		if (!active) return;
		render();
		active = false;
		if (renderTimer) clearTimeout(renderTimer);
		if (stallTimer) clearTimeout(stallTimer);
		renderTimer = stallTimer = undefined;
		rawWrite(encode("x", { id: sf, keep }));
		restoreWrite?.();
		restoreWrite = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await engage(ctx);
	});

	pi.on("session_shutdown", (event) => {
		disengage(event.reason === "quit");
		unsubInput?.();
		unsubInput = undefined;
		if (gitTimer) clearTimeout(gitTimer);
	});

	pi.on("message_end", (event) => {
		const m = (event as { message?: any }).message;
		if (m?.role !== "assistant" || !m.usage) return;
		runStats.input = Math.max(runStats.input, (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0));
		runStats.output += m.usage.output ?? 0;
		runStats.cost += m.usage.cost?.total ?? 0;
	});
	pi.on("agent_start", () => {
		runStats = { start: Date.now(), input: 0, output: 0, cost: 0 };
		running = true;
		rate = { shown: undefined, at: 0 };
		scheduleRender();
	});
	pi.on("message_update", (event) => trackRate((event as { message?: any }).message, false));
	pi.on("message_end", (event) => trackRate((event as { message?: any }).message, true));
	pi.on("agent_end", () => {
		running = false;
		rate = { shown: undefined, at: 0 };
		tipIndex = (tipIndex + 1) % TIPS.length;
		scheduleGit();
		scheduleRender();
	});
	pi.on("tool_execution_end", () => scheduleGit());
	const rerender = () => scheduleRender();
	pi.on("model_select", rerender);
	pi.on("thinking_level_select", rerender);
	pi.on("message_update", rerender);
	pi.on("message_end", rerender);
	pi.on("turn_end", rerender);

	pi.registerCommand("tern-native", {
		description: "Native Tern surface: status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				active ? `Native Tern surface ${sf} · Tern ${hello?.ver ?? "?"} · ${cols} cols · ${hello?.kinds.length ?? 0} kinds` : "Native Tern surface is not active",
				"info",
			);
		},
	});
}
