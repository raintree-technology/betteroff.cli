#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { secrets } from "bun";
import { type CliDeps, run } from "./cli";
import { macosTokenStore, runSecurity } from "./keychain";
import { caBundle } from "./trust";

const KEYCHAIN = { service: "finance.betteroff.cli", name: "api-token" };

const cacheDir = join(homedir(), ".cache", "betteroff");

const specPath = join(cacheDir, "tools-spec.json");

/** Reads a line from the terminal without echoing it, or all of stdin when it is piped. */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) return await new Response(Bun.stdin.stream()).text();

	process.stderr.write(prompt);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");

	return await new Promise((resolve, reject) => {
		let value = "";

		const finish = (error?: Error) => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stderr.write("\n");

			if (error) reject(error);
			else resolve(value);
		};

		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === "\r" || character === "\n") return finish();

				if (character === "\u0003") return finish(new Error("Cancelled"));

				if (character === "\u007f") value = value.slice(0, -1);
				else value += character;
			}
		};

		process.stdin.on("data", onData);
	});
}

const deps: CliDeps = {
	env: process.env,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	stdoutIsTTY: process.stdout.isTTY === true,
	columns: process.stdout.columns ?? 100,
	fetch: (url, init) => fetch(url, { ...init, tls: { ca: caBundle } }),
	tokens:
		process.platform === "darwin"
			? macosTokenStore(runSecurity)
			: {
					get: () => secrets.get(KEYCHAIN),
					set: (token) => secrets.set({ ...KEYCHAIN, value: token }),
					delete: () => secrets.delete(KEYCHAIN),
				},
	specCache: {
		read: async () => {
			const file = Bun.file(specPath);

			return (await file.exists()) ? await file.text() : null;
		},
		write: async (text) => {
			await mkdir(cacheDir, { recursive: true });
			await Bun.write(specPath, text);
		},
	},
	readSecret,
	now: Date.now,
};

process.exitCode = await run(process.argv.slice(2), deps);
