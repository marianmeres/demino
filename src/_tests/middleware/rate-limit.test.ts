import { HTTP_STATUS } from "@marianmeres/http-utils";
import { rateLimit, sleep } from "../../mod.ts";
import { assertResp, runTestServerTests } from "../_utils.ts";

runTestServerTests([
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
