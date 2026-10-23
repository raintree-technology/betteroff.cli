import type { JsonObject } from "../json";
import type { CliDeps } from "../cli";

function tool(name: string, readOnly: boolean, schema: JsonObject): JsonObject {
	return {
		post: {
			operationId: name,
			summary: name,
			description: `${name} description. Use null for everything.`,
			"x-mcp-annotations": { readOnlyHint: readOnly },
			requestBody: { content: { "application/json": { schema } } },
		},
	};
}

/** The shape of /openapi/tools.json, cut down to the cases the CLI handles differently. */
export const fixtureSpec: JsonObject = {
	info: { version: "0.5.0+test" },
	paths: {
		"/v1/tools/betteroff_list_accounts": tool("betteroff_list_accounts", true, {
			type: "object",
			properties: {},
		}),
		"/v1/tools/betteroff_search_transactions": tool("betteroff_search_transactions", true, {
			type: "object",
			properties: {
				merchant: { type: ["string", "null"], description: "Merchant name." },
				allTime: { type: ["boolean", "null"], default: null },
				limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
				minAmount: { type: ["number", "null"] },
				traits: {
					anyOf: [
						{ type: "array", items: { type: "string", enum: ["travel", "gifts"] } },
						{ type: "null" },
					],
				},
				cursor: {
					anyOf: [
						{ type: "object", properties: { offset: { type: "integer" } } },
						{ type: "null" },
					],
				},
			},
			required: ["merchant", "allTime", "limit", "minAmount", "traits", "cursor"],
		}),
		"/v1/tools/betteroff_get_action_request": tool("betteroff_get_action_request", true, {
			type: "object",
			properties: { requestId: { type: "string" } },
			required: ["requestId"],
		}),
		"/v1/tools/betteroff_get_portfolio": tool("betteroff_get_portfolio", true, {
			type: "object",
			properties: { groupBy: { type: "string", enum: ["asset", "account"], default: "asset" } },
			required: ["groupBy"],
		}),
		"/v1/tools/betteroff_search_activity": tool("betteroff_search_activity", true, {
			type: "object",
			properties: { actorType: { type: "string", enum: ["agent", "user", "all"] } },
			required: ["actorType"],
		}),
		"/v1/tools/betteroff_search_markets": tool("betteroff_search_markets", true, {
			type: "object",
			properties: {},
		}),
		"/v1/tools/betteroff_list_markets": tool("betteroff_list_markets", true, {
			type: "object",
			properties: {},
		}),
		// Names that are not safe tool names, and text a terminal would act on.
		"/v1/tools/betteroff_get_x/../../admin": tool("betteroff_get_x/../../admin", true, {
			type: "object",
			properties: {},
		}),
		"/v1/tools/betteroff_get_checklist": {
			post: {
				operationId: "betteroff_get_checklist",
				summary: "Get checklist\u001b[2J",
				description: "Read the checklist.\u202e",
				"x-mcp-annotations": { readOnlyHint: true },
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									section: { type: "string", enum: ["estate", "evil\u001b[2J"] },
									"bad-name": { type: "string" },
								},
							},
						},
					},
				},
			},
		},
		"/v1/tools/betteroff_request_transfer": tool("betteroff_request_transfer", false, {
			type: "object",
			properties: { amountUsdc: { type: "string" } },
		}),
		// Mislabeled on purpose: the name alone must keep it out.
		"/v1/tools/betteroff_propose_category_change": tool("betteroff_propose_category_change", true, {
			type: "object",
			properties: {},
		}),
	},
};

export const TOKEN = `bo_pat_${"a".repeat(43)}`;

export type Recorded = { url: string; init: RequestInit | undefined };

type Responder = (url: string, init: RequestInit | undefined) => Response;

export function fakeDeps(respond: Responder, overrides: Partial<CliDeps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const requests: Recorded[] = [];
	let stored: string | null = null;
	let cache: string | null = null;

	const deps: CliDeps = {
		env: {},
		stdout: (text) => {
			out.push(text);
		},
		stderr: (text) => {
			err.push(text);
		},
		stdoutIsTTY: false,
		columns: 100,
		fetch: async (url, init) => {
			requests.push({ url, init });

			return respond(url, init);
		},
		tokens: {
			get: async () => stored,
			set: async (token) => {
				stored = token;
			},
			delete: async () => {
				const had = stored !== null;

				stored = null;

				return had;
			},
		},
		specCache: {
			read: async () => cache,
			write: async (text) => {
				cache = text;
			},
		},
		readSecret: async () => TOKEN,
		now: () => 1_000_000,
		keychainTimeoutMs: 50,
		startCallback: async () => {
			throw new Error("startCallback is not set up in this test");
		},
		readLine: async () => null,
		openBrowser: async () => true,
		withLock: (action) => action(),
		signInTimeoutMs: 1000,
		...overrides,
	};

	return {
		deps,
		requests,
		stdout: () => out.join(""),
		stderr: () => err.join(""),
		storedToken: () => stored,
		cachedSpec: () => cache,
	};
}

/** Serves the spec, and answers every tool call with `toolResponse`. */
export function api(toolResponse: () => Response): Responder {
	return (url) =>
		url.endsWith("/openapi/tools.json") ? Response.json(fixtureSpec) : toolResponse();
}
