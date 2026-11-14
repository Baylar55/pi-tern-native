import assert from "node:assert/strict";
import { test } from "node:test";
import { APC, encode, encodeRaw, InboundParser, ST } from "../src/tsp.ts";

/** Reassemble what a chunked encode() wrote: verb, and the body joined across parts. */
function decode(wire: string): { verb: string; body: string; parts: number } {
	const parts = wire.split(ST).filter(Boolean);
	let verb = "";
	let body = "";
	for (const part of parts) {
		assert.ok(part.startsWith(APC), "every part starts with the APC introducer");
		const fields = part.slice(APC.length).split(";");
		verb = fields[0]!;
		// params are key=value fields between the verb and the payload
		let i = 1;
		while (i < fields.length - 1 && /^[A-Za-z0-9_-]+=/.test(fields[i]!)) i++;
		body += fields.slice(i).join(";");
	}
	return { verb, body, parts: parts.length };
}

test("encode: small bodies go out in one APC", () => {
	const wire = encode("f", { sf: "pi:1", s: 1, ops: [] });
	assert.equal(wire, `${APC}f;{"sf":"pi:1","s":1,"ops":[]}${ST}`);
});

test("encode: large bodies are chunked and reassemble to the same JSON", () => {
	const body = { text: "x;y=z;".repeat(5000) + "\u{1F600}".repeat(500) };
	const wire = encode("f", body, 4096);
	const { verb, body: joined, parts } = decode(wire);
	assert.equal(verb, "f");
	assert.ok(parts > 1);
	assert.deepEqual(JSON.parse(joined), body);
});

test("encode: a chunk never begins with something that parses as a key=value param", () => {
	const body = { t: "a=b;".repeat(4000) };
	const wire = encode("f", body, 2048);
	for (const part of wire.split(ST).filter(Boolean)) {
		const fields = part.slice(APC.length).split(";");
		let i = 1;
		while (i < fields.length - 1 && /^[cm]=/.test(fields[i]!)) i++;
		assert.ok(!/^[A-Za-z0-9_-]+=/.test(fields[i] ?? "") || i === fields.length - 1);
	}
	assert.deepEqual(JSON.parse(decode(wire).body), body);
});

test("encodeRaw: base64 blobs are chunked with params on the first part only", () => {
	const data = Buffer.alloc(20_000, 7).toString("base64");
	const wire = encodeRaw("b", { id: "abc", mime: "image/png" }, data, 4096);
	const parts = wire.split(ST).filter(Boolean);
	assert.ok(parts.length > 1);
	assert.ok(parts[0]!.includes(";id=abc;mime=image/png;"));
	assert.ok(!parts[1]!.includes("id=abc"));
	assert.equal(parts.map((p) => p.slice(p.lastIndexOf(";") + 1)).join(""), data);
});

test("parser: APC messages are taken out of the input, the rest is kept", () => {
	const p = new InboundParser();
	const { messages, rest } = p.feed(`a${APC}e;{"ev":"ack","s":3}${ST}b`);
	assert.deepEqual(messages, [{ verb: "e", body: { ev: "ack", s: 3 } }]);
	assert.equal(rest, "ab");
});

test("parser: OSC 877 (Windows) with BEL or ST terminators", () => {
	const p = new InboundParser();
	const { messages, rest } = p.feed(`\x1b]877;tsp;e;{"ev":"resize","cols":90}\x07\x1b]877;tsp;r;{"r":"hello","v":1}\x1b\\`);
	assert.deepEqual(
		messages.map((m) => m.body),
		[{ ev: "resize", cols: 90 }, { r: "hello", v: 1 }],
	);
	assert.equal(rest, "");
});

test("parser: a message split across reads is buffered until complete", () => {
	const p = new InboundParser();
	const first = p.feed(`x${APC}e;{"ev":"ac`);
	assert.deepEqual(first.messages, []);
	assert.equal(first.rest, "x");
	assert.ok(p.buffering);
	const second = p.feed(`k","s":1}${ST}y`);
	assert.deepEqual(second.messages, [{ verb: "e", body: { ev: "ack", s: 1 } }]);
	assert.equal(second.rest, "y");
	assert.ok(!p.buffering);
});

test("parser: malformed JSON is dropped without throwing", () => {
	const p = new InboundParser();
	const { messages, rest } = p.feed(`${APC}e;{nope${ST}k`);
	assert.deepEqual(messages, []);
	assert.equal(rest, "k");
});
