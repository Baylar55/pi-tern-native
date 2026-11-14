import assert from "node:assert/strict";
import { test } from "node:test";
import { Reconciler } from "../src/reconcile.ts";
import { col, md, n, type Op, text } from "../src/tsp.ts";

const diff = (r: Reconciler, nodes: ReturnType<typeof n>[]) => {
	const ops: Op[] = [];
	r.region("main", nodes, ops);
	return ops;
};

test("first render adds every root from the last, each anchored before its successor", () => {
	const r = new Reconciler();
	const ops = diff(r, [col([text("hi", {}, "line")], { role: "x" }, "a"), md("**b**", {}, "b")]);
	assert.deepEqual(
		ops.map((o) => [o[0], o[1], o[2], o[3]]),
		[
			["add", "b", "main", null],
			["add", "a", "main", "b"],
		],
	);
	const added = ops[1]![4] as { c: { id: string }[] };
	assert.equal(added.c[0]!.id, "a.line", "a root's direct child joins with a dot");
});

test("deeper levels join with a slash (omp's id scheme)", () => {
	const r = new Reconciler();
	const ops = diff(r, [col([col([text("t", {}, "input")], {}, "line")], {}, "composer")]);
	const root = ops[0]![4] as { c: { id: string; c: { id: string }[] }[] };
	assert.equal(root.c[0]!.id, "composer.line");
	assert.equal(root.c[0]!.c[0]!.id, "composer.line/input");
});

test("an unchanged node object is skipped without ops", () => {
	const r = new Reconciler();
	const node = col([text("same", {}, "t")], {}, "a");
	diff(r, [node]);
	assert.deepEqual(diff(r, [node]), []);
});

test("streaming text that only grows goes out as an append", () => {
	const r = new Reconciler();
	diff(r, [md("Hello", {}, "m")]);
	assert.deepEqual(diff(r, [md("Hello world", {}, "m")]), [["text", "m", "append", " world"]]);
	assert.deepEqual(diff(r, [md("Bye", {}, "m")]), [["text", "m", "replace", "Bye"]]);
});

test("editor text is always replaced, never appended", () => {
	const r = new Reconciler();
	diff(r, [n("editor", { text: "ab", cursor: 2 }, undefined, "e")]);
	assert.deepEqual(diff(r, [n("editor", { text: "abc", cursor: 3 }, undefined, "e")]), [
		["set", "e", { cursor: 3 }],
		["text", "e", "replace", "abc"],
	]);
});

test("changed and removed props become one set op; removed props are null", () => {
	const r = new Reconciler();
	diff(r, [n("seg", { tone: "warning", title: "t", priority: 1 }, undefined, "s")]);
	assert.deepEqual(diff(r, [n("seg", { tone: "error", priority: 1 }, undefined, "s")]), [["set", "s", { tone: "error", title: null }]]);
});

test("removed roots are deleted; a changed kind is deleted and re-added", () => {
	const r = new Reconciler();
	diff(r, [text("a", {}, "a"), text("b", {}, "b")]);
	const ops = diff(r, [md("a", {}, "a")]);
	assert.deepEqual(ops[0], ["del", "b"]);
	assert.deepEqual(ops.slice(1).map((o) => [o[0], o[1]]), [
		["del", "a"],
		["add", "a"],
	]);
});

test("an inserted node anchors before its next sibling", () => {
	const r = new Reconciler();
	diff(r, [text("a", {}, "a"), text("c", {}, "c")]);
	const ops = diff(r, [text("a", {}, "a"), text("b", {}, "b"), text("c", {}, "c")]);
	assert.deepEqual(ops.map((o) => [o[0], o[1], o[2], o[3]]), [["add", "b", "main", "c"]]);
});

test("reset forgets the previous tree, so everything is added again", () => {
	const r = new Reconciler();
	const node = text("a", {}, "a");
	diff(r, [node]);
	r.reset();
	assert.equal(diff(r, [node])[0]![0], "add");
});
