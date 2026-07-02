import { HTTP_STATUS } from "@marianmeres/http-utils";
import { rateLimit, sleep } from "../../src/mod.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "rate limit: 429 carries a Retry-After header",
		fn: async ({ app, base }) => {
			app.get(
				"/",
				rateLimit(() => "one-client", { maxSize: 1, refillSizePerSecond: 1 }),
				() => "ok",
			);
			// first request consumes the only token
			await assertResp(fetch(`${base}/`), 200, "ok");
			// second is limited -> 429 with a positive integer Retry-After
			await assertResp(fetch(`${base}/`), 429, undefined, {
				"Retry-After": /^[1-9][0-9]*$/,
			});
		},
	},
	{
		// Regression: pre-1.7.0 the `lastAccess` field was set once on first
		// contact and never refreshed. With cleanupProbability set high, an
		// active client could be evicted mid-stream — and its bucket recreated
		// at full capacity on the next request, defeating the rate limit.
		name: "rate limit: cleanup does not evict active clients",
		fn: async ({ app, base }) => {
			app.get(
				"/",
				rateLimit(() => "active-client", {
					maxSize: 2,
					refillSizePerSecond: 1,
					// run cleanup on every request and use a tight stale threshold
					// (maxSize/refillSizePerSecond = 2 seconds) so eviction is
					// guaranteed to be considered each call
					cleanupProbability: 1,
				}),
				() => "",
			);
			// Drain the burst capacity
			await assertResp(fetch(`${base}/`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);
			// Wait longer than the eviction threshold (2s) while continuing to
			// poll. Pre-fix the cleanup pass would delete the entry → next
			// request reinitialises a full-capacity bucket. Post-fix, polling
			// keeps lastAccess fresh, so the entry survives and the limit holds.
			const deadline = Date.now() + 2_500;
			while (Date.now() < deadline) {
				const r = await fetch(`${base}/`);
				await r.text(); // consume body to prevent leak
				await sleep(50);
			}
			// The bucket should NOT have refilled to full capacity. With
			// refill=1/s and ~3.5s elapsed during the test we'd have at most a
			// few tokens; the burst of 2 is what we're guarding against.
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);
		},
	},
	{
		name: "rate limit works",
		fn: async ({ app, base }) => {
			app.get(
				"/",
				rateLimit(
					// for testing simplicity: query "id" will be the clientId
					(req: Request) => new URL(req.url).searchParams.get("id") ?? "foo",
					{
						maxSize: 2,
						refillSizePerSecond: 1,
						getConsumeSize: (req) => {
							// simulate that "type=login" is more expensive
							if (new URL(req.url).searchParams.get("type") === "login") {
								return 2;
							}
							return 1;
						},
					},
				),
				() => "",
			);

			// normaly, 2 per sec are allowed
			await assertResp(fetch(`${base}/`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);

			// but only 1 expensive
			await assertResp(fetch(`${base}/?id=x&type=login`), HTTP_STATUS.OK);
			await assertResp(
				fetch(`${base}/?id=x&type=login`),
				HTTP_STATUS.TOO_MANY_REQUESTS,
			);

			// refill resolution is in seconds... so sleep one
			await sleep(1_001);

			// now only 1 is available (the max burst 2 were already consumed)
			await assertResp(fetch(`${base}/`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);

			// this must still NOT be allowed (we would need to wait another second)
			await assertResp(
				fetch(`${base}/?id=x&type=login`),
				HTTP_STATUS.TOO_MANY_REQUESTS,
			);

			// but different clients must be allowed
			await assertResp(fetch(`${base}/?id=bar`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/?id=baz`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/?id=hey`), HTTP_STATUS.OK);
			await assertResp(fetch(`${base}/?id=ho`), HTTP_STATUS.OK);
		},
	},
]);
