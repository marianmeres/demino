/**
 * Minimal ANSI color helpers for Demino's own console output (verbose route
 * listing, listen info). Deliberately tiny: two colors, no dependency, no runtime
 * API — only the `process.env` shape every supported runtime exposes.
 *
 * Honours the `NO_COLOR` convention (https://no-color.org/): when the variable is
 * present in the environment — with any value, even empty — the helpers return
 * their input unchanged. The check runs at call time, so a test (or an app) can
 * toggle it without reloading the module.
 *
 * @module
 */

/** The only bit of the environment this module reads; guarded so a missing `process` is just "colors on". */
type EnvHolder = { process?: { env?: Record<string, string | undefined> } };

/** `true` when color output is allowed, i.e. `NO_COLOR` is absent from the environment. */
export function colorEnabled(): boolean {
	const env = (globalThis as EnvHolder).process?.env;
	return !(env && "NO_COLOR" in env);
}

/** Wraps `s` in ANSI green, resetting to the default foreground afterwards. */
export function green(s: string): string {
	return colorEnabled() ? `\x1b[32m${s}\x1b[39m` : s;
}

/** Wraps `s` in ANSI red, resetting to the default foreground afterwards. */
export function red(s: string): string {
	return colorEnabled() ? `\x1b[31m${s}\x1b[39m` : s;
}
