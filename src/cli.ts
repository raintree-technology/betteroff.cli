import * as z from "zod";
import { parseToolArgs, UsageError } from "./args";
import {
	accessToken,
	decodeCredential,
	encodeSession,
	type SessionStore,
	sessionFromTokens,
} from "./credentials";
import type { JsonValue } from "./json";
import {
	authorizationCode,
	authorizationUrl,
	codeChallenge,
	discover,
	exchangeCode,
	OAuthError,
	pastedRedirect,
	randomToken,
	revokeToken,
	SignInExpiredError,
} from "./oauth";
import { ansiStyle, plainStyle, renderPretty, type Style } from "./render";
import { findTool, type Tool, toolsFromSpec, toolsSpecSchema } from "./spec";
import { safeJson, safeText } from "./text";

export const VERSION = "0.1.2";

const DEFAULT_API_URL = "https://api.betteroff.finance";

const TOKEN_SETTINGS_URL = "https://app.betteroff.finance/settings/api-tokens";

const TOKEN_PATTERN = /^bo_pat_[A-Za-z0-9_-]{43}$/;

/** Matches the token prefix BetterOff shows in Settings > API tokens. */
const DISPLAY_PREFIX_LENGTH = 11;

const SPEC_MAX_AGE_MS = 60 * 60 * 1000;

export type TokenStore = {
	get: () => Promise<string | null>;
	set: (token: string) => Promise<void>;
	delete: () => Promise<boolean>;
};

export type SpecCache = {
	read: () => Promise<string | null>;
	write: (text: string) => Promise<void>;
};

export type CliDeps = {
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	stdoutIsTTY: boolean;
	columns: number;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	tokens: TokenStore;
	specCache: SpecCache;
	readSecret: (prompt: string) => Promise<string>;
	now: () => number;
	/** How long a keychain call may take before the CLI gives up on it. */
	keychainTimeoutMs: number;
	/** Listens on a loopback port for the browser's redirect after sign-in. */
	startCallback: () => Promise<CallbackServer>;
	/** Reads a line typed or pasted into the terminal; null when there is no terminal or it was aborted. */
	readLine: (prompt: string, signal: AbortSignal) => Promise<string | null>;
	/** Opens a URL in the user's browser; false when it could not. */
	openBrowser: (url: string) => Promise<boolean>;
	/** Runs `action` while no other CLI process holds the token lock. */
	withLock: <T>(action: () => Promise<T>) => Promise<T>;
	/** How long to wait for the user to finish signing in. */
	signInTimeoutMs: number;
};

export type CallbackServer = {
	redirectUri: string;
	/** The query of the first request to the callback path. */
	result: Promise<URLSearchParams>;
	close: () => void;
};

const cachedSpecSchema = z.object({
	apiUrl: z.string(),
	fetchedAt: z.number(),
	spec: toolsSpecSchema,
});

const errorBodySchema = z.looseObject({
	ok: z.boolean().optional(),
	error: z.string().optional(),
	nextStep: z.string().optional(),
	code: z.string().optional(),
	message: z.string().optional(),
	detail: z.string().optional(),
	title: z.string().optional(),
});

class ApiError extends Error {}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Printable ASCII only: anything else in a token is a paste error or an attempt to inject a header. */
const TOKEN_TEXT = /^[\x21-\x7e]+$/;

/**
 * The API origin. The token goes to this host, so it must be HTTPS (plain HTTP only on this
 * machine, for local development) and a bare origin with no credentials, path, or query.
 */
function apiUrl(deps: CliDeps): string {
	const raw = deps.env.BETTEROFF_API_URL ?? DEFAULT_API_URL;
	let url: URL;

	try {
		url = new URL(raw);
	} catch {
		throw new UsageError("BETTEROFF_API_URL is not a valid URL.");
	}

	const secure =
		url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

	if (!secure)
		throw new UsageError("BETTEROFF_API_URL must use https:// (http:// only for localhost).");

	if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
		throw new UsageError(
			"BETTEROFF_API_URL must be an origin only, such as https://api.betteroff.finance",
		);

	if (url.hostname !== "api.betteroff.finance" && !LOOPBACK_HOSTS.has(url.hostname))
		throw new UsageError("BETTEROFF_API_URL must point to BetterOff or localhost.");

	return url.origin;
}

