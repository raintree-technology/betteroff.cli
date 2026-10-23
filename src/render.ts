import type { JsonObject, JsonValue } from "./json";
import { safeText } from "./text";
import * as z from "zod";

export type Style = { bold: (text: string) => string; dim: (text: string) => string };

export const plainStyle: Style = { bold: (text) => text, dim: (text) => text };

export const ansiStyle: Style = {
	bold: (text) => `\u001b[1m${text}\u001b[22m`,
	dim: (text) => `\u001b[2m${text}\u001b[22m`,
};

type View = { width: number; style: Style; currency: string | undefined };

const MAX_CELL = 40;

/** A list longer than this goes one item per line instead of comma-joined. */
const INLINE_LIST = 80;

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

const PERCENT_KEY = /percent|pct/i;

/** Decimal text is money unless its name says otherwise; the API sends amounts as decimal strings. */
const NOT_MONEY_KEY = /quantity|mask|percent|pct|rate|apr|apy|count|units|shares|zip|version|year/i;

/** Plain-number amounts are named for their currency, such as `totalAssetsUsd`. */
const USD_NUMBER_KEY = /Usd$/;

const LABEL_KEY =
	/^(?:displayName|name|merchant|merchantName|symbol|title|headline|label|protocol|description)$/;

const DATE_KEY = /^date$|Date$/;

const TIMESTAMP_KEY = /At$|^asOf$|^timestamp$/;

const ISO_DATETIME =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

const objectSchema: z.ZodType<JsonObject> = z.record(z.string(), z.json());

const objectListSchema = z.array(objectSchema);

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const currencyCode = z.string().regex(/^[A-Z]{3}$/);

/** The `/v1/tools` result envelope. Only what a person reading the terminal needs is kept. */
const envelopeSchema = z.object({
	ok: z.literal(true),
	data: z.json(),
	// Each field falls back on its own, so one odd field never shows the raw envelope.
	currency: currencyCode.optional().catch(undefined),
	asOf: z.string().nullable().catch(null),
	quality: z
		.object({ state: z.string(), reasons: z.array(z.string()) })
		.optional()
		.catch(undefined),
	page: z
		.object({
			returnedCount: z.number(),
			totalCount: z.number(),
			truncated: z.boolean(),
			nextCursor: z.json().nullable(),
		})
		.optional()
		.catch(undefined),
	warnings: z.array(z.string()).catch([]),
});

function label(key: string): string {
	const words = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([a-z])(\d)/g, "$1 $2")
		.replaceAll("_", " ")
		.toLowerCase();

	return safeText(words.charAt(0).toUpperCase() + words.slice(1));
}

function currencyOf(row: JsonObject, view: View): string | undefined {
	return (
		currencyCode.safeParse(row.currency ?? row.baseCurrency ?? row.totalCurrency).data ??
		view.currency
	);
}

/** The currency to format this value in, or undefined when it is not an amount. */
function moneyCurrency(key: string, value: JsonValue, row: JsonObject, view: View) {
	const text = z.string().safeParse(value).data;

	if (text !== undefined) {
		return DECIMAL.test(text) && !NOT_MONEY_KEY.test(key) ? currencyOf(row, view) : undefined;
	}

	return USD_NUMBER_KEY.test(key) && z.number().safeParse(value).success ? "USD" : undefined;
}

function formatScalar(key: string, value: JsonValue, row: JsonObject, view: View): string {
	const scalar = scalarSchema.safeParse(value);

	if (!scalar.success) return "…";

	const data = scalar.data;

	if (data === null) return "-";

	if (data === true) return "yes";

	if (data === false) return "no";

	const text = String(data);
	const currency = moneyCurrency(key, data, row, view);

	if (PERCENT_KEY.test(key) && z.number().safeParse(data).success) return `${text}%`;

	if (currency) {
		try {
			return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(text));
		} catch {
			return `${text} ${currency}`;
		}
	}

	const datetime = ISO_DATETIME.exec(text);

	if (datetime) return `${datetime[1]} ${datetime[2]}`;

	return safeText(text);
}

