import { describe, expect, test } from "bun:test";
import { safeJson, safeText } from "../text";

describe("safeText", () => {
	test("replaces terminal escapes and bidi overrides, and flattens line breaks", () => {
		expect(safeText("Coffee\u001b[2J\u001b]0;pwned\u0007 Shop")).toBe("Coffee�[2J�]0;pwned� Shop");
		expect(safeText("Pay ‮emoh‬")).toBe("Pay �emoh�");
		expect(safeText("a\nb\tc\u009bd")).toBe("a b c�d");
		expect(safeText("Café ® 日本")).toBe("Café ® 日本");
	});
});

describe("safeJson", () => {
	test("escapes C1 controls and bidi overrides without changing the value", () => {
		const value = { name: "x\u009b31m‮y" };
		const json = safeJson(JSON.stringify(value));

		expect(json).toBe('{"name":"x\\u009b31m\\u202ey"}');
		expect(JSON.parse(json)).toEqual(value);
	});
});
