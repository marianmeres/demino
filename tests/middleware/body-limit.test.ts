import { bodyLimit } from "../../src/middleware/body-limit.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

const encoder = new TextEncoder();

/** `duplex` is required for streaming request bodies but missing from some lib types. */
type StreamInit = RequestInit & { duplex: "half" };

/** Build a chunked (no Content-Length) request body. */
function streamBody(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

runTestServerTests([
	{
		name: "bodyLimit - body within Content-Length limit passes",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 1024 }));
			app.post("/", (req) => req.text());

			await assertResp(
				fetch(`${base}/`, { method: "POST", body: "hello" }),
				200,
				"hello",
			);
		},
	},
	{
		name: "bodyLimit - body exceeding Content-Length limit is rejected (413)",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 5 }));
			// handler must NOT run / body must not be read
			app.post("/", (req) => req.text());

			await assertResp(
				fetch(`${base}/`, { method: "POST", body: "0123456789" }), // 10 bytes > 5
				413,
			);
		},
	},
	{
		name: "bodyLimit - no body (GET) passes through untouched",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 5 }));
			app.get("/", () => "ok");

			await assertResp(fetch(`${base}/`), 200, "ok");
		},
	},
	{
		name:
			"bodyLimit - chunked body without Content-Length is rejected by default (411)",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 1024 }));
			app.post("/", (req) => req.text());

			await assertResp(
				fetch(`${base}/`, {
					method: "POST",
					body: streamBody("hello"),
					duplex: "half",
				} as StreamInit),
				411,
			);
		},
	},
	{
		name: "bodyLimit - chunked body allowed when allowUnknownLength is true",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 1024, allowUnknownLength: true }));
			app.post("/", (req) => req.text());

			await assertResp(
				fetch(`${base}/`, {
					method: "POST",
					body: streamBody("hello"),
					duplex: "half",
				} as StreamInit),
				200,
				"hello",
			);
		},
	},
	{
		name:
			"bodyLimit - multipart FormData upload within limit passes (stack-asset regression)",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 1024 * 1024 }));
			app.post("/upload", async (req) => {
				const fd = await req.formData();
				return (fd.get("file") as File)?.name ?? "no-file";
			});

			const fd = new FormData();
			fd.append("file", new Blob([encoder.encode("x".repeat(100))]), "a.txt");

			// FormData/Blob is a known-length body -> runtime sets Content-Length
			await assertResp(
				fetch(`${base}/upload`, { method: "POST", body: fd }),
				200,
				"a.txt",
			);
		},
	},
	{
		name: "bodyLimit - large multipart FormData upload is rejected (413)",
		fn: async ({ app, base }) => {
			app.use(bodyLimit({ maxSize: 50 }));
			app.post("/upload", async (req) => {
				await req.formData();
				return "should-not-reach";
			});

			const fd = new FormData();
			fd.append("file", new Blob([encoder.encode("x".repeat(500))]), "big.txt");

			await assertResp(
				fetch(`${base}/upload`, { method: "POST", body: fd }),
				413,
			);
		},
	},
]);
