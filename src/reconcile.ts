/**
 * Keyed tree diff → TSP ops (add / del / set / text), the same op dialect omp emits.
 *
 * Nodes are described with *local* ids (or none); this module qualifies them so every id is
 * unique in the surface.
 *
 * Speed: describe() reuses node objects for everything that did not change (finished messages,
 * tool cards, notices). Qualified copies are cached per source object, so an unchanged subtree
 * comes back as the *same* object and is skipped without walking it. On a keystroke only the
 * composer is diffed, however long the transcript is.
 */
import type { Op, TspNode } from "./tsp.ts";

/** Kinds whose `text` prop travels as a `text` op, never inside `set` (omp's wire rule). */
const TEXT_KINDS = new Set(["text", "md", "code", "ansi", "math", "editor", "input", "shimmer"]);

/**
 * omp's id scheme: a component root's direct children join with `.`, deeper levels with `/`
 * (`3` → `3.line` → `3.line/input`). Tern resolves relative anchors (`caret: "line/input"`)
 * against `<root>.`, so the scheme matters.
 */
function childId(parent: string | null, local: string): string {
	if (parent === null) return local;
	return /[./]/.test(parent) ? `${parent}/${local}` : `${parent}.${local}`;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

export class Reconciler {
	private regions = new Map<string, TspNode[]>();
	private qualified = new WeakMap<TspNode, { id: string; node: TspNode }>();
	/** Nodes visited by the last render, for diagnostics. */
	visited = 0;

	/** Forget everything (after the surface is reopened). */
	reset(): void {
		this.regions.clear();
		this.qualified = new WeakMap();
	}

	private qualify(node: TspNode, parent: string | null, index: number): TspNode {
		const id = childId(parent, node.id ?? String(index));
		const hit = this.qualified.get(node);
		if (hit && hit.id === id) return hit.node;
		this.visited++;
		const out: TspNode = { id, k: node.k };
		if (node.p) out.p = node.p;
		if (node.c) out.c = node.c.map((child, i) => this.qualify(child, id, i));
		this.qualified.set(node, { id, node: out });
		return out;
	}

	/** Diff one region's children (`main`, `dock`, `layer`) and append ops. */
	region(regionId: string, nodes: TspNode[], ops: Op[]): void {
		this.visited = 0;
		const next = nodes.map((node, i) => this.qualify(node, null, i));
		const prev = this.regions.get(regionId) ?? [];
		this.list(regionId, prev, next, ops);
		this.regions.set(regionId, next);
	}

	private list(parent: string, prev: TspNode[], next: TspNode[], ops: Op[]): void {
		if (prev === next) return;
		const prevById = new Map(prev.map((node) => [node.id!, node]));
		const nextIds = new Set(next.map((node) => node.id!));
		for (const node of prev) if (!nextIds.has(node.id!)) ops.push(["del", node.id]);

		// Walk from the end so each insertion can anchor before an already-present sibling.
		const later: Op[] = [];
		for (let i = next.length - 1; i >= 0; i--) {
			const node = next[i]!;
			const old = prevById.get(node.id!);
			if (old === node) continue; // unchanged subtree: nothing to send, nothing to walk
			const before = i + 1 < next.length ? next[i + 1]!.id : null;
			if (!old) later.push(["add", node.id, parent, before, node]);
			else if (old.k !== node.k) later.push(["del", node.id], ["add", node.id, parent, before, node]);
			else {
				const inner: Op[] = [];
				this.node(old, node, inner);
				later.push(...inner);
			}
		}
		ops.push(...later);
	}

	private node(prev: TspNode, next: TspNode, ops: Op[]): void {
		const id = next.id!;
		const a = prev.p ?? {};
		const b = next.p ?? {};
		if (a !== b) {
			const set: Record<string, unknown> = {};
			let changed = false;
			const textual = TEXT_KINDS.has(next.k);
			for (const key in b) {
				if (textual && key === "text") continue;
				if (!sameValue(a[key], b[key])) {
					set[key] = b[key];
					changed = true;
				}
			}
			for (const key in a) {
				if (textual && key === "text") continue;
				if (!(key in b)) {
					set[key] = null;
					changed = true;
				}
			}
			if (changed) ops.push(["set", id, set]);
			if (textual) {
				const before = typeof a.text === "string" ? a.text : "";
				const after = typeof b.text === "string" ? b.text : "";
				if (before !== after) {
					if (before.length > 0 && after.startsWith(before) && next.k !== "editor") {
						ops.push(["text", id, "append", after.slice(before.length)]);
					} else {
						ops.push(["text", id, "replace", after]);
					}
				}
			}
		}
		this.list(id, prev.c ?? [], next.c ?? [], ops);
	}
}
