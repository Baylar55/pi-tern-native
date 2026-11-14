/** Image files referenced by path in messages: what counts as one, and their pixel size from the header. */

/**
 * Absolute paths to image files in message text: what pi inserts when you paste an image
 * (`%TEMP%\pi-clipboard-<uuid>.png`), or any image path typed or dropped in. Only paths that exist
 * on disk become attachments; anything else stays plain text.
 */
export const IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?]*?\.(?:png|jpe?g|gif|webp|bmp)(?![\w.])/gi;
export const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Pixel size from the file header (PNG, GIF, JPEG, WebP, BMP), for chip labels and layout hints. */
export function imageSize(b: Buffer): { w: number; h: number } | undefined {
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
