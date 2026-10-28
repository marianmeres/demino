/**
 * Flat entry for the Deno runtime adapter (`@marianmeres/demino/deno`).
 *
 * @module
 */

export { serve } from "./adapters/deno.ts";
export type { ServeFn, ServeHandle, ServeOptions } from "./adapters/types.ts";
