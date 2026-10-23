import { describe, expect, test } from "bun:test";
import { plainStyle, renderPretty } from "../render";

describe("renderPretty layout", () => {
	test("renders rows as a table: label, money, dates, the rest, then ids", () => {
		const output = renderPretty(
			[
				{
					id: "acc-1",
					displayName: "Checking",
					balance: "1234.5",
					currency: "USD",
					balanceAsOf: "2026-10-21T14:05:00.000Z",
					isHidden: false,
					meta: { nested: true },
				},
				{
					id: "acc-2",
					displayName: "Brokerage",
					balance: null,
					currency: "USD",
					balanceAsOf: null,
					isHidden: null,
					meta: null,
				},
			],
			100,
			plainStyle,
		);

		expect(output.split("\n")).toEqual([
			"Display name  Balance    Balance as of     Currency  Is hidden  Id",
			"Checking      $1,234.50  2026-10-21 14:05  USD       no         acc-1",
			"Brokerage     -          -                 USD       -          acc-2",
			"",
		]);
	});

	test("hides the columns that do not fit and says so", () => {
		const output = renderPretty([{ name: "a".repeat(30), id: "b".repeat(30) }], 40, plainStyle);

		expect(output).toContain("1 more columns hidden; use --json for everything");
		expect(output).not.toContain("b".repeat(30));
	});

	test("renders objects as labeled fields with nested sections", () => {
		const output = renderPretty(
			{
				netWorth: "-12.5",
				baseCurrency: "USD",
				reviewCauses: ["stale", "missing"],
				steps: [],
				coverage: { accountCount: 3 },
			},
			100,
			plainStyle,
		);

		expect(output.split("\n")).toEqual([
			"Net worth      -$12.50",
			"Base currency  USD",
			"Review causes  stale, missing",
			"Steps          none",
			"",
			"Coverage",
			"  Account count  3",
			"",
		]);
	});
});

describe("renderPretty tool results", () => {
	test("unwraps the result envelope and reports paging, quality, and freshness", () => {
		const output = renderPretty(
			{
				ok: true,
				schemaVersion: "4",
				data: {
					summary: { totalSpent: "8393.79", totalCurrency: "USD" },
					transactions: [{ name: "Coffee", amount: "4.5", currency: "USD", date: "2026-10-21" }],
					page: { returnedCount: 1, totalCount: 2, truncated: true, nextCursor: null },
				},
				currency: "USD",
				asOf: "2026-10-23T00:00:00.000Z",
				quality: { state: "partial", reasons: ["Some valuations are not fully reconciled."] },
				evidence: [{ source: "search_transactions", id: "e-1", observedAt: "2026-10-22" }],
				page: {
					returnedCount: 1,
					totalCount: 2,
					truncated: true,
					nextCursor: { offset: 1, revision: 7 },
				},
				warnings: ["Hidden assets may affect coverage."],
				notes: "Agent guidance.",
				requestId: "req-1",
			},
			100,
			plainStyle,
		);

		expect(output.split("\n")).toEqual([
			"Summary",
			"  Total spent     $8,393.79",
			"  Total currency  USD",
			"",
			"Transactions",
			"  Name    Amount  Date",
			"  Coffee  $4.50   2026-10-21",
			"",
			`Showing 1 of 2. Next page: --cursor '{"offset":1,"revision":7}'`,
			"Data is partial:",
			"  - Some valuations are not fully reconciled.",
			"Note: Hidden assets may affect coverage.",
			"As of 2026-10-23 00:00 UTC",
			"",
		]);
	});

	test("formats percentages and gains, and drops empty columns", () => {
		const output = renderPretty(
			{
				ok: true,
				currency: "USD",
				data: {
					performanceGain: "-5281.76",
					totalReturnPct: -12.71,
					positions: [
						{ symbol: "AMAT", value: "15728.9", chain: null, quantity: 40 },
						{ symbol: "ABCL", value: "12450", chain: null, quantity: 1000 },
					],
				},
			},
			100,
			plainStyle,
		);

		expect(output.split("\n")).toEqual([
			"Performance gain  -$5,281.76",
			"Total return pct  -12.71%",
			"",
			"Positions",
			"  Symbol  Value       Quantity",
			"  AMAT    $15,728.90  40",
			"  ABCL    $12,450.00  1000",
			"",
		]);
	});
});
