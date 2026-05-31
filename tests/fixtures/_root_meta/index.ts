import { withMeta } from "../../../src/demino.ts";

export const GET = withMeta({ permission: "home:read" }, () => "/meta-home");
