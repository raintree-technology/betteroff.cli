import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLock, startCallback } from "../system";

describe("startCallback", () => {
	test("listens on 127.0.0.1 and hands back the first callback query", async () => {
		const server = await startCallback();

		try {
			expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

			const missing = await fetch(server.redirectUri.replace("/callback", "/other"));

			expect(missing.status).toBe(404);

			const page = await fetch(`${server.redirectUri}?code=abc&state=xyz`);

			expect(page.status).toBe(200);
			expect(page.headers.get("referrer-policy")).toBe("no-referrer");
			expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
			expect(await page.text()).not.toContain("abc");

			await fetch(`${server.redirectUri}?code=second&state=xyz`);

			const params = await server.result;

			expect(params.get("code")).toBe("abc");
		} finally {
			server.close();
		}
	});
});

describe("fileLock", () => {
	test("runs one action at a time and removes the lock file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "betteroff-lock-"));
		const path = join(directory, "token.lock");
		const withLock = fileLock(directory, path);
		const order: string[] = [];

		try {
			await Promise.all([
				withLock(async () => {
					order.push("a-start");
					await Bun.sleep(150);
					order.push("a-end");
				}),
				withLock(async () => {
					order.push("b-start");
					order.push("b-end");
				}),
			]);

			// Either may go first, but neither starts while the other holds the lock.
			expect([
				["a-start", "a-end", "b-start", "b-end"],
				["b-start", "b-end", "a-start", "a-end"],
			]).toContainEqual(order);
			expect(await stat(path).catch(() => null)).toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("takes over a lock left behind by a process that died", async () => {
		const directory = await mkdtemp(join(tmpdir(), "betteroff-lock-"));
		const path = join(directory, "token.lock");
		const old = new Date(Date.now() - 60_000);

		try {
			await writeFile(path, "");
			await utimes(path, old, old);

			expect(await fileLock(directory, path)(async () => "ran")).toBe("ran");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
