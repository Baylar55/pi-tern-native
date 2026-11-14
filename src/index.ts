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
	type ExtensionCommandContext,
	type ExtensionContext,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	type KeybindingsManager,
	ModelSelectorComponent,
	SessionSelectorComponent,
	SettingsSelectorComponent,
	TreeSelectorComponent,
	type ReadonlyFooterDataProvider,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, type EditorTheme, Markdown, SelectList, Spacer, type TUI, Text } from "@earendil-works/pi-tui";
import { PI_LOGO, PI_STYLES, TIPS } from "./brand.ts";
import { ago, ansiToSpans, clock, fmtTokens, homeShort, langOf, resultText, stripAnsi, trimBlank, trimRight } from "./format.ts";
import { IMAGE_MIME, IMAGE_PATH, imageSize, MAX_IMAGE_BYTES } from "./images.ts";
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

type G = { __piTernNative?: { surfaces: number } };
const shared = ((globalThis as G).__piTernNative ??= { surfaces: 0 });

const trace = (msg: string) => {
	const p = process.env.PI_TERN_NATIVE_LOG;
	if (p) try { appendFileSync(p, `${JSON.stringify({ t: Date.now(), trace: msg })}
`); } catch {}
};

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
		/** Commands the surface runs on the user's behalf (turn actions, opening /tree) stay out of the input history. */
		override addToHistory(text: string): void {
			if (!quietSubmit) super.addToHistory(text);
		}
	}
	let quietSubmit = false;

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
			case "change":
				if (body.id === SHEET_ID) {
					currentSheet()?.change?.(String(body.item ?? ""), body.value);
					tuiRef?.requestRender();
					scheduleRender(0);
				}
				return;
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
		if (turnAction(act, target.split(/[./]/)[0] ?? "")) return;
		if (act === "copy-error") {
			const value = copyErrors.get(target.split(/[./]/)[0] ?? "");
			if (value) {
				rawWrite(`\x1b]52;c;${Buffer.from(value, "utf8").toString("base64")}\x07`);
				toast("Error copied");
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

	/** Set when pi's layout is not the one this version reads: then the whole screen is one ansi block. */
	let degraded: string | undefined;
	const describeDegraded = (): TspNode[] => {
		const out: TspNode[] = [
			noticeNode(
				ctxRef?.ui.theme.fg("warning", `tern-native cannot read the layout of pi ${VERSION} (${degraded}), so pi's own screen is shown below. Update pi-tern-native.`) ?? "",
				"degraded",
			),
		];
		// pi's top containers, each rendered on its own: a viewport container renders nothing as a whole,
		// so it falls back to its children
		const parts: Component[] = [];
		for (const kid of (tuiRef as unknown as { children?: Component[] } | undefined)?.children ?? []) {
			let lines: string[] = [];
			try {
				lines = kid.render(readerCols());
			} catch {
				/* skip */
			}
			const inner = (kid as unknown as { children?: Component[] }).children;
			if (lines.length === 0 && Array.isArray(inner)) parts.push(...inner);
			else parts.push(kid);
		}
		parts.forEach((part, i) => {
			const node = ansiNode(part, `screen${i}-`, "pi.screen");
			if (node) out.push(node);
		});
		return out;
	};

	const render = () => {
		if (!active || !ctxRef) return;
		if (degraded) {
			if (!flushBacklog() || !haveCredit()) return;
			const ops: Op[] = [];
			try {
				reconciler.region("main", describeDegraded(), ops);
			} catch {
				/* nothing more to fall back to */
			}
			if (ops.length > 0) {
				queueFrames(ops);
				flushBacklog();
			}
			return;
		}
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
		// pi marks the editor caret with private APC sequences (ESC _pi:c BEL): not for Tern's ansi parser
		lines = lines.map((line) => trimRight(line.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")));
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
		if (turnComps.size > live.size) for (const id of turnComps.keys()) if (!live.has(id)) turnComps.delete(id);
		if (copyErrors.size > live.size) for (const id of copyErrors.keys()) if (!live.has(id)) copyErrors.delete(id);
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
		turnComps.set(idOf(comp, "u"), comp);
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
				actions: {
					hold: [
						{ id: "copy-message", label: "Copy message", icon: "copy" },
						{ id: "edit-turn", label: "Edit & resend", icon: "edit", detail: "To composer" },
						{ id: "retry-turn", label: "Retry turn", icon: "refresh" },
						{ id: "rewind-turn", label: "Rewind to here\u2026", icon: "rewind" },
						{ id: "fork-turn", label: "Fork from here", icon: "branch", detail: "New session" },
					],
				},
			},
			[
				row(
					[
						icon("copy", { role: "omp.user.tool", title: "Copy message", aria: "Copy message", actions: { click: "copy-message" } }, "copy"),
						icon("rewind", { role: "omp.user.tool", title: "Rewind the conversation to this message", aria: "Rewind", actions: { click: "rewind" } }, "rewind"),
						icon("refresh", { role: "omp.user.tool", title: "Retry: send this message again from here", aria: "Retry", actions: { click: "retry-turn" } }, "retry"),
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
		turnComps.set(idOf(comp, "a"), comp);
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
				// "400 bad request" → a "400" chip, then the message (as omp's error frame)
				const code = /^(\d{3})\b[\s:-]*/.exec(message);
				let detail = code ? message.slice(code[0].length) || message : message;
				// providers often return a JSON body: show its message (Copy error keeps all of it)
				try {
					const body = JSON.parse(detail) as { message?: unknown; error?: { message?: unknown } };
					const said = body?.error?.message ?? body?.message;
					if (typeof said === "string" && said.trim()) detail = said.trim();
				} catch {
					/* plain text */
				}
				copyErrors.set(idOf(comp, "a"), message);
				const button = (act: string, label: string, title: string, keys?: string[]) =>
					row(keys ? [text(label, {}, "label"), n("kbd", { keys }, undefined, "key")] : [text(label, {}, "label")], { gap: "xs", role: "omp.error.action", actions: { click: act }, title }, act);
				const modelKeys = keyCaps("app.model.select");
				kids.push(
					n(
						"card",
						{ role: "omp.error", tone: "error" },
						[
							row(
								[
									spans([span("Request failed", "error strong")], {}, "title"),
									...(code ? [n("badge", { text: code[1], tone: "error", role: "omp.error.code" }, undefined, "code")] : []),
								],
								{ gap: "sm" },
								"head",
							),
							spans([span(detail, "mono")], { wrap: "word", role: "omp.error.message" }, "message"),
							row(
								[
									button("retry-turn", "Retry", "Send the prompt again from before this reply"),
									button("copy-error", "Copy error", "Copy the error message"),
									button("status.model", "Switch model", "Pick another model, then retry", modelKeys),
								],
								{ gap: "sm", role: "omp.error.actions" },
								"actions",
							),
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
								]
							: []),
						icon("rewind", { role: "omp.turn.copy", title: "Rewind the conversation to this reply", aria: "Rewind", actions: { click: "rewind" } }, "rewind"),
						icon("refresh", { role: "omp.turn.copy", title: "Retry: ask again for this reply", aria: "Retry", actions: { click: "retry-turn" } }, "retry"),
						text("\u00b7", {}, "dot"),
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
			final
				? {
						role: "omp.assistant",
						actions: {
							hold: [
								...(answer ? [{ id: "copy-answer", label: "Copy reply", icon: "copy" }] : []),
								{ id: "retry-turn", label: "Retry turn", icon: "refresh" },
								{ id: "rewind-turn", label: "Rewind to here\u2026", icon: "rewind" },
								{ id: "fork-turn", label: "Fork from here", icon: "branch", detail: "New session" },
							],
						},
					}
				: { role: "omp.assistant" },
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
		} else if ((name === "grep" || name === "find" || name === "ls") && status !== "error") {
			node = searchToolNode(name, args, out, base, idOf(comp, "t"));
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

	/**
	 * pi's grep, find and ls as omp's search cards: the pattern or path as the target, counts as
	 * the facts, and the result as rows (matches grouped by file, paths with a file or folder icon)
	 * instead of raw output. pi's notices (limits reached) stay at the end.
	 */
	const MAX_SEARCH_ROWS = 200;
	const searchToolNode = (name: "grep" | "find" | "ls", args: any, out: string, base: Record<string, unknown>, id: string): TspNode => {
		// a trailing "[… limit reached]" paragraph is pi's notice, not a result
		const notice = /\n\n\[([^\]]+)\]\s*$/.exec(out);
		const body = (notice ? out.slice(0, notice.index) : out).replace(/\s+$/, "");
		const empty = !body || /^(No matches found|No files found matching pattern|\(empty directory\))$/.test(body);
		const lines = empty ? [] : body.split(/\r?\n/);
		const kids: TspNode[] = [];
		const more = (count: number, noun: string) =>
			count > 0 ? [spans([span(`+${count} more ${noun}`, "dim")], {}, "more")] : [];
		const pathRow = (path: string, key: string) =>
			row(
				[icon(path.endsWith("/") ? "folder" : "file", {}, "icon"), spans([span(path, "mono")], { wrap: "none", truncate: "middle", grow: 1, shrink: 1 }, "path")],
				{ gap: "sm", align: "center", role: "omp.tool.find.hit" },
				key,
			);
		let facts: string[] = [];
		let target: string | undefined;
		let title = "";
		if (name === "grep") {
			title = "Grep";
			target = String(args.pattern ?? "");
			// "path:12: text" is a match, "path-12- text" a context line
			const files = new Map<string, { n: number; lines: string[] }>();
			let matches = 0;
			for (const line of lines) {
				const m = /^(.+?)([:-])(\d+)\2 ?(.*)$/.exec(line);
				if (!m) continue;
				const f = files.get(m[1]!) ?? { n: 0, lines: [] };
				if (m[2] === ":") {
					f.n++;
					matches++;
				}
				f.lines.push(`${m[3]!.padStart(4)}${m[2] === ":" ? ":" : " "} ${m[4]}`);
				files.set(m[1]!, f);
			}
			facts = [`${matches} ${matches === 1 ? "match" : "matches"}`, `${files.size} ${files.size === 1 ? "file" : "files"}`];
			let shown = 0;
			for (const [path, f] of files) {
				if (shown >= MAX_SEARCH_ROWS) break;
				shown += f.lines.length;
				kids.push(
					col(
						[
							row(
								[
									icon("file", {}, "icon"),
									spans([span(path, "mono strong")], { wrap: "none", truncate: "middle", grow: 1, shrink: 1 }, "path"),
									spans([span(String(f.n), "dim")], { wrap: "none" }, "count"),
								],
								{ gap: "sm", align: "center", role: "omp.tool.search.file" },
								"head",
							),
							n("code", { text: f.lines.join("\n"), lang: langOf(path), role: "omp.tool.grep.lines" }, undefined, "lines"),
						],
						{ gap: "xs" },
						`f${kids.length}`,
					),
				);
			}
			kids.push(...more(files.size - kids.length, "files"));
		} else {
			const isLs = name === "ls";
			title = isLs ? "List" : "Find";
			target = isLs ? String(args.path ?? ".") : String(args.pattern ?? "");
			const dirs = lines.filter((l) => l.endsWith("/")).length;
			facts = isLs
				? [`${dirs} ${dirs === 1 ? "folder" : "folders"}`, `${lines.length - dirs} ${lines.length - dirs === 1 ? "file" : "files"}`]
				: [`${lines.length} ${lines.length === 1 ? "result" : "results"}`];
			lines.slice(0, MAX_SEARCH_ROWS).forEach((l, i) => kids.push(pathRow(l, `p${i}`)));
			kids.push(...more(lines.length - MAX_SEARCH_ROWS, isLs ? "entries" : "results"));
		}
		if (empty) kids.push(spans([span(body || "Nothing found", "muted")], { wrap: "word" }, "empty"));
		if (notice) kids.push(row([icon("warning", { tone: "warning" }, "icon"), spans([span(notice[1]!, "muted")], { wrap: "word", grow: 1, shrink: 1 }, "text")], { gap: "sm", align: "start", role: "omp.tool.notice" }, "notice"));
		const where = name !== "ls" && args.path ? `in ${args.path}` : undefined;
		return n(
			"tool",
			{
				...base,
				title,
				target,
				targetKind: name === "ls" ? "path" : "pattern",
				meta: [...(where ? [where] : []), ...(args.glob ? [String(args.glob)] : []), ...(empty ? [] : facts)],
				frame: "card",
				collapsed: true,
				preview: { lines: 10 },
			},
			kids,
			id,
		);
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
	type Sheet = {
		node: TspNode;
		pick(activate: boolean, item: string): void;
		act(act: string, value?: string): void;
		change?(item: string, value: unknown): void;
	};
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
	const isTreeList = (comp: unknown): comp is TreeSelectorComponent =>
		comp instanceof TreeSelectorComponent && !(comp as unknown as { labelInput?: unknown }).labelInput;
	const isSheet = (comp: unknown) =>
		comp instanceof ModelSelectorComponent ||
		comp instanceof SettingsSelectorComponent ||
		isSessionList(comp) ||
		isTreeList(comp) ||
		!!selectListOf(comp);
	const currentSheet = (): Sheet | undefined => {
		const shown = containers().editor?.children?.[0];
		if (shown instanceof SettingsSelectorComponent) return settingsSheet(shown);
		if (shown instanceof ModelSelectorComponent) return modelSheet(shown);
		if (isSessionList(shown)) return sessionSheet(shown);
		if (isTreeList(shown)) return treeSheet(shown);
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

	/**
	 * `/tree` as a tree picker: every entry of the session with its indent, user / assistant / tool
	 * rows told apart, the active path dotted, labels as badges, pi's filter modes as tabs, and Go
	 * here, Label and Copy as actions. Typing still goes to pi, which searches the tree itself.
	 */
	const TREE_FILTERS = [
		{ id: "default", label: "Default" },
		{ id: "no-tools", label: "No tools" },
		{ id: "user-only", label: "User" },
		{ id: "labeled-only", label: "Labeled" },
		{ id: "all", label: "All" },
	];
	const treeSheet = (sel: TreeSelectorComponent): Sheet => {
		type Entry = { id: string; type: string; message?: { role?: string; toolName?: string } };
		type Flat = { node: { entry: Entry; label?: string }; indent: number };
		const t = (sel as unknown as { treeList: unknown }).treeList as {
			filteredNodes: Flat[];
			selectedIndex: number;
			searchQuery: string;
			filterMode: string;
			multipleRoots: boolean;
			currentLeafId?: string;
			activePathIds: Set<string>;
			foldedNodes: Set<string>;
			getEntryDisplayText(node: Flat["node"], selected: boolean): string;
			isFoldable(id: string): boolean;
			applyFilter(): void;
			copySelected(): void;
			onSelect?: (id: string) => void;
			onCancel?: () => void;
			onLabelEdit?: (id: string, label?: string) => void;
		};
		const rows = t.filteredNodes ?? [];
		const items = rows.map((flat) => {
			const e = flat.node.entry;
			const role = e.type === "message" ? e.message?.role : undefined;
			const tool = role === "toolResult" || role === "bashExecution";
			const kind = role === "user" ? "user" : role === "assistant" ? "assistant" : tool ? "tool" : "marker";
			// a tool row's glyph comes from its omp role (omp.tool.bash, omp.tool.read, …)
			const toolRole = role === "bashExecution" ? "omp.tool.bash" : role === "toolResult" ? `omp.tool.${e.message?.toolName ?? "tool"}` : undefined;
			let label = "";
			try {
				label = stripAnsi(t.getEntryDisplayText(flat.node, false)).replace(/^(user|assistant): /, "");
			} catch {
				label = `[${e.type}]`;
			}
			return {
				id: e.id,
				label: label.trim() || `[${e.type}]`,
				node: kind,
				depth: t.multipleRoots ? Math.max(0, flat.indent - 1) : flat.indent,
				...(toolRole ? { role: toolRole } : {}),
				...(t.isFoldable(e.id) && !t.foldedNodes.has(e.id) ? { open: true } : {}),
				...(t.activePathIds.has(e.id) ? { dot: "accent" } : {}),
				...(flat.node.label ? { badges: [{ text: flat.node.label, tone: "warning" }] } : {}),
				...(kind === "tool" || kind === "marker" ? { tone: "muted" } : {}),
			};
		});
		const node = n(
			"picker",
			{
				role: "omp.overlay.tree",
				title: "Session tree",
				icon: "branch",
				noun: "entries",
				size: "lg",
				layout: "tree",
				preview: "none",
				query: t.searchQuery ?? "",
				placeholder: "Search the session",
				tabs: TREE_FILTERS,
				tab: t.filterMode,
				items,
				selected: rows[t.selectedIndex]?.node.entry.id ?? null,
				current: t.currentLeafId ? [t.currentLeafId] : [],
				empty: "No entries",
				actions: [
					{ ...CONFIRM_ACTION, label: "Go here" },
					{ id: "label", label: "Label", ...withKeys("app.tree.editLabel") },
					{ id: "copy", label: "Copy", ...withKeys("app.message.copy") },
					CLOSE_ACTION,
				],
			},
			undefined,
			SHEET_ID,
		);
		const selected = () => t.filteredNodes[t.selectedIndex]?.node;
		return {
			node,
			pick(activate, item) {
				const index = t.filteredNodes.findIndex((f) => f.node.entry.id === item);
				if (index < 0) return;
				t.selectedIndex = index;
				if (activate) t.onSelect?.(item);
			},
			act(act, value) {
				const s = selected();
				if (act === "confirm" && s) t.onSelect?.(s.entry.id);
				else if (act === "close") t.onCancel?.();
				else if (act === "label" && s) t.onLabelEdit?.(s.entry.id, s.label);
				else if (act === "copy") t.copySelected();
				else if (value && TREE_FILTERS.some((f) => f.id === value)) {
					t.filterMode = value;
					t.foldedNodes.clear();
					t.applyFilter();
				}
			},
		};
	};

	/**
	 * `/settings` as Tern's native settings page (`prefs`): every setting a row, on/off settings as
	 * switches, short value lists as segmented choices, longer ones as menus, and settings with a
	 * submenu (thinking level, theme, …) as buttons that open it. An open submenu is pi's own
	 * rendering, placed over the page; its keys go to pi as usual.
	 */
	const settingsSheet = (sel: SettingsSelectorComponent): Sheet => {
		type Item = { id: string; label: string; description?: string; currentValue: string; values?: string[]; submenu?: unknown };
		const list = (sel as unknown as { settingsList: unknown }).settingsList as {
			items: Item[];
			filteredItems: Item[];
			searchEnabled?: boolean;
			searchInput?: { getValue(): string; cursor?: number };
			selectedIndex: number;
			submenuComponent: Component | null;
			onChange(id: string, value: string): void;
			onCancel(): void;
			selectItem(id: string): void;
			activateItem(): void;
			handleInput(data: string): void;
		};
		const shown = list.searchEnabled ? list.filteredItems : list.items;
		const isSwitch = (it: Item) => it.values?.length === 2 && it.values.includes("true") && it.values.includes("false");
		const control = (it: Item) => {
			if (isSwitch(it)) return { k: "switch", on: it.currentValue === "true" };
			if (it.values?.length) {
				return {
					k: "choice",
					value: it.currentValue,
					options: it.values.map((v) => ({ value: v, label: v })),
					style: it.values.length <= 4 && it.values.every((v) => v.length <= 12) ? "segmented" : "menu",
				};
			}
			return { k: "action", label: stripAnsi(it.currentValue) || "Open", act: `open:${it.id}` };
		};
		const submenu = list.submenuComponent;
		const editor = submenu ? ansiNode(submenu, "se", "pi.settings.submenu", Math.min(54, readerCols())) : null;
		const query = list.searchEnabled ? list.searchInput?.getValue() : undefined;
		const node = n(
			"prefs",
			{
				role: "omp.overlay.settings",
				title: "pi settings",
				pages: [{ id: "general", label: "General", icon: "settings" }],
				page: "general",
				...(query ? { query, cursor: list.searchInput?.cursor } : {}),
				sections: [
					{
						id: "general",
						title: "General",
						rows: shown.map((it) => ({
							id: it.id,
							label: stripAnsi(it.label),
							...(it.description ? { hint: stripAnsi(it.description) } : {}),
							control: control(it),
						})),
					},
				],
				focus: shown[list.selectedIndex]?.id ?? null,
				editing: null,
			},
			editor ? [col([editor], { role: "omp.prefs.editor" }, "editor")] : undefined,
			SHEET_ID,
		);
		const open = (id: string) => {
			if (list.submenuComponent) list.handleInput("\x1b");
			list.selectItem(id);
			list.activateItem();
		};
		return {
			node,
			pick(activate, item) {
				if (!shown.some((it) => it.id === item)) return;
				if (activate) return open(item);
				if (list.submenuComponent) list.handleInput("\x1b");
				list.selectItem(item);
			},
			act(act, value) {
				if (act === "close") {
					if (value === undefined) list.onCancel();
					else if (list.submenuComponent) list.handleInput("\x1b");
				} else if (act.startsWith("open:")) open(act.slice(5));
				else if (act === "edit" && value) open(value);
			},
			change(item, value) {
				const it = list.items.find((x) => x.id === item);
				if (!it || value === null || value === undefined) return;
				const next = String(value);
				if (it.values && !it.values.includes(next)) return;
				list.selectItem(item);
				it.currentValue = next;
				list.onChange(item, next);
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
		if (shown instanceof TreeSelectorComponent) {
			const label = (shown as unknown as { labelInput?: { input: DialogField; handleInput(d: string): void } | null }).labelInput;
			if (!label) return undefined;
			return {
				title: "Label entry",
				detail: "An empty label removes it",
				field: label.input,
				submit: () => label.handleInput("\r"),
				cancel: () => label.handleInput("\x1b"),
			};
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
		// too close to the end, it would sit on the total label ("200K"): keep ~5 columns of room,
		// which is 6% of a wide pane but over a tenth of a narrow one
		if (at > 1 - Math.max(0.06, 5 / Math.max(1, cols))) return undefined;
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

	// ---------- turn actions (hold menu, rewind button) ----------

	/** Failed replies' error text by node id, for their Copy error button. */
	const copyErrors = new Map<string, string>();

	/** Transcript node id → the message component it describes, for actions on a turn. */
	const turnComps = new Map<string, object>();

	type MessageEntry = { id: string; parentId?: string | null; type: string; message?: { role?: string; content?: unknown } };
	const entryText = (e: MessageEntry | undefined): string => {
		const content = e?.message?.content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
	};

	/**
	 * The session entry a user or assistant component shows. Rebuilt transcripts carry the entry id;
	 * live ones do not, so the components of that role are paired with the current branch's
	 * messages of that role from the end (the newest component is the newest entry).
	 */
	const entryIdFor = (comp: object): string | undefined => {
		const own = (comp as { messageId?: unknown }).messageId;
		if (typeof own === "string" && own) return own;
		const ctx = ctxRef;
		if (!ctx) return undefined;
		const user = comp instanceof UserMessageComponent;
		const role = user ? "user" : "assistant";
		const comps = (containers().chat?.children ?? []).filter((k) =>
			user ? k instanceof UserMessageComponent : k instanceof AssistantMessageComponent && !(k as unknown as { isStreaming?: boolean }).isStreaming,
		);
		const pos = comps.indexOf(comp as Component);
		if (pos < 0) return undefined;
		const entries = (ctx.sessionManager.getBranch() as MessageEntry[]).filter((e) => e.type === "message" && e.message?.role === role);
		const paired = entries[entries.length - (comps.length - pos)];
		if (!user) return paired?.id;
		// user text can sit next to a skill block; prefer an entry that really holds this text
		const text = String((comp as unknown as { text?: unknown }).text ?? "").trim();
		if (paired && entryText(paired).includes(text)) return paired.id;
		return [...entries].reverse().find((e) => entryText(e).includes(text))?.id ?? paired?.id;
	};

	/** Submit through pi's own path (commands, /tree) without touching the draft or the history. */
	const quietly = async (text: string) => {
		const ed = composer as unknown as { onSubmit?: (t: string) => unknown; getText(): string; setText(t: string): void } | undefined;
		if (!ed?.onSubmit) return;
		const draft = ed.getText();
		quietSubmit = true;
		try {
			await ed.onSubmit(text);
		} finally {
			quietSubmit = false;
		}
		if (draft && !ed.getText()) ed.setText(draft);
	};

	/** "Rewind to here…": pi's /tree with this message selected, so the summary question and the rest are pi's. */
	const openTreeAt = async (entryId: string) => {
		await quietly("/tree");
		const shown = containers().editor?.children?.[0];
		if (!(shown instanceof TreeSelectorComponent)) return;
		const t = (shown as unknown as { treeList: { filteredNodes: { node: { entry: { id: string } } }[]; selectedIndex: number } }).treeList;
		const index = t.filteredNodes.findIndex((f) => f.node.entry.id === entryId);
		if (index >= 0) t.selectedIndex = index;
		tuiRef?.requestRender();
		scheduleRender(0);
	};

	/** A turn action from the transcript (`edit-turn`, `retry-turn`, `fork-turn`, `rewind`) on the node `owner`. */
	const turnAction = (act: string, owner: string): boolean => {
		const turnAct = act === "rewind" || act === "rewind-turn" ? "rewind" : /^(edit|retry|fork)-turn$/.exec(act)?.[1];
		if (!turnAct) return false;
		const comp = turnComps.get(owner);
		const entryId = comp ? entryIdFor(comp) : undefined;
		if (!entryId) {
			toast("That message is not in the session yet");
			return true;
		}
		if (turnAct === "rewind") void openTreeAt(entryId);
		else void quietly(`/tern-native turn ${turnAct} ${entryId}`);
		return true;
	};

	/**
	 * Runs as the `/tern-native turn …` command, which is what gives it navigateTree and fork.
	 * Edit & resend: back to before the prompt, its text in the editor. Retry: the same, then the
	 * prompt is sent again (an assistant turn retries the prompt that started it). Fork: a new
	 * session up to the message (before a prompt, which then waits in the editor).
	 */
	const runTurn = async (act: string, entryId: string, ctx: ExtensionCommandContext) => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("pi is still working: stop it first (Esc)", "warning");
			return;
		}
		const entry = ctx.sessionManager.getEntry(entryId) as MessageEntry | undefined;
		if (!entry) return ctx.ui.notify("That message is no longer in the session", "warning");
		const role = entry.message?.role;
		if (act === "fork") {
			await ctx.fork(entryId, { position: role === "user" ? "before" : "at" });
			return;
		}
		let prompt: MessageEntry | undefined = entry;
		while (prompt && prompt.message?.role !== "user") prompt = prompt.parentId ? (ctx.sessionManager.getEntry(prompt.parentId) as MessageEntry | undefined) : undefined;
		if (!prompt) return ctx.ui.notify("No prompt before that message", "warning");
		const draft = composer?.getText() ?? "";
		const result = await ctx.navigateTree(prompt.id);
		if (result.cancelled || act !== "retry") return;
		// navigating to a prompt puts its text in an empty editor: it is being sent instead
		if (composer && composer.getText() !== draft) composer.setText(draft);
		const content = prompt.message?.content;
		pi.sendUserMessage((typeof content === "string" || Array.isArray(content) ? content : entryText(prompt)) as never);
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
		// pi's containers are found by position: if a pi update moved them, show pi's own screen in
		// one block under a warning instead of a broken native one (an agent block shows only surfaces).
		degraded = process.env.PI_TERN_NATIVE_FORCE_DEGRADED === "1" ? "forced for testing" : checkLayout();
		if (degraded) trace(`layout: ${degraded}`);

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

	/**
	 * The shape of pi's interactive layout this extension reads (see `containers()`): the chat
	 * container inside the first child, and the editor container holding our composer. Returns what
	 * does not match, or undefined when everything is where it is expected.
	 */
	const checkLayout = (): string | undefined => {
		const kids = (tuiRef as unknown as { children?: unknown[] } | undefined)?.children;
		if (!Array.isArray(kids) || kids.length < 5) return `${Array.isArray(kids) ? kids.length : "no"} top-level containers`;
		const k = containers();
		if (!Array.isArray(k.chat?.children)) return "no chat container";
		if (!Array.isArray(k.editor?.children)) return "no editor container";
		if (composer && !k.editor!.children.includes(composer)) return "the editor is not where expected";
		return undefined;
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
		handler: async (args, ctx) => {
			const turn = /^turn ([a-z-]+) (\S+)$/.exec(args.trim());
			if (turn) return runTurn(turn[1]!, turn[2]!, ctx);
			ctx.ui.notify(
				active ? `Native Tern surface ${sf} · Tern ${hello?.ver ?? "?"} · ${cols} cols · ${hello?.kinds.length ?? 0} kinds` : "Native Tern surface is not active",
				"info",
			);
		},
	});
}
