// deno-lint-ignore-file no-explicit-any

import type { Demino } from "./demino.ts";
import { walkSync } from "@std/fs";
import { normalize, basename } from "@std/path";

/**
 * Will scan the provided root dirs and register route handlers
 * for the given app instance
 */
export function deminoFileBased(app: Demino, rootDirs: string | string[]) {
	if (!Array.isArray(rootDirs)) rootDirs = [rootDirs];

	throw new Error("Not implemented, work in progress");
	// work in progress

	// rootDirs = rootDirs.map(normalize);
	// const list = [];

	// for (const rootDir of rootDirs) {
	// 	for (const dirEntry of walkSync(rootDir, { includeDirs: false })) {
	// 		// skip dots and underscores
	// 		if ([".", "_"].includes(dirEntry.name[0])) continue;

	// 		let key = dirEntry.path;
	// 		let name = dirEntry.name;

	// 		// normalize "index.[t|j]s" to empty
	// 		if (/^index.[jt]s$/.test(dirEntry.name)) {
	// 			name = "";
	// 		}

	// 		// dirEntry.path.slice(rootDir.length)

	// 		// console.log(11, key);

	// 		console.log(dirEntry.path.slice(rootDir.length));
	// 	}
	// }
}