async function loadTools(deps: CliDeps): Promise<{ version: string; tools: Tool[] }> {
	const base = apiUrl(deps);
	const cachedText = await deps.specCache.read().catch(() => null);
	let cached: z.infer<typeof cachedSpecSchema> | undefined;

	try {
		cached = cachedText ? cachedSpecSchema.parse(JSON.parse(cachedText)) : undefined;
	} catch {
		cached = undefined;
	}

	if (cached && cached.apiUrl === base && deps.now() - cached.fetchedAt < SPEC_MAX_AGE_MS)
		return { version: cached.spec.info.version, tools: toolsFromSpec(cached.spec) };

	try {
		const response = await deps.fetch(`${base}/openapi/tools.json`, {
			headers: { accept: "application/json", "user-agent": `betteroff-cli/${VERSION}` },
			redirect: "error",
		});

		if (!response.ok) throw new ApiError(`HTTP ${response.status}`);
		const spec = toolsSpecSchema.parse(await response.json());

		// The cache is optional; a read-only home directory must not block a valid response.
		await deps.specCache
			.write(JSON.stringify({ apiUrl: base, fetchedAt: deps.now(), spec }))
			.catch(() => {});

		return { version: spec.info.version, tools: toolsFromSpec(spec) };
	} catch (error) {
		// A stale command list beats none when the API is briefly unreachable.
		if (cached?.apiUrl === base)
			return { version: cached.spec.info.version, tools: toolsFromSpec(cached.spec) };
		throw new ApiError(
			`Could not load the BetterOff tool list from ${base}/openapi/tools.json (${error instanceof Error ? error.message : "unknown error"}).`,
		);
	}
}

/** A locked keychain (common over SSH) throws instead of prompting; say how to get past it. */
async function keychain<T>(deps: CliDeps, action: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`no answer after ${deps.keychainTimeoutMs / 1000} seconds`)),
			deps.keychainTimeoutMs,
		);
	});

	try {
		return await Promise.race([action(), timeout]);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";

		throw new ApiError(
			`The system keychain refused the request (${reason}). Unlock it and try again, or set BETTEROFF_API_TOKEN in this shell instead.`,
		);
	} finally {
		clearTimeout(timer);
	}
}

function sessionStore(deps: CliDeps): SessionStore {
	return {
		read: () => keychain(deps, () => deps.tokens.get()),
		write: (value) => keychain(deps, () => deps.tokens.set(value)),
		withLock: deps.withLock,
		fetch: deps.fetch,
		now: deps.now,
	};
}

type Credential = {
	token: string;
	source: string;
	renew: (() => Promise<string | null>) | undefined;
};

async function resolveToken(deps: CliDeps): Promise<Credential | null> {
	const fromEnv = deps.env.BETTEROFF_API_TOKEN?.trim();

	if (fromEnv && !TOKEN_TEXT.test(fromEnv))
		throw new UsageError("BETTEROFF_API_TOKEN has spaces or unprintable characters.");

	if (fromEnv) return { token: fromEnv, source: "BETTEROFF_API_TOKEN", renew: undefined };

	const stored = await keychain(deps, () => deps.tokens.get());
	const credential = stored ? decodeCredential(stored) : null;

	if (!credential) return null;

	if (credential.kind === "token")
		return { token: credential.token, source: "system keychain", renew: undefined };

	const store = sessionStore(deps);
	const token = await accessToken(store, false);

	if (!token) throw new SignInExpiredError("Your BetterOff sign-in has expired.");

	return { token, source: "browser sign-in", renew: () => accessToken(store, true) };
}

function errorMessage(status: number, body: JsonValue, retryAfter: string | null): string {
	const parsed = errorBodySchema.safeParse(body).data;
	const text =
		parsed?.error ?? parsed?.detail ?? parsed?.message ?? parsed?.title ?? `HTTP ${status}`;
	const code = parsed?.code ? ` (${parsed.code})` : "";

	if (status === 401) return `Not signed in or the token was revoked. Run: betteroff login`;

	if (status === 429) {
		const seconds = /^\d{1,5}$/.test(retryAfter ?? "") ? retryAfter : "a few";

		return `Rate limited. Try again in ${seconds} seconds.`;
	}

	return safeText(`${text}${code}${parsed?.nextStep ? `\n${parsed.nextStep}` : ""}`);
}

