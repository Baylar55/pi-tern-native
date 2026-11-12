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
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	CustomEditor,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	ToolExecutionComponent,
	UserMessageComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, type EditorTheme, Markdown, Spacer, type TUI, Text } from "@earendil-works/pi-tui";
import { Reconciler } from "./reconcile.ts";
import {
	APC,
	col,
	encode,
	encodeHello,
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
	const toolClock = new Map<string, { start: number; end?: number }>();

	const idOf = (o: object, prefix: string) => {
		let id = ids.get(o);
		if (!id) ids.set(o, (id = `${prefix}${(idSeq++).toString(36)}`));
		return id;
	};

	const logPath = process.env.PI_TERN_NATIVE_LOG;
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
		}
	}

	// ---------- input: TSP events ----------
	const onInput = (data: string) => {
		if (!data.includes("\x1b")) return parser.buffering ? feed(data) : undefined;
		return feed(data);
	};

	const feed = (data: string) => {
		const { messages, rest } = parser.feed(data);
		for (const m of messages) handleInbound(m.verb, m.body);
		if (rest === data) return undefined;
		return rest.length === 0 ? { consume: true } : { data: rest };
	};

	const handleInbound = (verb: string, body: any) => {
		if (!(verb === "e" && body?.ev === "ack")) log("in", verb, body);
		if (verb === "r" && body?.r === "hello") {
			if (helloWaiter) {
				const w = helloWaiter;
				helloWaiter = undefined;
				w(body as Hello);
			}
			return;
		}
		if (verb === "r" && body?.r === "blobs") {
			if (!Array.isArray(body.have) || !body.have.includes(PI_LOGO.id)) sendLogoInline();
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
				return runAction(String(body.act ?? ""), String(body.id ?? ""));
			case "send":
				if (composer && typeof body.text === "string" && body.text.trim()) {
					composer.setText(body.text);
					composer.handleInput("\r");
				}
				return;
			case "edit":
				if (composer && typeof body.text === "string") {
					const t = composer.getText();
					const from = Math.max(0, Math.min(t.length, Number(body.from ?? 0)));
					const to = Math.max(from, Math.min(t.length, Number(body.to ?? from)));
					composer.setText(t.slice(0, from) + body.text + t.slice(to));
					scheduleRender();
				}
				return;
			case "gone":
				if (Array.isArray(body.ids) && body.ids.includes(sf)) openSurface();
				return;
		}
	};

	const runAction = (act: string, target = "") => {
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

	/** Content-addressed blob: into Tern's blob cache when it has one, else inline (as omp does). */
	const sendLogo = () => {
		const dir = process.env.TERN_BLOB_DIR;
		if (dir) {
			try {
				const file = join(dir, PI_LOGO.id);
				if (!existsSync(file)) writeFileSync(file, PI_LOGO.bytes);
				rawWrite(encode("q", { q: "blobs", ids: [PI_LOGO.id] }));
				return;
			} catch {
				/* fall through to inline */
			}
		}
		sendLogoInline();
	};
	const sendLogoInline = () =>
		rawWrite(`${APC}b;id=${PI_LOGO.id};mime=${PI_LOGO.mime};${PI_LOGO.bytes.toString("base64")}${ST}`);

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

	const render = () => {
		if (!active || !ctxRef) return;
		if (unacked.length >= credits) {
			const waited = Date.now() - unacked[0]!;
			if (waited < 5000) {
				if (!stallTimer) stallTimer = setTimeout(() => ((stallTimer = undefined), scheduleRender(0)), 5000 - waited);
				return;
			}
			unacked = []; // terminal stopped acknowledging: carry on without credits, as omp does
		}
		let ops: Op[] = [];
		const began = performance.now();
		try {
			reconciler.region("main", describeMain(), ops);
			const dock = describeDock();
			reconciler.region("dock", dock.nodes, ops);
			const overlay = autocompleteOverlay();
			reconciler.region("layer", overlay ? [overlay] : [], ops);
			if (dock.focus !== lastFocus) {
				ops.push(["focus", dock.focus]);
				lastFocus = dock.focus;
			}
		} catch (error) {
			ops = [];
			ctxRef.ui.notify(`tern-native: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		if (logPath) log("perf", "render", { ms: +(performance.now() - began).toFixed(2), ops: ops.length });
		if (ops.length > 0) send(ops);
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

	const ansiNode = (comp: Component, idPrefix: string, role: string): TspNode | null => {
		let lines: string[];
		try {
			lines = trimBlank(comp.render(readerCols()));
		} catch {
			return null;
		}
		if (lines.length === 0) return null;
		lines = lines.map(trimRight);
		const key = `${cols}\n${lines.join("\n")}`;
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
		for (const comp of chat?.children ?? []) {
			const node = describeChat(comp);
			if (node) out.push(node);
		}
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

	/** Copyable text per transcript node, for the copy buttons and hold menus. */
	const copyTexts = new Map<string, string>();

	const userNode = (comp: UserMessageComponent): TspNode => {
		const c = comp as unknown as { text: string; timestamp?: string };
		const cached = nodeCache.get(comp);
		if (cached) return cached.node;
		const time = clock(c.timestamp ?? Date.now());
		const id = idOf(comp, "u");
		copyTexts.set(id, c.text);
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
				md(c.text, {}, "body"),
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

		const clockEntry = toolClock.get(c.toolCallId) ?? { start: Date.now() };
		toolClock.set(c.toolCallId, clockEntry);
		if (done && clockEntry.end === undefined) clockEntry.end = Date.now();
		const status = !done ? "running" : c.result!.isError ? "error" : "done";
		const took = done ? (c.result!.durationMs ?? clockEntry.end! - clockEntry.start) : undefined;
		const age = done ? undefined : 0;
		const args = c.args ?? {};
		const out = resultText(c.result);
		const name = c.toolName;
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
		const clockEntry = toolClock.get(idOf(comp, "b")) ?? { start: Date.now() };
		toolClock.set(idOf(comp, "b"), clockEntry);
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
		if (k.pending) push(ansiNode(k.pending, "p", "pi.pending"));
		if (running) nodes.push(hud());
		else if (k.status) push(ansiNode(k.status, "s", "pi.status"));
		if (k.above) push(ansiNode(k.above, "wa", "pi.widgets"));

		let focus: string | null = null;
		const shown = k.editor?.children?.[0];
		if (composer && shown === composer) {
			nodes.push(composerNode(composer));
			focus = "composer.line/input";
		} else if (shown) {
			// a selector, dialog or custom component replaced the editor: keys go to it through the pty
			push(ansiNode(shown, "d", "pi.dialog"));
		}
		if (k.below) push(ansiNode(k.below, "wb", "pi.widgets"));
		return { nodes, focus };
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
		for (const it of items) {
			const base = it.value.replace(/[\s/.]+/g, "_") || "_";
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			keyFor.set(it, count === 0 ? base : `${base}~${count}`);
		}
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
						pct === null ? "Context usage unknown" : `Context ${Math.round(pct)}% used`,
						window ? `${fmtTokens(usage?.tokens ?? 0)} of ${fmtTokens(window)} tokens` : "No context window",
					].join("\n"),
				},
				undefined,
				"context",
			),
		);

		// input line
		kids.push(
			row(
				[
					...(shell
						? [row([spans([span("bash", "bashMode")], { wrap: "none" }, "label")], { role: "omp.composer.mode", gap: "xs", align: "center", title: "Runs in your shell" }, "mode")]
						: []),
					n("editor", { text: value, cursor, sendable: true, placeholder, maxLines: 18, lang: shell ? "bash" : undefined }, undefined, "input"),
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

		let cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") cost += (e.message as AssistantMessage).usage?.cost?.total ?? 0;
		}
		bar.push(
			spans(cost > 0 ? [span(COST_ICON, "icon"), span(cost.toFixed(2))] : [span(COST_ICON, "icon")], {
				role: "omp.composer.usage",
				wrap: "none",
				title: `Session cost ${cost > 0 ? `$${cost.toFixed(2)}` : "—"}`,
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
		rawWrite("\x1b[?1049l\x1b[2J\x1b[H");
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
		scheduleRender();
	});
	pi.on("agent_end", () => {
		running = false;
		tipIndex = (tipIndex + 1) % TIPS.length;
		scheduleGit();
		scheduleRender();
	});
	pi.on("tool_execution_end", () => scheduleGit());
	for (const ev of ["model_select", "thinking_level_select", "message_update", "message_end", "turn_end"] as const) {
		pi.on(ev, () => scheduleRender());
	}

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
