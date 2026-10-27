import { describe, expect, test } from "bun:test";
import * as z from "zod";
import { run } from "../cli";
import { api, fakeDeps, fixtureSpec, TOKEN } from "./fixtures";

const accounts = [{ id: "acc-1", displayName: "Checking", balance: "10", currency: "USD" }];

describe("run", () => {
	test("preserves tool error recovery instructions", async () => {
		const harness = fakeDeps(
			api(() =>
				Response.json(
					{
						ok: false,
						error: "Core access required.",
						code: "AGENT_SUBSCRIPTION_INACTIVE",
						nextStep: "Open BetterOff settings.",
						retryable: false,
					},
					{ status: 402 },
				),
			),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);
		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("Core access required.");
		expect(harness.stderr()).toContain("Open BetterOff settings.");
	});

	test.each([
		"not JSON",
		"null",
		'{"ok":false,"error":"Unavailable","code":"INCOMPLETE_DATA","nextStep":"Reconnect."}',
	])("rejects an unsuccessful tool result: %s", async (body) => {
		const harness = fakeDeps(
			api(() => new Response(body)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);
		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stdout()).toBe("");
	});

	test.each(["read", "write"] as const)(
		"a failed cache %s does not block commands",
		async (operation) => {
			const harness = fakeDeps(
				api(() => Response.json(accounts)),
				{ env: { BETTEROFF_API_TOKEN: TOKEN } },
			);
			harness.deps.specCache[operation] = async () => {
				throw new Error("Permission denied");
			};
			expect(await run(["accounts"], harness.deps)).toBe(0);
			expect(harness.stdout()).toContain("Checking");
		},
	);

	test("calls the tool with the token and prints JSON when piped", async () => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);

		expect(await run(["transactions", "--merchant", "Uber"], harness.deps)).toBe(0);

		const call = harness.requests.at(-1);
		const headers = new Headers(call?.init?.headers);

		expect(call?.url).toBe("https://api.betteroff.finance/v1/tools/betteroff_search_transactions");
		expect(call?.init?.method).toBe("POST");
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(z.json().parse(JSON.parse(String(call?.init?.body)))).toEqual({
			merchant: "Uber",
			limit: null,
			minAmount: null,
			traits: null,
			cursor: null,
		});
		expect(JSON.parse(harness.stdout())).toEqual(accounts);
	});

	test("prints a table on a terminal", async () => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN, NO_COLOR: "1" }, stdoutIsTTY: true },
		);

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(harness.stdout()).toContain("Checking      $10.00");
	});

	test("has no command for a write tool", async () => {
		const harness = fakeDeps(
			api(() => Response.json({})),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);

		expect(await run(["request-transfer", "--amount-usdc", "5"], harness.deps)).toBe(2);
		expect(harness.stderr()).toContain('Unknown command "request-transfer"');
		expect(harness.requests.some((request) => request.url.includes("/v1/tools/"))).toBe(false);
	});

	test("asks for login when there is no token, without calling the tool", async () => {
		const harness = fakeDeps(api(() => Response.json(accounts)));

		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("betteroff login");
		expect(harness.requests.some((request) => request.url.includes("/v1/tools/"))).toBe(false);
	});

	test("reports API errors by message and code", async () => {
		const harness = fakeDeps(
			api(() =>
				Response.json(
					{ code: "INSUFFICIENT_SCOPE", message: "Token lacks transactions:read." },
					{ status: 403 },
				),
			),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);

		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toBe("Token lacks transactions:read. (INSUFFICIENT_SCOPE)\n");
	});

	test("login validates the token with the API, then saves it", async () => {
		const harness = fakeDeps(api(() => Response.json({ steps: [] })));

		expect(await run(["login", "--token"], harness.deps)).toBe(0);
		expect(harness.storedToken()).toBe(TOKEN);
		expect(harness.stderr()).toContain("Saved bo_pat_aaaa…");
		expect(await run(["status"], harness.deps)).toBe(0);
		expect(harness.stdout()).toContain("from system keychain");
	});

	test("login saves nothing when the API rejects the token", async () => {
		const harness = fakeDeps(api(() => Response.json({}, { status: 401 })));

		expect(await run(["login", "--token"], harness.deps)).toBe(1);
		expect(harness.storedToken()).toBeNull();
	});

	test("login explains a locked keychain instead of crashing", async () => {
		const harness = fakeDeps(api(() => Response.json({ steps: [] })));

		const locked = async () => {
			throw new Error("User interaction is not allowed. (code: -25308)");
		};

		harness.deps.tokens = { get: locked, set: locked, delete: locked };

		expect(await run(["login", "--token"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("User interaction is not allowed");
		expect(harness.stderr()).toContain("BETTEROFF_API_TOKEN");
		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("Unlock it");
	});

	test("login refuses text that is not a token", async () => {
		const harness = fakeDeps(
			api(() => Response.json({})),
			{ readSecret: async () => "hunter2" },
		);

		expect(await run(["login", "--token"], harness.deps)).toBe(2);
		expect(harness.requests).toEqual([]);
	});

	test("reuses a fresh cached spec and falls back to a stale one when the API is down", async () => {
		let now = 1_000_000;
		let up = true;

		const harness = fakeDeps(
			(url) => {
				if (!up) throw new TypeError("fetch failed");

				return url.endsWith("/openapi/tools.json") ? Response.json(fixtureSpec) : Response.json({});
			},
			{ now: () => now },
		);

		expect(await run(["--help"], harness.deps)).toBe(0);
		expect(await run(["--help"], harness.deps)).toBe(0);
		expect(harness.requests).toHaveLength(1);

		now += 2 * 60 * 60 * 1000;
		up = false;
		expect(await run(["--help"], harness.deps)).toBe(0);
		expect(harness.stdout()).toContain("transactions");
	});

	test("explains when the tool list cannot be loaded at all", async () => {
		const harness = fakeDeps(() => new Response("down", { status: 503 }));

		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("Could not load the BetterOff tool list");
	});

	test.each([
		["http://api.betteroff.finance", "must use https://"],
		["https://api.betteroff.finance/v1", "origin only"],
		["https://user:pass@api.betteroff.finance", "origin only"],
		["not a url", "not a valid URL"],
		["https://example.com", "must point to BetterOff"],
		["https://api.betteroff.finance.example.com", "must point to BetterOff"],
	])("refuses BETTEROFF_API_URL=%p before sending anything", async (url, message) => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN, BETTEROFF_API_URL: url } },
		);

		expect(await run(["accounts"], harness.deps)).toBe(2);
		expect(harness.stderr()).toContain(message);
		expect(harness.requests).toEqual([]);
	});

	test("allows plain http only on this machine", async () => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN, BETTEROFF_API_URL: "http://localhost:8787/" } },
		);

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(harness.requests.at(-1)?.url).toBe(
			"http://localhost:8787/v1/tools/betteroff_list_accounts",
		);
	});

	test("never follows a redirect", async () => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);

		await run(["accounts"], harness.deps);

		expect(harness.requests.map((request) => request.init?.redirect)).toEqual(["error", "error"]);
	});

	test("refuses a token with spaces or control characters", async () => {
		const harness = fakeDeps(
			api(() => Response.json(accounts)),
			{ env: { BETTEROFF_API_TOKEN: `${TOKEN}\r\nx-evil: 1` } },
		);

		expect(await run(["accounts"], harness.deps)).toBe(2);
		expect(harness.requests.some((request) => request.url.includes("/v1/tools/"))).toBe(false);
	});

	test("gives up on a keychain that never answers", async () => {
		const harness = fakeDeps(api(() => Response.json(accounts)));
		const hang = () => new Promise<never>(() => {});

		harness.deps.tokens = { get: hang, set: hang, delete: hang };

		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("no answer after 0.05 seconds");
	});

	test("prints no terminal escapes from API text", async () => {
		const evil = [{ id: "a", displayName: "Shop\u001b]52;c;cGF5bG9hZA==\u0007", currency: "USD" }];
		const tty = fakeDeps(
			api(() => Response.json(evil)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN, NO_COLOR: "1" }, stdoutIsTTY: true },
		);
		const piped = fakeDeps(
			api(() => Response.json(evil)),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);
		const failing = fakeDeps(
			api(() =>
				Response.json({ message: "Denied\u001b[2J", code: "ACCESS_DENIED" }, { status: 403 }),
			),
			{ env: { BETTEROFF_API_TOKEN: TOKEN } },
		);

		await run(["accounts"], tty.deps);
		await run(["accounts"], piped.deps);
		await run(["accounts"], failing.deps);

		for (const output of [tty.stdout(), piped.stdout(), failing.stderr()]) {
			expect(output).not.toContain("\u001b");
			expect(output).not.toContain("\u0007");
		}
	});
});
