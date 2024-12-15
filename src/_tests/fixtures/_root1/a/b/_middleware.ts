// deno-lint-ignore-file no-explicit-any

export default [
	(_r: Request, _i: any, c: any) => {
		c.locals.mw ??= [];
		c.locals.mw.push("A/B");
	},
];