async function callTool(deps: CliDeps, token: string, tool: Tool, args: JsonValue) {
	// A redirect would resend the token to wherever it points, so any redirect is an error.
	const response = await deps.fetch(`${apiUrl(deps)}/v1/tools/${encodeURIComponent(tool.name)}`, {
		method: "POST",
		redirect: "error",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
			"user-agent": `betteroff-cli/${VERSION}`,
		},
		body: JSON.stringify(args),
	});

	const text = await response.text();
	let body: JsonValue = null;

	try {
		body = z.json().parse(JSON.parse(text));
	} catch {
		body = null;
	}

	if (response.ok && body === null)
		throw new ApiError("The API returned an invalid tool result. Try again later.");

	return {
		status: response.status,
		ok: response.ok && errorBodySchema.safeParse(body).data?.ok !== false,
		body,
		retryAfter: response.headers.get("retry-after"),
	};
}

function usage(tools: Tool[], style: Style): string {
	const width = Math.max(...tools.map((tool) => tool.command.length));

	const lines = [
		`${style.bold("betteroff")} ${VERSION}  Read your BetterOff household from the terminal.`,
		"",
		style.bold("Usage"),
		"  betteroff <command> [flags]",
		"  betteroff <command> --help",
		"",
		style.bold("Commands"),
		...tools.map((tool) => `  ${tool.command.padEnd(width)}  ${tool.summary}`),
		"",
		style.bold("Account"),
		`  ${"login".padEnd(width)}  Sign in with your browser (--token to paste an API token)`,
		`  ${"logout".padEnd(width)}  Sign out and end the sign-in at BetterOff`,
		`  ${"status".padEnd(width)}  Show which token and API this CLI uses`,
		"",
		style.bold("Flags"),
		"  --json     Print the raw JSON result (the default when output is piped)",
		"  --help     Show help for a command",
		"  --version  Show the CLI version",
		"",
		style.dim("Read-only: this CLI cannot move money, change records, or approve anything."),
	];

	return `${lines.join("\n")}\n`;
}

