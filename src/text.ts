/**
 * Control characters and bidirectional overrides. Bank and merchant text reaches the terminal
 * through the API, and these can move the cursor, rewrite the screen, or reorder what is shown.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Stripping terminal control characters is the purpose of this pattern.
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** JSON already escapes C0 controls; these are the rest a terminal would act on. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: Stripping terminal control characters is the purpose of this pattern.
const UNSAFE_IN_JSON = /[\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Text safe to print: line breaks and tabs become spaces, other unsafe characters become U+FFFD. */
export function safeText(text: string): string {
	return text.replace(UNSAFE_CHARACTERS, (character) =>
		character === "\n" || character === "\r" || character === "\t" ? " " : "�",
	);
}

/** The same JSON with unsafe characters written as `\u` escapes, so it still parses to the same value. */
export function safeJson(json: string): string {
	return json.replace(
		UNSAFE_IN_JSON,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
