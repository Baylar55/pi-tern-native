/** pi's identity on the Tern surface: the start-screen tips, the pixel logo and the palette stylesheet. */
import { createHash } from "node:crypto";

export const TIPS = [
	"Start a message with ! to run a shell command, or !! to keep its output out of the context",
	"Type / for commands and @ to attach files",
	"Shift+Tab changes the thinking level, Ctrl+L switches the model",
	"Escape stops the agent, Ctrl+P cycles through your models",
	"Run /tree to go back to an earlier point in the session",
];

/**
 * pi's logo (components/pi-logo.ts): the 4x4 pixel "Pi" in coral, blue and yellow.
 *
 * Built like Tern's built-in omp mark so Tern inlines it and runs the same welcome intro:
 * `mark` shapes fade in, the `trace` outline draws itself first. Unlike omp's, the fills are
 * solid brand colours rather than a gradient Tern recolours to ink, so pi keeps its identity.
 * The trace uses currentColor, Tern's text colour, so it suits light and dark themes.
 */
export const PI_CORAL = "#e48a7a";
export const PI_BLUE = "#4f8eb3";
export const PI_YELLOW = "#eab65d";
export const PI_LOGO = (() => {
	const coral = "M14 13h27v18h-9v-9h-18z";
	const blue = "M14 22h9v9h9v9h-9v9h-9z";
	const yellow = "M41 31h9v18h-9z";
	const outline = "M14 13h27v18h-9v-9h-9v9h9v9h-9v9h-9z";
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 12 44 38" shape-rendering="crispEdges">`,
		`<path class="mark" fill="${PI_CORAL}" d="${coral}"/>`,
		`<path class="mark" fill="${PI_BLUE}" d="${blue}"/>`,
		`<path class="mark" fill="${PI_YELLOW}" d="${yellow}"/>`,
		`<path class="trace" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round" pathLength="1" d="${outline}${yellow}"/>`,
		`</svg>`,
	].join("\n");
	const bytes = Buffer.from(svg, "utf8");
	return { bytes, mime: "image/svg+xml", id: createHash("sha256").update(bytes).digest("hex") };
})();

/**
 * pi's palette for Tern's chat chrome, sent with the TSP `styles` feature (`s` verb). It
 * retints what Tern otherwise paints in omp's purple/pink/cyan: the aurora under the composer
 * and the haze behind the dotted start screen.
 */
export const PI_STYLES = `
[data-role^='omp.editor'] {
	--rd-aurora:
		light-dark(#d9705f, ${PI_CORAL}), light-dark(#d39a35, ${PI_YELLOW}), light-dark(#3f7ea6, ${PI_BLUE}),
		light-dark(#5f9cc4, #7fb3d4), light-dark(#d9705f, ${PI_CORAL});
}
[data-role='omp.composer.model'] .sf-t-accent {
	color: light-dark(#3f7ea6, #7fb3d4) !important;
}
/* the start-screen logo is decoration: Tern opens image nodes in its viewer on click, not this one */
[data-role='omp.welcome.logo'],
[data-role='omp.welcome.logo'] * {
	pointer-events: none !important;
	cursor: default !important;
}
[data-role='omp.welcome.lockup'] {
	user-select: none !important;
}
/* Tern's own folder chip: the git chip already says where pi works, and omp shows none */
[data-role='omp.composer.bar'] > .sf-place {
	display: none !important;
}
.sf-slot::before {
	background-image:
		radial-gradient(560px 110px at 50% 100%, rgb(228 138 122 / 9%), transparent),
		radial-gradient(circle, var(--l4) 0 1px, transparent 1.5px) !important;
}
`;
