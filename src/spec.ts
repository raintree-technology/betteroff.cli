import * as z from "zod";
import type { JsonObject, JsonValue } from "./json";
import { safeText } from "./text";

type JsonSchema = {
	type?: string | string[] | undefined;
	anyOf?: JsonSchema[] | undefined;
	enum?: JsonValue[] | undefined;
	items?: JsonSchema | undefined;
	description?: string | undefined;
	default?: JsonValue | undefined;
};

const jsonSchema: z.ZodType<JsonSchema> = z.lazy(() =>
	z.object({
		type: z.union([z.string(), z.array(z.string())]).optional(),
		anyOf: z.array(jsonSchema).optional(),
		enum: z.array(z.json()).optional(),
		items: jsonSchema.optional(),
		description: z.string().optional(),
		default: z.json().optional(),
	}),
);

const operationSchema = z.object({
	operationId: z.string(),
	summary: z.string(),
	description: z.string().default(""),
	"x-mcp-annotations": z.object({ readOnlyHint: z.boolean().default(false) }).default({
		readOnlyHint: false,
	}),
	requestBody: z
		.object({
			content: z.object({
				"application/json": z.object({
					schema: z.object({
						properties: z.record(z.string(), jsonSchema).default({}),
						required: z.array(z.string()).default([]),
					}),
				}),
			}),
		})
		.optional(),
});

export const toolsSpecSchema = z.object({
	info: z.object({ version: z.string() }),
	paths: z.record(z.string(), z.object({ post: operationSchema.optional() })),
});

export type ToolsSpec = z.infer<typeof toolsSpecSchema>;

export type FlagKind = "string" | "integer" | "number" | "boolean" | "list" | "json";

export type Flag = {
	property: string;
	flag: string;
	kind: FlagKind;
	choices: string[];
	description: string;
	/** The caller must pass it: required, not nullable, and without a server default. */
	required: boolean;
	/** Required but nullable: the CLI sends null when the flag is left out. */
	nullWhenOmitted: boolean;
	/** Sent when the flag is left out, for a required input the server has no default for. */
	cliDefault: JsonValue | undefined;
	nullable: boolean;
};

type FlagInput = Pick<Flag, "kind" | "choices">;

export type Tool = {
	name: string;
	command: string;
	aliases: string[];
	summary: string;
	description: string;
	flags: Flag[];
};

/**
 * The CLI never prepares, requests, or cancels anything. The server's read-only annotation is the
 * first check; the name check keeps a mislabeled write tool out of the command list as well.
 */
const WRITE_TOOL = /^betteroff_(?:propose|request|cancel|submit)_/;

/** Required inputs with an obvious answer for a person at a terminal, so the bare command works. */
const CLI_DEFAULTS = new Map<string, JsonObject>([
	["betteroff_get_portfolio", { groupBy: "type", includePositions: true }],
	["betteroff_search_activity", { actorType: "all" }],
	["betteroff_simulate_debt_payoff", { strategy: "avalanche", extraMonthly: 0 }],
	["betteroff_search_markets", { limit: 10, offset: 0 }],
]);

/** Tool names become URL paths and command names; anything else in the spec is ignored. */
const TOOL_NAME = /^betteroff_[a-z][a-z0-9_]*$/;

/** Input names become flag names and JSON keys. */
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

const VERB_PREFIX = /^(?:get|list|search)_/;

function kebab(text: string): string {
	return text.replaceAll("_", "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function schemaTypes(schema: JsonSchema): string[] {
	return [schema.type ?? []].flat();
}

function stringChoices(schema: JsonSchema | undefined): string[] {
	return (schema?.enum ?? []).flatMap((value) => {
		const text = z.string().safeParse(value).data;

		// An enum value with control characters would print as something other than what it sends.
		return text !== undefined && safeText(text) === text ? [text] : [];
	});
}

/** Collapse `T | null` unions to `T`; anything with more than one real type is passed as JSON. */
function isNullable(schema: JsonSchema): boolean {
	return (schema.anyOf ?? [schema]).some((variant) => schemaTypes(variant).includes("null"));
}

function flagKind(schema: JsonSchema): FlagInput {
	const variants = schema.anyOf ?? [schema];
	const types = new Set<string>();
	let choiceSource: JsonSchema | undefined;
	let items: JsonSchema | undefined;

	for (const variant of variants) {
		for (const type of schemaTypes(variant)) if (type !== "null") types.add(type);

		if (variant.enum) choiceSource = variant;

		if (variant.items) items = variant.items;
	}

	const [type] = types;

	if (types.size !== 1 || type === undefined) return { kind: "json", choices: [] };

	switch (type) {
		case "boolean":
		case "integer":
		case "number":
			return { kind: type, choices: [] };
		case "string":
			return { kind: "string", choices: stringChoices(choiceSource) };
		case "array": {
			const itemTypes = items ? schemaTypes(items) : [];

			if (items && itemTypes.length === 1 && itemTypes[0] === "string")
				return { kind: "list", choices: stringChoices(items) };

			return { kind: "json", choices: [] };
		}

		default:
			return { kind: "json", choices: [] };
	}
}

/** Read-only tools from the public spec, with short command names (`list_accounts` → `accounts`). */
export function toolsFromSpec(spec: ToolsSpec): Tool[] {
	const operations: z.infer<typeof operationSchema>[] = [];

	for (const [path, item] of Object.entries(spec.paths)) {
		const operation = item.post;

		if (!path.startsWith("/v1/tools/") || !operation) continue;

		if (!TOOL_NAME.test(operation.operationId)) continue;

		if (!operation["x-mcp-annotations"].readOnlyHint || WRITE_TOOL.test(operation.operationId))
			continue;
		operations.push(operation);
	}

	const shortNames = new Map<string, number>();

	for (const operation of operations) {
		const short = kebab(operation.operationId.replace(/^betteroff_/, "").replace(VERB_PREFIX, ""));

		shortNames.set(short, (shortNames.get(short) ?? 0) + 1);
	}

	const tools: Tool[] = [];

	for (const operation of operations) {
		const full = kebab(operation.operationId.replace(/^betteroff_/, ""));
		const short = kebab(operation.operationId.replace(/^betteroff_/, "").replace(VERB_PREFIX, ""));
		const command = shortNames.get(short) === 1 ? short : full;
		const body = operation.requestBody?.content["application/json"].schema;
		const required = new Set(body?.required ?? []);
		const flags: Flag[] = [];

		for (const [property, schema] of Object.entries(body?.properties ?? {})) {
			if (!PROPERTY_NAME.test(property)) continue;

			const { kind, choices } = flagKind(schema);
			const nullable = isNullable(schema);
			const mustSend = required.has(property) && schema.default === undefined;
			const cliDefault = mustSend ? CLI_DEFAULTS.get(operation.operationId)?.[property] : undefined;

			flags.push({
				property,
				flag: kebab(property),
				kind,
				choices,
				description: safeText(schema.description ?? ""),
				required: mustSend && !nullable && cliDefault === undefined,
				nullWhenOmitted: mustSend && nullable,
				cliDefault,
				nullable,
			});
		}

		tools.push({
			name: operation.operationId,
			command,
			aliases: command === full ? [] : [full],
			summary: safeText(operation.summary),
			description: safeText(operation.description),
			flags,
		});
	}

	return tools.sort((a, b) => a.command.localeCompare(b.command));
}

export function findTool(tools: Tool[], command: string): Tool | undefined {
	return tools.find((tool) => tool.command === command || tool.aliases.includes(command));
}
