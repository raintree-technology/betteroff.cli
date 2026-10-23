import { describe, expect, test } from "bun:test";
import { macosTokenStore, type SecurityResult } from "../keychain";
import { TOKEN } from "./fixtures";

function fakeSecurity(result: SecurityResult) {
	const calls: { args: string[]; input: string | undefined }[] = [];
	const store = macosTokenStore(async (args, input) => {
		calls.push({ args, input });

		return result;
	});

	return { calls, store };
}

describe("macosTokenStore", () => {
	test("reads the token and treats a missing item as signed out", async () => {
		expect(await fakeSecurity({ code: 0, stdout: `${TOKEN}\n`, stderr: "" }).store.get()).toBe(TOKEN);
		expect(await fakeSecurity({ code: 44, stdout: "", stderr: "not found" }).store.get()).toBeNull();
	});

	test("passes the token on stdin, never in the arguments", async () => {
		const { calls, store } = fakeSecurity({ code: 0, stdout: "", stderr: "" });

		await store.set(TOKEN);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(["-i"]);
		expect(calls[0]?.args.join(" ")).not.toContain(TOKEN);
		expect(calls[0]?.input).toBe(
			`add-generic-password -U -s betteroff-cli -a api-token -w ${TOKEN}\n`,
		);
	});

	test("refuses a token that would need quoting", async () => {
		const { calls, store } = fakeSecurity({ code: 0, stdout: "", stderr: "" });

		await expect(store.set("bo_pat_x -w other")).rejects.toThrow("cannot take");
		expect(calls).toHaveLength(0);
	});

	test("reports the keychain's own error", async () => {
		const locked = {
			code: 36,
			stdout: "",
			stderr: "security: SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.\n",
		};

		await expect(fakeSecurity(locked).store.set(TOKEN)).rejects.toThrow("User interaction is not allowed");
		await expect(fakeSecurity(locked).store.get()).rejects.toThrow("User interaction is not allowed");
	});

	test("delete reports whether there was a token", async () => {
		expect(await fakeSecurity({ code: 0, stdout: "", stderr: "" }).store.delete()).toBe(true);
		expect(await fakeSecurity({ code: 44, stdout: "", stderr: "" }).store.delete()).toBe(false);
	});
});
