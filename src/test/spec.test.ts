import { describe, expect, test } from "bun:test";
import { parseToolArgs, UsageError } from "../args";
import { findTool, type Tool, toolsFromSpec, toolsSpecSchema } from "../spec";
import { fixtureSpec } from "./fixtures";

const tools = toolsFromSpec(toolsSpecSchema.parse(fixtureSpec));

function get(command: string): Tool {
	const tool = findTool(tools, command);

	if (!tool) throw new Error(`fixture has no ${command}`);

	return tool;
}

describe("toolsFromSpec", () => {
	test("keeps read-only tools and drops write tools, even mislabeled ones", () => {
		const names = tools.map((tool) => tool.name);

		expect(names).toContain("betteroff_list_accounts");
		expect(names).not.toContain("betteroff_request_transfer");
		expect(names).not.toContain("betteroff_propose_category_change");
	});

	test("shortens commands and falls back to the full name on a collision", () => {
		expect(get("accounts").name).toBe("betteroff_list_accounts");
		expect(get("list-accounts").name).toBe("betteroff_list_accounts");
		expect(get("transactions").name).toBe("betteroff_search_transactions");
		expect(get("search-markets").name).toBe("betteroff_search_markets");
		expect(get("list-markets").name).toBe("betteroff_list_markets");
		expect(findTool(tools, "markets")).toBeUndefined();
	});

	test("maps schema types to flag kinds", () => {
		const kinds = Object.fromEntries(
			get("transactions").flags.map((flag) => [flag.flag, flag.kind]),
		);

		expect(kinds).toEqual({
			merchant: "string",
			"all-time": "boolean",
			limit: "integer",
			"min-amount": "number",
			traits: "list",
			cursor: "json",
		});
	});
});

describe("parseToolArgs", () => {
	test("parses values, booleans, lists and JSON, and sends null for omitted nullable fields", () => {
		expect(
			parseToolArgs(get("transactions"), [
				"--merchant",
				"Blue Bottle",
				"--all-time",
				"--limit=10",
				"--traits",
				"travel",
				"--traits=gifts",
				"--cursor",
				'{"offset":50}',
			]),
		).toEqual({
			merchant: "Blue Bottle",
			allTime: true,
			limit: 10,
			minAmount: null,
			traits: ["travel", "gifts"],
			cursor: { offset: 50 },
		});
	});

	test("leaves out fields the server defaults", () => {
		expect(parseToolArgs(get("portfolio"), [])).toEqual({});
		expect(parseToolArgs(get("portfolio"), ["--group-by", "account"])).toEqual({
			groupBy: "account",
		});
	});

	test("fills a required input the server has no default for with the CLI default", () => {
		expect(parseToolArgs(get("activity"), [])).toEqual({ actorType: "all" });
		expect(parseToolArgs(get("activity"), ["--actor-type", "agent"])).toEqual({
			actorType: "agent",
		});
	});

	test("accepts --no-flag and an explicit null", () => {
		expect(
			parseToolArgs(get("transactions"), ["--no-all-time", "--merchant", "null"]),
		).toMatchObject({
			allTime: false,
			merchant: null,
		});
	});

	test.each([
		[["--limit", "2.5"], "whole number"],
		[["--min-amount", "lots"], "needs a number"],
		[["--traits", "boats"], "must be one of"],
		[["--cursor", "{"], "needs JSON"],
		[["--merchant"], "needs a value"],
		[["--nope"], "Unknown flag --nope"],
		[["merchant"], "Unexpected argument"],
	])("rejects %p", (argv, message) => {
		expect(() => parseToolArgs(get("transactions"), argv)).toThrow(message);
	});

	test("names a missing required flag", () => {
		expect(() => parseToolArgs(get("action-request"), [])).toThrow(UsageError);
		expect(() => parseToolArgs(get("action-request"), [])).toThrow("--request-id");
	});
});
