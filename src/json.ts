/** The JSON data model: what `JSON.parse` returns. Parse untrusted input with `z.json()` to get one. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}
