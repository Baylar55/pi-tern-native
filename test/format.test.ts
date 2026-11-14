import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, ansiToSpans, fmtTokens, langOf, stripAnsi, trimBlank, trimRight } from "../src/format.ts";
import { IMAGE_PATH, imageSize } from "../src/images.ts";

test("stripAnsi removes SGR, OSC and APC sequences", () => {
	assert.equal(stripAnsi("\x1b[1;31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b_tsp;e;{}\x1b\\done"), "red link done");
});

test("fmtTokens: plain, thousands and millions", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1500), "1.5K");
	assert.equal(fmtTokens(15_000), "15K");
	assert.equal(fmtTokens(1_250_000), "1.3M");
});

test("langOf maps file extensions, case-insensitively, through any path separator", () => {
	assert.equal(langOf("C:\\src\\App.TS"), "typescript");
	assert.equal(langOf("/x/y/build.gradle"), "groovy");
	assert.equal(langOf("README"), undefined);
	assert.equal(langOf(42), undefined);
});

test("trimRight keeps closing SGR codes; trimBlank drops blank edge lines", () => {
	assert.equal(trimRight("text   \x1b[0m"), "text\x1b[0m");
	assert.deepEqual(trimBlank(["", "  ", "a", " ", "b", "\x1b[0m  "]), ["a", " ", "b"]);
});

test("ansiToSpans maps foreground colours to theme styles and merges equal runs", () => {
	const styles = new Map([["38;2;255;0;0", "error"]]);
	const spans = ansiToSpans("\x1b[38;2;255;0;0mError:\x1b[39m \x1b[1mbold\x1b[22m plain", (sgr) => styles.get(sgr));
	assert.deepEqual(spans, [{ t: "Error:", s: "error" }, { t: " " }, { t: "bold", s: "strong" }, { t: " plain" }]);
});

test("ago: now, minutes, hours, days, weeks", () => {
	const now = Date.now();
	assert.equal(ago(now), "now");
	assert.equal(ago(new Date(now - 5 * 60_000)), "5m");
	assert.equal(ago(now - 3 * 3600_000), "3h");
	assert.equal(ago(now - 2 * 86400_000), "2d");
	assert.equal(ago(now - 14 * 86400_000), "2w");
	assert.equal(ago("not a date"), "");
});

test("IMAGE_PATH finds absolute image paths in text, not other extensions", () => {
	const text = "see C:\\Users\\me\\AppData\\Local\\Temp\\pi-clipboard-1.png and /tmp/shot.JPG but not /tmp/a.pngx or notes.txt";
	assert.deepEqual(text.match(IMAGE_PATH), ["C:\\Users\\me\\AppData\\Local\\Temp\\pi-clipboard-1.png", "/tmp/shot.JPG"]);
});

test("imageSize reads PNG, GIF and BMP headers", () => {
	const png = Buffer.alloc(32);
	png.writeUInt32BE(0x89504e47, 0);
	png.writeUInt32BE(640, 16);
	png.writeUInt32BE(480, 20);
	assert.deepEqual(imageSize(png), { w: 640, h: 480 });

	const gif = Buffer.alloc(16);
	gif.write("GIF89a", 0, "ascii");
	gif.writeUInt16LE(32, 6);
	gif.writeUInt16LE(16, 8);
	assert.deepEqual(imageSize(gif), { w: 32, h: 16 });

	const bmp = Buffer.alloc(32);
	bmp.write("BM", 0, "ascii");
	bmp.writeInt32LE(100, 18);
	bmp.writeInt32LE(-50, 22); // top-down bitmaps store a negative height
	assert.deepEqual(imageSize(bmp), { w: 100, h: 50 });

	assert.equal(imageSize(Buffer.from("not an image")), undefined);
});
