import type { JsonValue } from "./json";
import * as z from "zod";
import { parseToolArgs, UsageError } from "./args";
import { ansiStyle, plainStyle, renderPretty, type Style } from "./render";
import { findTool, type Tool, toolsFromSpec, toolsSpecSchema } from "./spec";

export const VERSION = "0.1.0";

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
};

const cachedSpecSchema = z.object({
	apiUrl: z.string(),
	fetchedAt: z.number(),
	spec: toolsSpecSchema,
});

const errorBodySchema = z.looseObject({
	code: z.string().optional(),
	message: z.string().optional(),
	detail: z.string().optional(),
	title: z.string().optional(),
});

class ApiError extends Error {}

function apiUrl(deps: CliDeps): string {
	return (deps.env.BETTEROFF_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
}

async function loadTools(deps: CliDeps): Promise<{ version: string; tools: Tool[] }> {
	const base = apiUrl(deps);
	const cachedText = await deps.specCache.read();
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
		});

		if (!response.ok) throw new ApiError(`HTTP ${response.status}`);
		const spec = toolsSpecSchema.parse(await response.json());

		await deps.specCache.write(JSON.stringify({ apiUrl: base, fetchedAt: deps.now(), spec }));

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
async function keychain<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown error";

		throw new ApiError(
			`The system keychain refused the request (${reason}). Unlock it and try again, or set BETTEROFF_API_TOKEN in this shell instead.`,
		);
	}
}

async function resolveToken(deps: CliDeps): Promise<{ token: string; source: string } | null> {
	const fromEnv = deps.env.BETTEROFF_API_TOKEN?.trim();

	if (fromEnv) return { token: fromEnv, source: "BETTEROFF_API_TOKEN" };

	const stored = await keychain(() => deps.tokens.get());

	return stored ? { token: stored, source: "system keychain" } : null;
}

function errorMessage(status: number, body: JsonValue, retryAfter: string | null): string {
	const parsed = errorBodySchema.safeParse(body).data;
	const text = parsed?.detail ?? parsed?.message ?? parsed?.title ?? `HTTP ${status}`;
	const code = parsed?.code ? ` (${parsed.code})` : "";

	if (status === 401) return `Not signed in or the token was revoked. Run: betteroff login`;

	if (status === 429) return `Rate limited. Try again in ${retryAfter ?? "a few"} seconds.`;

	return `${text}${code}`;
}

async function callTool(deps: CliDeps, token: string, tool: Tool, args: JsonValue) {
	const response = await deps.fetch(`${apiUrl(deps)}/v1/tools/${tool.name}`, {
		method: "POST",
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

	return {
		status: response.status,
		ok: response.ok,
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
		`  ${"login".padEnd(width)}  Save a personal API token to the system keychain`,
		`  ${"logout".padEnd(width)}  Remove the saved token`,
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

async function login(deps: CliDeps): Promise<number> {
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

	await keychain(() => deps.tokens.set(token));
	deps.stderr(`Saved ${token.slice(0, DISPLAY_PREFIX_LENGTH)}… to the system keychain.\n`);

	if (!check.ok) deps.stderr(`Note: ${errorMessage(check.status, check.body, check.retryAfter)}\n`);

	return 0;
}

async function status(deps: CliDeps): Promise<number> {
	const resolved = await resolveToken(deps);

	const lines = [
		`API      ${apiUrl(deps)}`,
		resolved
			? `Token    ${resolved.token.slice(0, DISPLAY_PREFIX_LENGTH)}… from ${resolved.source}`
			: "Token    none. Run: betteroff login",
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

		if (command === "login") return await login(deps);

		if (command === "status") return await status(deps);

		if (command === "logout") {
			const removed = await keychain(() => deps.tokens.delete());

			deps.stderr(removed ? "Removed the saved token.\n" : "No saved token.\n");

			return 0;
		}

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

		const result = await callTool(deps, resolved.token, tool, args);

		if (!result.ok) throw new ApiError(errorMessage(result.status, result.body, result.retryAfter));

		if (json || !deps.stdoutIsTTY) deps.stdout(`${JSON.stringify(result.body, null, 2)}\n`);
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

		throw error;
	}
}
