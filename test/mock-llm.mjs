#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible chat completions server for headless tests: no network, no cost.
 *
 *   node test/mock-llm.mjs [port]      (default 47899)
 *
 * It streams a canned answer word by word (40ms a word) and ends with usage. Prompts that
 * contain "run-bash" get a `bash` tool call first; prompts that whose last message says "slow" stream for ~12s.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 47899);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWER =
	"Here is a **mock** answer from the test server. It streams word by word so the native surface " +
	"can show its working indicator, the generation rate and the turn usage line.\n\n" +
	"- one point\n- another point\n\n```ts\nconst answer = 42;\n```\n";

createServer(async (req, res) => {
	if (req.method !== "POST") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "mock-1", object: "model" }] }));
		return;
	}
	let raw = "";
	for await (const chunk of req) raw += chunk;
	let body = {};
	try {
		body = JSON.parse(raw);
	} catch {}
	const messages = body.messages ?? [];
	const last = messages[messages.length - 1] ?? {};
	const lastText = typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
	console.log(`from ${req.socket.remoteAddress}:${req.socket.remotePort} ua=${req.headers["user-agent"]} via=${req.headers.via ?? "-"}`);
	console.log(`${new Date().toISOString()} ${req.url} stream=${body.stream} messages=${messages.length} last=${last.role}: ${lastText.slice(0, 60)}`);

	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (delta, extra = {}) =>
		/* returns false under backpressure */ res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
	const finish = (reason, completion) => {
		res.write(
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 1200 + Math.round(raw.length / 4), completion_tokens: completion, total_tokens: 1200 + completion, prompt_tokens_details: { cached_tokens: 900 } } })}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	};

	send({ role: "assistant", content: "" });
	if (last.role === "user" && /run-bash/.test(lastText)) {
		send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] });
		send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo hello from mock" }) } }] });
		finish("tool_calls", 20);
		return;
	}
	const words = ANSWER.split(/(?<= )/);
	const delay = last.role === "user" && /\bslow\b/.test(lastText) ? 300 : 40;
	const started = Date.now();
	let closed = false;
	res.on("close", () => (closed = true));
	req.socket.on("end", () => console.log("socket: client sent FIN"));
	req.socket.on("error", (e) => console.log(`socket error: ${e.code ?? e.message}`));
	for (const [i, w] of words.entries()) {
		if (closed) {
			console.log(`client went away after ${i} words, ${Date.now() - started}ms`);
			return;
		}
		const ok = send({ content: w });
		if (!ok) console.log(`backpressure at word ${i}`);
		await sleep(delay);
	}
	finish("stop", words.length);
	console.log(`answered ${words.length} words in ${Date.now() - started}ms`);
}).listen(port, "127.0.0.1", () => console.log(`mock llm on http://127.0.0.1:${port}/v1`));
