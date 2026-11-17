#!/usr/bin/env node
/**
 * Builds a long session for performance checks: repeats the turns of a recorded test session
 * (prompts, tool calls, tool results, answers) until it has about N entries, with fresh ids
 * chained by parentId, and writes it next to the template.
 *
 *   node test/make-long-session.mjs [entries=600]   → prints the new session file's path
 *
 * The template is the newest session in test/agent/sessions that has a tool call, so record one
 * first (for example with test/shot.sh and "run-grep please").
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = Number(process.argv[2] ?? 600);
const root = join(dirname(fileURLToPath(import.meta.url)), "agent", "sessions");

const files = readdirSync(root)
	.flatMap((dir) => readdirSync(join(root, dir)).map((f) => join(root, dir, f)))
	.filter((f) => f.endsWith(".jsonl") && !f.includes("long-"))
	.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const template = files.find((f) => readFileSync(f, "utf8").includes('"toolCall"'));
if (!template) throw new Error("no recorded session with a tool call in test/agent/sessions");

const entries = readFileSync(template, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const header = entries[0];
// everything up to the first user message is setup (model, thinking level, system prompt)
const firstUser = entries.findIndex((e) => e.type === "message" && e.message?.role === "user");
const setup = entries.slice(1, firstUser);
const turns = entries.slice(firstUser).filter((e) => e.type === "message");

const id = () => randomUUID().slice(0, 8);
const out = [];
let parent = null;
const push = (e) => {
	const copy = { ...e, id: id(), parentId: parent };
	parent = copy.id;
	out.push(copy);
};
for (const e of setup) push(e);
for (let round = 0; out.length < target; round++) {
	for (const e of turns) {
		if (e.message?.role === "user") {
			const text = `${typeof e.message.content === "string" ? e.message.content : e.message.content?.[0]?.text ?? ""} (#${round + 1})`;
			push({ ...e, message: { ...e.message, content: [{ type: "text", text }] } });
		} else push(e);
	}
}

const sessionId = randomUUID();
const file = join(dirname(template), `long-${out.length}-${sessionId}.jsonl`);
writeFileSync(file, [{ ...header, id: sessionId }, ...out].map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(file);
