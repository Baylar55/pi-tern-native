/**
 * Test fixture for pi-tern-native: commands that open the dialogs and overlays the native surface
 * has to show. Loaded only by test/dev-launch.cmd, never installed.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	// heartbeat in the debug log: shows whether pi's event loop is alive during a test
	const log = process.env.PI_TERN_NATIVE_LOG;
	if (log && process.env.PI_TERN_HEARTBEAT === "1") {
		setInterval(() => {
			try {
				appendFileSync(log, `${JSON.stringify({ t: Date.now(), dir: "hb" })}\n`);
			} catch {}
		}, 250).unref();
		const note = (ev: string, body: unknown) => {
			try {
				appendFileSync(log, `${JSON.stringify({ t: Date.now(), dir: "pi", verb: ev, body })}\n`);
			} catch {}
		};
		pi.on("message_end", (e: any) => note("message_end", { role: e.message?.role, stop: e.message?.stopReason, error: e.message?.errorMessage }));
		pi.on("agent_start", () => note("agent_start", {}));
		pi.on("message_update", (e: any) => {
			const text = (e.message?.content ?? []).map((c: any) => c.text ?? c.thinking ?? "").join("");
			note("message_update", { len: text.length, type: e.assistantMessageEvent?.type });
		});
		process.on("warning", (w) => note("warning", { w: String(w) }));
		pi.on("agent_end", () => note("agent_end", {}));
	}

	pi.registerCommand("t-select", {
		description: "fixture: ctx.ui.select",
		handler: async (_args, ctx) => {
			const r = await ctx.ui.select("Pick a fruit", ["Apple", "Banana", "Cherry", "Durian"]);
			ctx.ui.notify(`selected: ${r ?? "(cancelled)"}`, "info");
		},
	});
	pi.registerCommand("t-input", {
		description: "fixture: ctx.ui.input",
		handler: async (_args, ctx) => {
			const r = await ctx.ui.input("Your name", "type here");
			ctx.ui.notify(`input: ${r ?? "(cancelled)"}`, "info");
		},
	});
	pi.registerCommand("t-confirm", {
		description: "fixture: ctx.ui.confirm",
		handler: async (_args, ctx) => {
			const r = await ctx.ui.confirm("Delete everything?", "This cannot be undone.");
			ctx.ui.notify(`confirm: ${r}`, "info");
		},
	});
	pi.registerCommand("t-custom", {
		description: "fixture: pi.sendMessage without a renderer",
		handler: async () => {
			pi.sendMessage({ customType: "fixture-note", content: "A **custom** message from the fixture.", display: true });
		},
	});
	pi.registerCommand("t-overlay", {
		description: "fixture: ctx.ui.custom overlay",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => {
					const text = new Text(`${theme.fg("accent", "Overlay fixture")}\nPress Escape to close.`, 1, 1);
					return {
						render: (w: number) => text.render(w),
						invalidate: () => text.invalidate(),
						handleInput: (data: string) => {
							if (matchesKey(data, "escape")) done();
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "50%" } },
			);
			ctx.ui.notify("overlay closed", "info");
		},
	});
}
