import type { JsonObject, JsonValue } from "./json";
import * as z from "zod";
import type { Flag, Tool } from "./spec";

export class UsageError extends Error {}

function parseNumber(flag: Flag, text: string): number {
	const value = Number(text);

	if (text.trim() === "" || !Number.isFinite(value))
		throw new UsageError(`--${flag.flag} needs a number, got "${text}".`);

	if (flag.kind === "integer" && !Number.isInteger(value))
		throw new UsageError(`--${flag.flag} needs a whole number, got "${text}".`);

	return value;
}

function checkChoice(flag: Flag, value: string): string {
	if (flag.choices.length > 0 && !flag.choices.includes(value))
		throw new UsageError(`--${flag.flag} must be one of: ${flag.choices.join(", ")}.`);

	return value;
}

function parseValue(flag: Flag, text: string, previous: JsonValue | undefined): JsonValue {
	if (flag.nullable && text === "null") return null;

	switch (flag.kind) {
		case "boolean":
			if (text === "true") return true;

			if (text === "false") return false;
			throw new UsageError(`--${flag.flag} takes true or false, got "${text}".`);
		case "integer":
		case "number":
			return parseNumber(flag, text);
		case "string":
			return checkChoice(flag, text);
		case "list": {
			const earlier = z.array(z.string()).safeParse(previous).data ?? [];
			const added = text.split(",").flatMap((part) => (part.trim() ? [part.trim()] : []));

			return [...earlier, ...added.map((value) => checkChoice(flag, value))];
		}

		case "json": {
			try {
				return z.json().parse(JSON.parse(text));
			} catch {
				throw new UsageError(`--${flag.flag} needs JSON, for example '{"offset":50}'.`);
			}
		}
	}
}

/** CLI defaults and nulls fill required fields left out; any other required field must be passed. */
function fillOmitted(tool: Tool, args: JsonObject) {
	const missing: string[] = [];

	for (const flag of tool.flags) {
		if (args[flag.property] !== undefined) continue;

		if (flag.cliDefault !== undefined) args[flag.property] = flag.cliDefault;
		else if (flag.nullWhenOmitted) args[flag.property] = null;
		else if (flag.required) missing.push(`--${flag.flag}`);
	}

	if (missing.length > 0)
		throw new UsageError(
			`${tool.command} needs ${missing.join(", ")}. Run: betteroff ${tool.command} --help`,
		);
}

/** Turn `--merchant amazon --all-time --traits travel,gifts` into the tool's JSON arguments. */
export function parseToolArgs(tool: Tool, argv: string[]): JsonObject {
	const byFlag = new Map(tool.flags.map((flag) => [flag.flag, flag]));
	const args: JsonObject = {};

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index] ?? "";

		if (!token.startsWith("--"))
			throw new UsageError(`Unexpected argument "${token}". Flags start with --.`);

		const [name = "", inline] = token.slice(2).split(/=(.*)/s, 2);
		const negated = name.startsWith("no-") && !byFlag.has(name);
		const flag = byFlag.get(negated ? name.slice(3) : name);

		if (!flag)
			throw new UsageError(
				`Unknown flag --${name} for ${tool.command}. Run: betteroff ${tool.command} --help`,
			);

		if (flag.kind === "boolean" && inline === undefined) {
			args[flag.property] = !negated;
			continue;
		}

		if (negated) throw new UsageError(`--no-${flag.flag} only works for true/false flags.`);

		let text = inline;

		if (text === undefined) {
			text = argv[index + 1];
			index++;
		}

		if (text === undefined) throw new UsageError(`--${flag.flag} needs a value.`);
		args[flag.property] = parseValue(flag, text, args[flag.property]);
	}

	fillOmitted(tool, args);

	return args;
}