function truncate(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

function isId(key: string): boolean {
	return key === "id" || key.endsWith("Id");
}

/** Text to read: not a number, a date, or a link. Missing values do not disqualify a column. */
function isProse(value: JsonValue | undefined): boolean {
	const text = z.string().safeParse(value).data;

	return (
		text !== undefined && !DECIMAL.test(text) && !ISO_DATETIME.test(text) && !text.startsWith("http")
	);
}

/** The column that names each row: a known label column, else the first column of plain text. */
function labelColumns(columns: string[], rows: JsonObject[]): Set<string> {
	const known = columns.flatMap((key) => (LABEL_KEY.test(key) ? [key] : []));

	if (known.length > 0) return new Set(known);

	const first = columns.find(
		(key) => !isId(key) && !DATE_KEY.test(key) && rows.every((row) => row[key] === null || row[key] === undefined || isProse(row[key])),
	);

	return new Set(first ? [first] : []);
}

function columnRank(key: string, rows: JsonObject[], labels: Set<string>, view: View): number {
	if (labels.has(key)) return 0;

	if (rows.some((row) => moneyCurrency(key, row[key] ?? null, row, view))) return 1;

	if (PERCENT_KEY.test(key)) return 1;

	if (DATE_KEY.test(key)) return 2;

	if (isId(key)) return 6;

	if (rows.every((row) => z.boolean().nullable().optional().safeParse(row[key]).success)) return 5;

	if (TIMESTAMP_KEY.test(key)) return 4;

	return 3;
}

/**
 * Scalar columns in reading order: the label, money and percentages, dates, the rest, timestamps, yes/no flags,
 * ids. A narrow terminal drops
 * columns from the end, so ids go first. Empty columns are dropped, `name` beside `displayName`
 * (which contains it), and `currency` when every row uses the result's currency.
 */
function tableColumns(rows: JsonObject[], view: View): string[] {
	const columns: string[] = [];
	const nested = new Set<string>();

	for (const row of rows) {
		for (const [key, value] of Object.entries(row)) {
			if (!scalarSchema.safeParse(value).success) nested.add(key);
			else if (!columns.includes(key)) columns.push(key);
		}
	}

	const redundant = (key: string) =>
		nested.has(key) ||
		rows.every((row) => row[key] === null || row[key] === undefined) ||
		(key === "name" && columns.includes("displayName")) ||
		(key === "currency" && rows.every((row) => row.currency === view.currency));

	const kept = columns.flatMap((key) => (redundant(key) ? [] : [key]));
	const labels = labelColumns(kept, rows);

	return kept
		.map((key, order) => ({ key, order, rank: columnRank(key, rows, labels, view) }))
		.sort((a, b) => a.rank - b.rank || a.order - b.order)
		.map(({ key }) => key);
}

function renderTable(rows: JsonObject[], view: View, indent: string): string[] {
	if (rows.length === 0) return [`${indent}${view.style.dim("None")}`];

	const columns = tableColumns(rows, view);

	const cells = rows.map((row) =>
		columns.map((key) => truncate(formatScalar(key, row[key] ?? null, row, view), MAX_CELL)),
	);

	const widths = columns.map((key, column) =>
		Math.max(label(key).length, ...cells.map((row) => (row[column] ?? "").length)),
	);

	let shown = columns.length;
	let used = indent.length;

	for (let column = 0; column < columns.length; column++) {
		used += (widths[column] ?? 0) + 2;

		if (used > view.width && column > 0) {
			shown = column;
			break;
		}
	}

	const line = (values: string[]) =>
		indent +
		values
			.slice(0, shown)
			.map((value, column) => value.padEnd(widths[column] ?? 0))
			.join("  ")
			.trimEnd();

	const lines = [view.style.bold(line(columns.map(label))), ...cells.map(line)];

	if (shown < columns.length)
		lines.push(
			`${indent}${view.style.dim(`${columns.length - shown} more columns hidden; use --json for everything`)}`,
		);

	return lines;
}

function renderObject(row: JsonObject, view: View, indent: string): string[] {
	const lines: string[] = [];
	const scalars: [string, string][] = [];
	const sections: [string, JsonValue][] = [];
	const bullets: [string, string[]][] = [];

	for (const [key, value] of Object.entries(row)) {
		const list = z.array(scalarSchema).safeParse(value);

		if (scalarSchema.safeParse(value).success) {
			scalars.push([key, formatScalar(key, value, row, view)]);
			continue;
		}

		if (!list.success) {
			sections.push([key, value]);
			continue;
		}

		const items = list.data.map((item) => formatScalar(key, item, row, view));
		const joined = items.join(", ");

		if (joined.length > INLINE_LIST) bullets.push([key, items]);
		else scalars.push([key, items.length > 0 ? joined : "none"]);
	}

	const labelWidth = Math.max(0, ...scalars.map(([key]) => label(key).length));

	for (const [key, text] of scalars)
		lines.push(`${indent}${view.style.dim(label(key).padEnd(labelWidth))}  ${text}`);

	for (const [key, items] of bullets) {
		if (lines.length > 0) lines.push("");

		lines.push(`${indent}${view.style.bold(label(key))}`);

		for (const item of items) lines.push(`${indent}  - ${item}`);
	}

	for (const [key, value] of sections) {
		if (lines.length > 0) lines.push("");

		lines.push(`${indent}${view.style.bold(label(key))}`);
		lines.push(...renderValue(value, view, `${indent}  `));
	}

	return lines;
}

function renderValue(value: JsonValue, view: View, indent: string): string[] {
	const rows = objectListSchema.safeParse(value);

	if (rows.success) return renderTable(rows.data, view, indent);

	const row = objectSchema.safeParse(value);

	if (row.success) return renderObject(row.data, view, indent);

	return [`${indent}${formatScalar("", value, {}, view)}`];
}

/** What the envelope says about the data's completeness, paging, and freshness. */
function envelopeFooter(envelope: z.infer<typeof envelopeSchema>, style: Style): string[] {
	const lines: string[] = [];
	const { page, quality } = envelope;

	if (page?.truncated) {
		const next =
			page.nextCursor === null ? "" : ` Next page: --cursor '${JSON.stringify(page.nextCursor)}'`;

		lines.push(`Showing ${page.returnedCount} of ${page.totalCount}.${next}`);
	}

	if (quality && quality.state !== "complete") {
		lines.push(`Data is ${quality.state}:`);

		for (const reason of quality.reasons) lines.push(`  - ${reason}`);
	}

	for (const warning of envelope.warnings) lines.push(`Note: ${warning}`);

	const asOf = envelope.asOf ? ISO_DATETIME.exec(envelope.asOf) : null;

	if (asOf) lines.push(`As of ${asOf[1]} ${asOf[2]} UTC`);

	return lines.length > 0 ? ["", ...lines.map((line) => style.dim(safeText(line)))] : [];
}

/** A readable view of a tool result. `--json` prints the exact payload, envelope included. */
export function renderPretty(value: JsonValue, width: number, style: Style): string {
	const envelope = envelopeSchema.safeParse(value);

	if (!envelope.success)
		return `${renderValue(value, { width, style, currency: undefined }, "").join("\n")}\n`;

	const view: View = { width, style, currency: envelope.data.currency };
	const data = objectSchema.safeParse(envelope.data.data);

	// The envelope's page is the one the footer reports; a copy inside the data would repeat it.
	if (data.success && envelope.data.page) delete data.data.page;

	const body = renderValue(data.success ? data.data : envelope.data.data, view, "");

	return `${[...body, ...envelopeFooter(envelope.data, style)].join("\n")}\n`;
}
