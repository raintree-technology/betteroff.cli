import { describe, expect, test } from "bun:test";
import { run } from "../cli";
import { decodeCredential, encodeSession, type OAuthSession } from "../credentials";
import { CLIENT_ID, codeChallenge, discover, pastedRedirect, SCOPES } from "../oauth";
import { fakeDeps, fixtureSpec } from "./fixtures";

const API = "https://api.betteroff.finance";
const ISSUER = "https://app.betteroff.finance/api/auth";
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const REVOKE_ENDPOINT = `${ISSUER}/oauth2/revoke`;
const accounts = [{ id: "a", displayName: "Checking", balance: "10", currency: "USD" }];

type Callback = { code?: string; state?: string; iss?: string; error?: string };

/** A fake BetterOff API and auth server that rotate refresh tokens like the real one. */
function authServer(options: { serverMetadata?: Record<string, string> } = {}) {
	const world = {
		accessToken: "at-1",
		refreshToken: "rt-1",
		issued: 1,
		challenge: "",
		authorizeUrl: new URL("https://invalid"),
		tokenForms: [] as URLSearchParams[],
		revoked: [] as string[],
		toolTokens: [] as string[],
		rejectNextToolCall: false,
	};

	const respond = (url: string, init: RequestInit | undefined): Response => {
		if (url === `${API}/.well-known/oauth-protected-resource/mcp`)
			return Response.json({ resource: `${API}/mcp`, authorization_servers: [ISSUER] });

		if (url === `${ISSUER}/.well-known/openid-configuration`)
			return Response.json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/oauth2/authorize`,
				token_endpoint: TOKEN_ENDPOINT,
				revocation_endpoint: REVOKE_ENDPOINT,
				code_challenge_methods_supported: ["S256"],
				...options.serverMetadata,
			});

		if (url === `${API}/openapi/tools.json`) return Response.json(fixtureSpec);

		if (url === TOKEN_ENDPOINT) {
			const form = new URLSearchParams(String(init?.body));

			world.tokenForms.push(form);

			const valid =
				form.get("grant_type") === "authorization_code"
					? form.get("code") === "code-1"
					: form.get("refresh_token") === world.refreshToken;

			if (!valid) return Response.json({ error: "invalid_grant" }, { status: 400 });

			world.issued++;
			world.accessToken = `at-${world.issued}`;
			world.refreshToken = `rt-${world.issued}`;

			return Response.json({
				access_token: world.accessToken,
				token_type: "Bearer",
				expires_in: 600,
				refresh_token: world.refreshToken,
			});
		}

		if (url === REVOKE_ENDPOINT) {
			world.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");

			return new Response(null, { status: 200 });
		}

		if (url.startsWith(`${API}/v1/tools/`)) {
			const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";

			world.toolTokens.push(token);

			if (world.rejectNextToolCall) {
				world.rejectNextToolCall = false;

				return Response.json({ message: "expired" }, { status: 401 });
			}

			return token === world.accessToken
				? Response.json(accounts)
				: Response.json({ message: "bad token" }, { status: 401 });
		}

		return new Response("not found", { status: 404 });
	};

	return { world, respond };
}

/** Wires the fake browser: opening the sign-in URL "returns" to the CLI with `callback`. */
function signIn(callback: (url: URL) => Callback) {
	const server = authServer();
	const harness = fakeDeps(server.respond);
	let deliver: (params: URLSearchParams) => void = () => {};

	harness.deps.startCallback = async () => ({
		redirectUri: "http://127.0.0.1:5555/callback",
		result: new Promise((resolve) => {
			deliver = resolve;
		}),
		close: () => {},
	});
	harness.deps.openBrowser = async (url) => {
		const parsed = new URL(url);

		server.world.authorizeUrl = parsed;
		server.world.challenge = parsed.searchParams.get("code_challenge") ?? "";

		const params = new URLSearchParams();

		for (const [key, value] of Object.entries(callback(parsed))) params.set(key, value);

		deliver(params);

		return true;
	};

	return { ...server, harness };
}

function storedSession(store: string | null): OAuthSession {
	const credential = store ? decodeCredential(store) : null;

	if (credential?.kind !== "oauth") throw new Error("no browser sign-in saved");

	return credential.session;
}

describe("browser sign-in", () => {
	test("signs in with PKCE and the client metadata document, then uses the access token", async () => {
		const { world, harness } = signIn((url) => ({
			code: "code-1",
			state: url.searchParams.get("state") ?? "",
			iss: ISSUER,
		}));

		expect(await run(["login"], harness.deps)).toBe(0);

		const query = world.authorizeUrl.searchParams;

		expect(world.authorizeUrl.origin + world.authorizeUrl.pathname).toBe(`${ISSUER}/oauth2/authorize`);
		expect(query.get("client_id")).toBe(CLIENT_ID);
		expect(query.get("response_type")).toBe("code");
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("redirect_uri")).toBe("http://127.0.0.1:5555/callback");
		expect(query.get("resource")).toBe(`${API}/mcp`);
		expect(query.get("scope")?.split(" ")).toEqual(SCOPES);
		expect(SCOPES.every((scope) => scope.endsWith(":read") || scope === "offline_access")).toBe(true);

		const exchange = world.tokenForms[0];

		expect(exchange?.get("grant_type")).toBe("authorization_code");
		expect(exchange?.get("client_id")).toBe(CLIENT_ID);
		expect(exchange?.get("resource")).toBe(`${API}/mcp`);
		expect(await codeChallenge(exchange?.get("code_verifier") ?? "")).toBe(world.challenge);

		const session = storedSession(await harness.deps.tokens.get());

		expect(session.accessToken).toBe("at-2");
		expect(session.refreshToken).toBe("rt-2");
		expect(session.tokenEndpoint).toBe(TOKEN_ENDPOINT);

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(world.toolTokens).toEqual(["at-2"]);
		expect(harness.stderr()).toContain("Signed in.");
	});

	test.each([
		[{ code: "code-1", state: "forged" }, "did not match this request"],
		[{ code: "code-1", iss: "https://evil.example" }, "different server"],
		[{ error: "access_denied" }, "Sign-in was cancelled."],
	])("rejects the redirect %p and saves nothing", async (callback, message) => {
		const { world, harness } = signIn((url) => ({
			state: url.searchParams.get("state") ?? "",
			...callback,
		}));

		expect(await run(["login"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain(message);
		expect(world.tokenForms).toEqual([]);
		expect(await harness.deps.tokens.get()).toBeNull();
	});

	test("over SSH, prints the link instead of opening a browser and accepts the pasted address", async () => {
		const server = authServer();
		const harness = fakeDeps(server.respond, { env: { SSH_CONNECTION: "100.94.94.108 51234 100.1.1.1 22" } });
		const opened: string[] = [];
		let pastes = 0;

		harness.deps.startCallback = async () => ({
			redirectUri: "http://127.0.0.1:5555/callback",
			result: new Promise(() => {}),
			close: () => {},
		});
		harness.deps.openBrowser = async (url) => {
			opened.push(url);

			return true;
		};
		harness.deps.readLine = async () => {
			const link = /https:\/\/\S+\/oauth2\/authorize\S+/.exec(harness.stderr())?.[0] ?? "";
			const state = new URL(link).searchParams.get("state") ?? "";

			server.world.challenge = new URL(link).searchParams.get("code_challenge") ?? "";
			pastes++;

			// First a paste from the wrong port, then the real address with stray spaces.
			return pastes === 1
				? "http://127.0.0.1:9999/callback?code=x"
				: `  http://127.0.0.1:5555/callback?code=code-1&state=${state}&iss=${encodeURIComponent(ISSUER)}  `;
		};

		expect(await run(["login"], harness.deps)).toBe(0);
		expect(opened).toEqual([]);
		expect(harness.stderr()).toContain("You are connected over SSH");
		expect(harness.stderr()).toContain("That is not the address BetterOff sent you to.");
		expect(await codeChallenge(server.world.tokenForms[0]?.get("code_verifier") ?? "")).toBe(
			server.world.challenge,
		);
		expect(storedSession(await harness.deps.tokens.get()).refreshToken).toBe("rt-2");
	});

	test("gives up when the browser never comes back", async () => {
		const { harness } = signIn(() => ({}));

		harness.deps.openBrowser = async () => false;
		harness.deps.signInTimeoutMs = 20;

		expect(await run(["login"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("Sign-in timed out");
	});
});

/** A harness already signed in with an access token that expires at `expiresAt`. */
async function signedIn(expiresAt: number) {
	const server = authServer();
	const harness = fakeDeps(server.respond);

	await harness.deps.tokens.set(
		encodeSession({
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresAt,
			tokenEndpoint: TOKEN_ENDPOINT,
			revocationEndpoint: REVOKE_ENDPOINT,
			resource: `${API}/mcp`,
			clientId: CLIENT_ID,
		}),
	);

	return { ...server, harness };
}

describe("signed-in requests", () => {
	test("renews an expired access token and saves the rotated refresh token", async () => {
		const { world, harness } = await signedIn(0);

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(world.tokenForms.map((form) => form.get("refresh_token"))).toEqual(["rt-1"]);
		expect(world.tokenForms[0]?.get("client_id")).toBe(CLIENT_ID);
		expect(world.toolTokens).toEqual(["at-2"]);
		expect(storedSession(await harness.deps.tokens.get()).refreshToken).toBe("rt-2");
	});

	test("uses a fresh access token without renewing it", async () => {
		const { world, harness } = await signedIn(10_000_000);

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(world.tokenForms).toEqual([]);
		expect(world.toolTokens).toEqual(["at-1"]);
	});

	test("renews once and retries when the API rejects the access token", async () => {
		const { world, harness } = await signedIn(10_000_000);

		world.rejectNextToolCall = true;

		expect(await run(["accounts"], harness.deps)).toBe(0);
		expect(world.toolTokens).toEqual(["at-1", "at-2"]);
	});

	test("asks the user to sign in again when the refresh token is refused", async () => {
		const { world, harness } = await signedIn(0);

		world.refreshToken = "rt-revoked";

		expect(await run(["accounts"], harness.deps)).toBe(1);
		expect(harness.stderr()).toContain("Run: betteroff login");
		expect(world.toolTokens).toEqual([]);
	});

	test("renews only once when two commands run at the same time", async () => {
		const { world, harness } = await signedIn(0);
		let queue = Promise.resolve();

		harness.deps.withLock = (action) => {
			const turn = queue.then(action);

			queue = turn.then(
				() => {},
				() => {},
			);

			return turn;
		};

		const results = await Promise.all([run(["accounts"], harness.deps), run(["accounts"], harness.deps)]);

		expect(results).toEqual([0, 0]);
		expect(world.tokenForms).toHaveLength(1);
		expect(world.toolTokens).toEqual(["at-2", "at-2"]);
	});

	test("logout revokes the sign-in at BetterOff and forgets it", async () => {
		const { world, harness } = await signedIn(10_000_000);

		expect(await run(["logout"], harness.deps)).toBe(0);
		expect(world.revoked).toEqual(["rt-1"]);
		expect(await harness.deps.tokens.get()).toBeNull();
	});

	test("status says it is a browser sign-in and never prints the token", async () => {
		const { harness } = await signedIn(10_000_000);

		expect(await run(["status"], harness.deps)).toBe(0);
		expect(harness.stdout()).toContain("browser sign-in");
		expect(harness.stdout()).not.toContain("at-1");
	});
});

describe("pastedRedirect", () => {
	test("accepts only this CLI's own redirect address", () => {
		const redirect = "http://127.0.0.1:5555/callback";

		expect(pastedRedirect(` ${redirect}?code=a&state=b `, redirect)?.get("code")).toBe("a");
		expect(pastedRedirect("http://127.0.0.1:6666/callback?code=a", redirect)).toBeNull();
		expect(pastedRedirect("http://127.0.0.1:5555/other?code=a", redirect)).toBeNull();
		expect(pastedRedirect("https://evil.example/callback?code=a", redirect)).toBeNull();
		expect(pastedRedirect("not a url", redirect)).toBeNull();
	});
});

describe("discover", () => {
	test.each([
		[{ token_endpoint: "https://evil.example/token" }, "token endpoint"],
		[{ authorization_endpoint: "http://app.betteroff.finance/api/auth/authorize" }, "authorization endpoint"],
		[{ issuer: "https://evil.example" }, "does not match"],
	])("rejects sign-in server metadata %p", async (metadata, message) => {
		const { respond } = authServer({ serverMetadata: metadata });

		await expect(discover(async (url, init) => respond(url, init), API)).rejects.toThrow(message);
	});
});

describe("encodeSession", () => {
	test("keeps the saved value short enough for the keychain command", () => {
		const session: OAuthSession = {
			accessToken: "x".repeat(5000),
			refreshToken: "rt",
			expiresAt: 1,
			tokenEndpoint: TOKEN_ENDPOINT,
			revocationEndpoint: undefined,
			resource: `${API}/mcp`,
			clientId: CLIENT_ID,
		};
		const stored = encodeSession(session);

		expect(stored.length).toBeLessThan(3500);
		expect(stored).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeCredential(stored)).toEqual({
			kind: "oauth",
			session: { ...session, accessToken: undefined },
		});
	});
});
