// deno-lint-ignore-file no-explicit-any

import {
	getErrorMessage,
	HTTP_ERROR,
	HTTP_STATUS,
} from "@marianmeres/http-utils";
import { demino, deminoCompose } from "./src/demino.ts";

const web = demino();
web.get(
	"/foo",
	[
		(context) => {
			// throw new Error("Boo");
			// throw new HTTP_ERROR.Unauthorized();
		},
	],
	(req, info, context) => {
		return new Response("web bar " + JSON.stringify(context.params));
	}
);

web.get("/baz", (req, info, context) => {
	// return new Response("web bat\n");
});

web.error((req: Request, info: Deno.ServeHandlerInfo, error: any) => {
	// 	// console.log("custom error", error);
	// return new Response("custom error");
	return new Response(
		JSON.stringify({ ok: false, message: getErrorMessage(error) }) + "\n",
		{
			status: error?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR,
			headers: { "content-type": "application/json; charset=utf-8" },
		}
	);
});

// web.onNotFound((req: Request, info: Deno.ServeHandlerInfo) => {
// return new Response("noooooo found");
// });

const api = demino(
	"/api",
	[
		(context) => {
			console.log("api request");
		},
	],
	{ verbose: true }
);
api.get("/foo", (req, info, context) => {
	return new Response(`api bar\n${JSON.stringify(context.params)}\n`);
});

const blog = demino(
	"/blog",
	[
		async (context) => {
			if (context.params?.slug) {
				context.locals.post = await Promise.resolve(
					`Some post for "${context.params?.slug}"`
				);
			}
		},
	],
	{ verbose: true }
);
blog.get("/[slug]", (req, info, context) => {
	return new Response(`blog bar\n${JSON.stringify(context)}\n`);
});

// Deno.serve({ port: 4242 }, web);
// Deno.serve({ port: 4242 }, deminoCompose([web, blog, api]));

const app = demino();
app.get("/", () => "Hello world!");
Deno.serve(app);

// Deno.serve({ port: 4242 }, (req: Request, info: Deno.ServeHandlerInfo) => {
// 	return demino([web, api, blog])(req, info);
// });

// Deno.serve({ port: 4242 }, (req: Request, info: Deno.ServeHandlerInfo) => {
// 	const url = new URL(req.url);
// 	if (url.pathname === "some/special") {
// 		// ...
// 	} else {
// 		return demino.compose([web, api, blog])(req, info);
// 	}
// });

// async (req: Request, info: Deno.ServeHandlerInfo) => {
// 	console.log("Method:", req.method);
// 	const url = new URL(req.url);
// 	console.log("Path:", url.pathname);
// 	// console.log("Query parameters:", url.searchParams);
// 	// console.log("Headers:", req.headers);

// 	if (req.body) {
// 		const body = await req.text();
// 		// console.log("Body:", body);
// 	}

// 	return new Response("Hello, World!");
// }