function wrap(text: string, width: number, indent: string): string[] {
	const lines: string[] = [];
	let line = "";

	for (const word of text.split(/\s+/)) {
		if (!word) continue;

		if (line && indent.length + line.length + 1 + word.length > width) {
			lines.push(indent + line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}

	if (line) lines.push(indent + line);

	return lines;
}

/** Tool descriptions are written for agents, which pass null; a CLI user leaves the flag out. */
function forPeople(text: string): string {
	return text.replace(/\bUse null (?:for|to)\b/g, "Leave out for");
}

const INLINE_CHOICES = 5;

function flagValue(flag: Tool["flags"][number]): string {
	if (flag.kind === "boolean") return "";

	if (flag.choices.length > 0 && flag.choices.length <= INLINE_CHOICES)
		return ` <${flag.choices.join("|")}>`;

	if (flag.kind === "list") return " <a,b>";

	return ` <${flag.kind === "string" ? "text" : flag.kind}>`;
}

function toolUsage(tool: Tool, width: number, style: Style): string {
	const lines = [`${style.bold(`betteroff ${tool.command}`)}  ${tool.summary}`, ""];

	lines.push(...wrap(forPeople(tool.description), width, ""));

	if (tool.flags.length > 0) {
		lines.push("", style.bold("Flags"));

		for (const flag of tool.flags) {
			const required = flag.required ? `  ${style.bold("(required)")}` : "";

			const fallback =
				flag.cliDefault === undefined
					? ""
					: style.dim(`  (default: ${JSON.stringify(flag.cliDefault)})`);

			lines.push(`  --${flag.flag}${flagValue(flag)}${required}${fallback}`);

			for (const line of wrap(forPeople(flag.description), width, "      "))
				lines.push(style.dim(line));

			if (flag.choices.length > INLINE_CHOICES)
				for (const line of wrap(`One of: ${flag.choices.join(", ")}`, width, "      "))
					lines.push(style.dim(line));
		}
	}

	if (tool.aliases.length > 0)
		lines.push("", style.dim(`Also: betteroff ${tool.aliases.join(", ")}`));

	return `${lines.join("\n")}\n`;
}

async function tokenLogin(deps: CliDeps): Promise<number> {
	deps.stderr(
		[
			`Create a personal API token at ${TOKEN_SETTINGS_URL}`,
			"Give it read scopes only. This CLI never uses prepare, transfer, or feedback scopes.",
			"",
		].join("\n"),
	);

	const token = (await deps.readSecret("Paste token: ")).trim();

	if (!TOKEN_PATTERN.test(token)) {
		deps.stderr("That does not look like a BetterOff token (bo_pat_…). Nothing was saved.\n");

		return 2;
	}

	const check = await callTool(
		deps,
		token,
		{
			name: "betteroff_get_setup_status",
			command: "setup-status",
			aliases: [],
			summary: "",
			description: "",
			flags: [],
		},
		{},
	);

	if (check.status === 401) {
		deps.stderr("BetterOff rejected that token. Nothing was saved.\n");

		return 1;
	}

	await keychain(deps, () => deps.tokens.set(token));
	deps.stderr(`Saved ${token.slice(0, DISPLAY_PREFIX_LENGTH)}… to the system keychain.\n`);

	if (!check.ok) deps.stderr(`Note: ${errorMessage(check.status, check.body, check.retryAfter)}\n`);

	return 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new OAuthError(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

const NEVER = new Promise<never>(() => {});

/**
 * Waits for the browser's redirect to reach the loopback server, or for the user to paste the
 * address the browser was sent to, whichever comes first.
 */
async function waitForRedirect(deps: CliDeps, server: CallbackServer): Promise<URLSearchParams> {
	const controller = new AbortController();
	const pasted = (async (): Promise<URLSearchParams> => {
		while (!controller.signal.aborted) {
			const line = await deps.readLine("Paste the address here: ", controller.signal);

			if (line === null) return await NEVER;

			const params = pastedRedirect(line, server.redirectUri);

			if (params) return params;

			if (line.trim())
				deps.stderr(
					`That is not the address BetterOff sent you to. It starts with ${server.redirectUri}\n`,
				);
		}

		return await NEVER;
	})();

	try {
		return await withTimeout(
			Promise.race([server.result, pasted]),
			deps.signInTimeoutMs,
			"Sign-in timed out. Run: betteroff login",
		);
	} finally {
		controller.abort();
	}
}

/**
 * OAuth authorization code flow with PKCE on a loopback redirect (RFC 8252). The browser signs in
 * and shows the consent page; BetterOff redirects back to this machine with a one-time code, and
 * the CLI trades it for tokens. The CLI never sees the password, and the user can revoke the
 * connection in BetterOff's settings.
 */
async function browserLogin(deps: CliDeps): Promise<number> {
	const endpoints = await discover(deps.fetch, apiUrl(deps));
	const verifier = randomToken();
	const state = randomToken();
	const server = await deps.startCallback();

	try {
		const url = authorizationUrl(endpoints, {
			redirectUri: server.redirectUri,
			state,
			challenge: await codeChallenge(verifier),
		});

		// Over SSH the browser is on the user's own computer, not this one.
		const remote = Boolean(deps.env.SSH_CONNECTION || deps.env.SSH_TTY);

		deps.stderr(
			[
				remote
					? "You are connected over SSH. Open this link in a browser on your own computer:"
					: "Opening your browser to sign in to BetterOff. If it does not open, use this link:",
				"",
				`  ${url}`,
				"",
				remote
					? "After you approve, the browser shows a page that cannot connect. That is expected:"
					: "If the browser shows a page that cannot connect after you approve,",
				"copy the full address from its address bar and paste it here.",
				"",
			].join("\n"),
		);

		if (!remote) await deps.openBrowser(url);

		const params = await waitForRedirect(deps, server);
		const code = authorizationCode(params, { state, issuer: endpoints.issuer });
		const tokens = await exchangeCode(deps.fetch, endpoints, {
			code,
			verifier,
			redirectUri: server.redirectUri,
		});
		const session = sessionFromTokens(tokens, {
			tokenEndpoint: endpoints.tokenEndpoint,
			revocationEndpoint: endpoints.revocationEndpoint,
			resource: endpoints.resource,
			now: deps.now(),
		});

		await keychain(deps, () => deps.tokens.set(encodeSession(session)));
		deps.stderr(
			session.refreshToken
				? "Signed in. The CLI renews access on its own; the sign-in lasts up to 30 days.\n"
				: "Signed in for this session only; you did not allow offline access.\n",
		);

		return 0;
	} finally {
		server.close();
	}
}

async function login(deps: CliDeps, flags: string[]): Promise<number> {
	if (flags.includes("--token")) return await tokenLogin(deps);

	if (flags.length > 0) throw new UsageError("Usage: betteroff login [--token]");

	return await browserLogin(deps);
}

/** Revokes a browser sign-in at BetterOff before forgetting it, so the refresh token stops working. */
async function logout(deps: CliDeps): Promise<number> {
	const stored = await keychain(deps, () => deps.tokens.get());
	const credential = stored ? decodeCredential(stored) : null;

	if (credential?.kind === "oauth" && credential.session.refreshToken) {
		const { refreshToken, revocationEndpoint } = credential.session;
		const outcome = revocationEndpoint
			? await revokeToken(deps.fetch, { revocationEndpoint, refreshToken }).catch(
					(): "failed" => "failed",
				)
			: "failed";

		if (outcome === "revoked") deps.stderr("Ended the sign-in at BetterOff.\n");

		if (outcome === "already-ended") deps.stderr("The sign-in had already ended at BetterOff.\n");

		if (outcome === "failed")
			deps.stderr(
				"Could not end the sign-in at BetterOff. Remove it under Settings > Agent connections.\n",
			);
	}

	const removed = await keychain(deps, () => deps.tokens.delete());

	deps.stderr(removed ? "Signed out.\n" : "Not signed in.\n");

	return 0;
}

async function status(deps: CliDeps): Promise<number> {
	const resolved = await resolveToken(deps);

	const lines = [
		`API      ${apiUrl(deps)}`,
		!resolved
			? "Token    none. Run: betteroff login"
			: resolved.renew
				? "Token    browser sign-in, renewed automatically"
				: `Token    ${resolved.token.slice(0, DISPLAY_PREFIX_LENGTH)}… from ${resolved.source}`,
		`Version  ${VERSION}`,
	];

	deps.stdout(`${lines.join("\n")}\n`);

	return 0;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
	const style = deps.stdoutIsTTY && !deps.env.NO_COLOR ? ansiStyle : plainStyle;
	const json = argv.includes("--json");
	const help = argv.includes("--help") || argv.includes("-h");
	const rest = argv.filter((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h");
	const [command, ...flags] = rest;

	try {
		if (command === "--version" || command === "version") {
			deps.stdout(`${VERSION}\n`);

			return 0;
		}

		if (command === "login") return await login(deps, flags);

		if (command === "status") return await status(deps);

		if (command === "logout") return await logout(deps);

		const { tools } = await loadTools(deps);

		if (command === undefined || command === "help") {
			deps.stdout(usage(tools, style));

			return 0;
		}

		const tool = findTool(tools, command);

		if (!tool) throw new UsageError(`Unknown command "${command}". Run: betteroff --help`);

		if (help) {
			deps.stdout(toolUsage(tool, Math.min(deps.columns, 100), style));

			return 0;
		}

		const args = parseToolArgs(tool, flags);
		const resolved = await resolveToken(deps);

		if (!resolved) throw new ApiError("Not signed in. Run: betteroff login");

		let result = await callTool(deps, resolved.token, tool, args);

		// A browser sign-in's access token can be revoked or expire early; renew it once and retry.
		if (result.status === 401 && resolved.renew) {
			const renewed = await resolved.renew();

			if (renewed) result = await callTool(deps, renewed, tool, args);
		}

		if (!result.ok) throw new ApiError(errorMessage(result.status, result.body, result.retryAfter));

		if (json || !deps.stdoutIsTTY)
			deps.stdout(`${safeJson(JSON.stringify(result.body, null, 2))}\n`);
		else deps.stdout(renderPretty(result.body, deps.columns, style));

		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			deps.stderr(`${error.message}\n`);

			return 2;
		}

		if (error instanceof ApiError) {
			deps.stderr(`${error.message}\n`);

			return 1;
		}

		if (error instanceof SignInExpiredError) {
			deps.stderr(`${safeText(error.message)} Run: betteroff login\n`);

			return 1;
		}

		if (error instanceof OAuthError) {
			deps.stderr(`${safeText(error.message)}\n`);

			return 1;
		}

		throw error;
	}
}
