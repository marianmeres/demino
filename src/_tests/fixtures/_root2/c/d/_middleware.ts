export default [
	(_r: Request, _i: any, c: any) => {
		c.locals.mw ??= [];
		c.locals.mw.push("C/D");
	},
];
