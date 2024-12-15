// deno-lint-ignore-file no-explicit-any

// this middleware will be effective in _root1 (if used as combined)

export default [
	(_r: Request, _i: any, c: any) => {
		c.locals.mw ??= [];
		c.locals.mw.push("/");
	},
];
