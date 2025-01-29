// deno-lint-ignore-file no-explicit-any

import { HTTP_STATUS } from "@marianmeres/http-utils";
import { rateLimit, sleep } from "../../mod.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
	{
		name: "rate limit works",
		fn: async ({ app, base }) => {
			app.get(
				"/",
				rateLimit(() => Promise.resolve("id"), {
					maxSize: 2,
					refillSizePerSecond: 1,
				})
			);

			await assertResp(fetch(`${base}/`), 204);
			await assertResp(fetch(`${base}/`), 204);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);

			// refill resolution is in seconds... so sleep one
			await sleep(1_001);

			// now only 1 is available (the max 2 were consumed)
			await assertResp(fetch(`${base}/`), 204);
			await assertResp(fetch(`${base}/`), HTTP_STATUS.TOO_MANY_REQUESTS);
		},
	},
]);
