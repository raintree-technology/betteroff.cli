import { mkdir, open, stat, unlink } from "node:fs/promises";
import * as z from "zod";
import type { CallbackServer } from "./cli";

const DONE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>BetterOff CLI</title>
<style>body{font:16px system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1rem;color:#111;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head>
<body><h1>You can close this tab</h1><p>Return to your terminal to finish signing in to the BetterOff CLI.</p></body>
</html>`;

/**
 * A one-shot server on 127.0.0.1 for the browser's redirect. It answers only `GET /callback`, keeps
 * the first query it sees, and sends a page with no scripts, no referrer, and no caching.
 */
export async function startCallback(): Promise<CallbackServer> {
	let deliver: (params: URLSearchParams) => void = () => {};
	const result = new Promise<URLSearchParams>((resolve) => {
		deliver = resolve;
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);

			if (request.method !== "GET" || url.pathname !== "/callback")
				return new Response("Not found", { status: 404 });

			deliver(url.searchParams);

			return new Response(DONE_PAGE, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
				},
			});
		},
	});

	return {
		redirectUri: `http://127.0.0.1:${server.port}/callback`,
		result,
		close: () => {
			void server.stop(true);
		},
	};
}

/** Opens the URL with the platform's own opener, passing it as an argument, never through a shell. */
export async function openBrowser(url: string): Promise<boolean> {
	const command =
		process.platform === "darwin"
			? ["/usr/bin/open", url]
			: process.platform === "win32"
				? ["rundll32", "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];

	try {
		const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

const exists = z.object({ code: z.literal("EEXIST") });

/** A lock left by a process that died is taken over after this long. */
const STALE_LOCK_MS = 30_000;

const WAIT_MS = 15_000;

/** A lock file created with O_EXCL, so only one CLI process renews the sign-in at a time. */
export function fileLock(directory: string, path: string) {
	return async <T>(action: () => Promise<T>): Promise<T> => {
		await mkdir(directory, { recursive: true, mode: 0o700 });

		const deadline = Date.now() + WAIT_MS;
		let handle: Awaited<ReturnType<typeof open>> | undefined;

		while (!handle) {
			try {
				handle = await open(path, "wx", 0o600);
			} catch (error) {
				if (!exists.safeParse(error).success) throw error;

				const lock = await stat(path).catch(() => null);

				if (lock && Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
					await unlink(path).catch(() => {});
					continue;
				}

				if (Date.now() > deadline)
					throw new Error("Another betteroff command is renewing the sign-in. Try again.");

				await Bun.sleep(100);
			}
		}

		try {
			return await action();
		} finally {
			await handle.close();
			await unlink(path).catch(() => {});
		}
	};
}
