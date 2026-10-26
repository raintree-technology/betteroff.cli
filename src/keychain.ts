import type { TokenStore } from "./cli";

export type SecurityResult = { code: number; stdout: string; stderr: string };

/** Runs `/usr/bin/security` with these arguments, writing `input` to its stdin. */
export type SecurityRunner = (args: string[], input?: string) => Promise<SecurityResult>;

const SERVICE = "betteroff-cli";

const ACCOUNT = "api-token";

/** `security` exits 44 when the item does not exist. */
const NOT_FOUND = 44;

/** Characters `security -i` reads literally, so the token needs no quoting. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function failure(action: string, result: SecurityResult): Error {
	return new Error(result.stderr.trim() || `${action} exited ${result.code}`);
}

/**
 * macOS Keychain through Apple's `/usr/bin/security`, as `gh` and Mercury's CLI do. The item's
 * access list then names that tool, which is the same program after every CLI upgrade, so reading
 * the token never needs a confirmation dialog. A dialog cannot appear over SSH, and a rebuilt
 * binary would otherwise need one. The token goes through stdin (`-i`), never the argument list.
 */
export function macosTokenStore(run: SecurityRunner): TokenStore {
	return {
		get: async () => {
			const result = await run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);

			if (result.code === NOT_FOUND) return null;

			if (result.code !== 0) throw failure("find-generic-password", result);

			return result.stdout.trim() || null;
		},
		set: async (token) => {
			if (!SAFE_TOKEN.test(token))
				throw new Error("Token has characters the keychain command cannot take");

			const result = await run(
				["-i"],
				`add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${token}\n`,
			);

			if (result.code !== 0) throw failure("add-generic-password", result);
		},
		delete: async () => {
			const result = await run(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);

			if (result.code === NOT_FOUND) return false;

			if (result.code !== 0) throw failure("delete-generic-password", result);

			return true;
		},
	};
}

export const runSecurity: SecurityRunner = async (args, input) => {
	const child = Bun.spawn(["/usr/bin/security", ...args], {
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
		// The CLI stops waiting after 5 seconds; this stops the process too.
		timeout: 5000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	return { code, stdout, stderr };
};
