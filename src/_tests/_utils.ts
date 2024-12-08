export const TEST_PORT = 9876;

export async function startTestServer(
	handler: Deno.ServeHandler,
	port = TEST_PORT
) {
	const ac = new AbortController();
	// By default `Deno.serve` prints the message ... If you like to
	// change this behavior, you can specify a custom `onListen` callback.
	const server = await Deno.serve(
		{ port, signal: ac.signal, onListen(_) {} },
		handler
	);
	// server.finished.then(() => console.log("Server closed"));
	return { port, ac, server, base: `http://localhost:${port}` };
}
