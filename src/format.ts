/** Pure text helpers: ANSI handling, number and time formatting, languages by file extension. */

export const LANG: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
	java: "java", kt: "kotlin", py: "python", rb: "ruby", go: "go", rs: "rust", cs: "csharp",
	c: "c", h: "c", cpp: "cpp", hpp: "cpp", json: "json", md: "markdown", sql: "sql", xml: "xml",
	yaml: "yaml", yml: "yaml", toml: "toml", sh: "bash", bash: "bash", ps1: "powershell",
	html: "html", css: "css", scss: "scss", gradle: "groovy", properties: "properties", lua: "lua",
};

export function langOf(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
	return ext ? LANG[ext] : undefined;
}

export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g, "");
}

export function fmtTokens(v: number): string {
	if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${+(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}K`;
	return `${v}`;
}

export function clock(ts: unknown): string | undefined {
	const d = typeof ts === "number" || typeof ts === "string" ? new Date(ts) : undefined;
	if (!d || Number.isNaN(d.getTime())) return undefined;
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Drop the trailing padding pi-tui adds to every line, keeping any closing SGR codes. */
export function trimRight(line: string): string {
	return line.replace(/[ \t]+((?:\x1b\[[0-9;:]*m)*)$/, "$1");
}

export function trimBlank(lines: string[]): string[] {
	let a = 0;
	let b = lines.length;
	while (a < b && stripAnsi(lines[a]!).trim() === "") a++;
	while (b > a && stripAnsi(lines[b - 1]!).trim() === "") b--;
	return lines.slice(a, b);
}

export function resultText(result: any): string {
	if (!result?.content) return "";
	return result.content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.replace(/\s+$/, "");
}

/**
 * pi colours notices with its theme; Tern wants semantic styles. Map each run's foreground to the
 * theme token that produced it (warning, error, success…) so Tern draws it in its own palette.
 */
export function ansiToSpans(text: string, styleOf: (sgr: string) => string | undefined): { t: string; s?: string }[] {
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

/** "3h", "2d": how long ago, for picker columns (a fixed string, so the catalogue does not change every render). */
export const ago = (at: unknown): string => {
	const t = at instanceof Date ? at.getTime() : typeof at === "number" || typeof at === "string" ? new Date(at).getTime() : Number.NaN;
	if (!Number.isFinite(t)) return "";
	const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
	if (s < 60) return "now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 30) return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
	return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};
export const homeShort = (p: unknown) => {
	const home = process.env.USERPROFILE ?? process.env.HOME;
	const s = String(p ?? "");
	return home && s.toLowerCase().startsWith(home.toLowerCase()) ? `~${s.slice(home.length)}` : s;
};
