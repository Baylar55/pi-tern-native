/**
 * Tern Surface Protocol (TSP v1) wire helpers.
 *
 * Framing (as omp writes it):  ESC _ tsp ; <verb> [;key=value]* ; <json> ESC \
 *   q  query (hello)        o  open surface       f  frame (ops)       x  close surface
 * Tern answers with  r  (reply) and  e  (events: ack, resize, theme, action, send, edit, …).
 */

export const APC = "\x1b_tsp;";
export const ST = "\x1b\\";
export const OSC = "\x1b]877;tsp;";
const MAX_APC = 65536;

export interface Hello {
	r: "hello";
	v: number;
	term: string;
	ver?: string;
	kinds: string[];
	features: string[];
	apc?: number;
	credits?: number;
	cols?: number;
	dark?: boolean;
	reduceMotion?: boolean;
}

export type Op = unknown[];
export interface TspNode {
	id?: string;
	k: string;
	p?: Record<string, unknown>;
	c?: TspNode[];
}

let chunkSeq = 1;

/** A chunk must not begin with something the parser would read as a `key=value;` parameter. */
const PARAM_LIKE = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*;/;

export function encode(verb: string, body: unknown, limit = MAX_APC): string {
	const json = JSON.stringify(body);
	if (Buffer.byteLength(json, "utf8") <= limit) return `${APC}${verb};${json}${ST}`;
	// Chunked: ;c=<id> on every part, ;m=1 on all but the last.
	const id = (chunkSeq++).toString(36);
	const parts: string[] = [];
	let rest = json;
	while (rest.length > 0) {
		let take = Math.min(rest.length, Math.floor(limit / 4));
		while (take < rest.length && (PARAM_LIKE.test(rest.slice(take, take + 200)) || isLowSurrogate(rest.charCodeAt(take)))) take--;
		parts.push(rest.slice(0, take));
		rest = rest.slice(take);
	}
	return parts.map((p, i) => `${APC}${verb};c=${id}${i < parts.length - 1 ? ";m=1" : ""};${p}${ST}`).join("");
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A raw (non-JSON) body with `key=value` params, chunked like omp's encoder when it exceeds the APC
 * limit: `;c=<id>` on every part, `;m=1` on all but the last. Used for inline blobs (base64).
 */
export function encodeRaw(verb: string, params: Record<string, string>, body: string, limit = MAX_APC): string {
	const head = Object.entries(params)
		.map(([k, v]) => `;${k}=${v}`)
		.join("");
	if (body.length + head.length + 16 <= limit) return `${APC}${verb}${head};${body}${ST}`;
	const id = (chunkSeq++).toString(36);
	const size = Math.max(1024, limit - head.length - 64);
	const parts: string[] = [];
	for (let i = 0; i < body.length; i += size) parts.push(body.slice(i, i + size));
	return parts
		.map((part, i) => `${APC}${verb}${i === 0 ? head : ""};c=${id}${i < parts.length - 1 ? ";m=1" : ""};${part}${ST}`)
		.join("");
}

export function encodeHello(version: string): string {
	return encode("q", { q: "hello", v: [1], app: "pi", features: ["edit", "undo", "send"], ver: version });
}

export interface Inbound {
	verb: string;
	body: any;
}

/**
 * Incremental parser for inbound APC messages. Returns complete messages and whether the chunk
 * contained only TSP traffic (so it can be consumed before pi's editor sees it).
 */
export class InboundParser {
	private pending = "";

	/** Tern → program frames: APC on Unix, OSC 877 on Windows (ConPTY cannot carry APC input). */
	feed(data: string): { messages: Inbound[]; rest: string } {
		let buf = this.pending + data;
		this.pending = "";
		const messages: Inbound[] = [];
		let rest = "";
		for (;;) {
			const a = buf.indexOf(APC);
			const o = buf.indexOf(OSC);
			const start = a === -1 ? o : o === -1 ? a : Math.min(a, o);
			if (start === -1) {
				rest += buf;
				break;
			}
			rest += buf.slice(0, start);
			const isOsc = start === o;
			const bodyStart = start + (isOsc ? OSC.length : APC.length);
			let end = buf.indexOf(ST, bodyStart);
			let termLen = ST.length;
			if (isOsc) {
				const bel = buf.indexOf("\x07", bodyStart);
				if (bel !== -1 && (end === -1 || bel < end)) {
					end = bel;
					termLen = 1;
				}
			}
			if (end === -1) {
				this.pending = buf.slice(start);
				break;
			}
			const inner = buf.slice(bodyStart, end);
			buf = buf.slice(end + termLen);
			const semi = inner.indexOf(";");
			const verb = semi === -1 ? inner : inner.slice(0, semi);
			const jsonStart = inner.indexOf("{", semi + 1);
			if (jsonStart === -1) continue;
			try {
				messages.push({ verb, body: JSON.parse(inner.slice(jsonStart)) });
			} catch {
				/* ignore malformed */
			}
		}
		return { messages, rest };
	}

	get buffering(): boolean {
		return this.pending.length > 0;
	}
}

// ---------- node helpers (mirroring omp's describe.ts) ----------

export const n = (k: string, p?: Record<string, unknown>, c?: TspNode[], id?: string): TspNode => {
	const node: TspNode = { k };
	if (id !== undefined) node.id = id;
	if (p) {
		const clean: Record<string, unknown> = {};
		let any = false;
		for (const key in p) {
			const v = p[key];
			if (v !== undefined && v !== null) {
				clean[key] = v;
				any = true;
			}
		}
		if (any) node.p = clean;
	}
	if (c && c.length > 0) node.c = c;
	return node;
};

export const span = (t: string, s?: string) => (s ? { t, s } : { t });
export const text = (t: string, p: Record<string, unknown> = {}, id?: string) => n("text", { ...p, text: t }, undefined, id);
export const spans = (s: { t: string; s?: string }[], p: Record<string, unknown> = {}, id?: string) =>
	n("text", { ...p, spans: s }, undefined, id);
export const row = (c: TspNode[], p: Record<string, unknown> = {}, id?: string) => n("row", p, c, id);
export const col = (c: TspNode[], p: Record<string, unknown> = {}, id?: string) => n("col", p, c, id);
export const md = (t: string, p: Record<string, unknown> = {}, id?: string) => n("md", { ...p, text: t }, undefined, id);
export const icon = (name: string, p: Record<string, unknown> = {}, id?: string) => n("icon", { ...p, name }, undefined, id);
