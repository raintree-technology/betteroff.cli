import * as z from "zod";
import { CLIENT_ID, type OAuthFetch, refreshTokens, type TokenResponse } from "./oauth";

/** A browser sign-in, saved in the keychain. Access tokens last minutes; the refresh token renews them. */
export type OAuthSession = {
	accessToken: string | undefined;
	refreshToken: string | undefined;
	/** When the access token expires, in milliseconds since the epoch. */
	expiresAt: number;
	tokenEndpoint: string;
	revocationEndpoint: string | undefined;
	resource: string;
	clientId: string;
};

const sessionSchema = z.object({
	v: z.literal(1),
	at: z.string().optional(),
	rt: z.string().optional(),
	exp: z.number(),
	te: z.string(),
	re: z.string().optional(),
	res: z.string(),
	cid: z.string(),
});

const OAUTH_PREFIX = "oauth_";

/**
 * Apple's `security -i` reads one command per line and drops lines over about 4 KB. A session longer
 * than this is saved without its access token, which the refresh token replaces on the next run.
 */
const MAX_STORED_LENGTH = 3500;

/** Renew a little early, so a token does not expire between this check and the request. */
const EXPIRY_MARGIN_MS = 60_000;

export function sessionFromTokens(
	tokens: TokenResponse,
	context: {
		tokenEndpoint: string;
		revocationEndpoint: string | undefined;
		resource: string;
		now: number;
	},
	previousRefreshToken?: string,
): OAuthSession {
	return {
		accessToken: tokens.access_token,
		// A refresh that does not rotate keeps the token it was given.
		refreshToken: tokens.refresh_token ?? previousRefreshToken,
		expiresAt: context.now + tokens.expires_in * 1000,
		tokenEndpoint: context.tokenEndpoint,
		revocationEndpoint: context.revocationEndpoint,
		resource: context.resource,
		clientId: CLIENT_ID,
	};
}

function encode(session: OAuthSession, withAccessToken: boolean): string {
	const stored: z.input<typeof sessionSchema> = {
		v: 1,
		exp: session.expiresAt,
		te: session.tokenEndpoint,
		res: session.resource,
		cid: session.clientId,
	};

	if (withAccessToken && session.accessToken) stored.at = session.accessToken;

	if (session.refreshToken) stored.rt = session.refreshToken;

	if (session.revocationEndpoint) stored.re = session.revocationEndpoint;

	return OAUTH_PREFIX + Buffer.from(JSON.stringify(stored)).toString("base64url");
}

/** The keychain value: base64url JSON, so it holds only characters the keychain command reads literally. */
export function encodeSession(session: OAuthSession): string {
	const full = encode(session, true);

	return full.length <= MAX_STORED_LENGTH ? full : encode(session, false);
}

export type StoredCredential =
	| { kind: "token"; token: string }
	| { kind: "oauth"; session: OAuthSession };

export function decodeCredential(stored: string): StoredCredential | null {
	if (!stored.startsWith(OAUTH_PREFIX)) return { kind: "token", token: stored };

	try {
		const parsed = sessionSchema.parse(
			JSON.parse(Buffer.from(stored.slice(OAUTH_PREFIX.length), "base64url").toString("utf8")),
		);

		return {
			kind: "oauth",
			session: {
				accessToken: parsed.at,
				refreshToken: parsed.rt,
				expiresAt: parsed.exp,
				tokenEndpoint: parsed.te,
				revocationEndpoint: parsed.re,
				resource: parsed.res,
				clientId: parsed.cid,
			},
		};
	} catch {
		return null;
	}
}

export function isFresh(session: OAuthSession, now: number): boolean {
	return session.accessToken !== undefined && session.expiresAt - EXPIRY_MARGIN_MS > now;
}

export type SessionStore = {
	read: () => Promise<string | null>;
	write: (value: string) => Promise<void>;
	/** Runs `action` while no other CLI process holds the lock. */
	withLock: <T>(action: () => Promise<T>) => Promise<T>;
	fetch: OAuthFetch;
	now: () => number;
};

/**
 * Returns a usable access token, renewing it when it is stale or when `force` is set (after the API
 * rejected it). Each refresh replaces the refresh token and the old one stops working, so two
 * processes must not refresh at once: the work happens under a lock, and the session is read again
 * inside it in case another process already renewed it.
 */
export async function accessToken(store: SessionStore, force: boolean): Promise<string | null> {
	return await store.withLock(async () => {
		const stored = await store.read();
		const credential = stored ? decodeCredential(stored) : null;

		if (credential?.kind !== "oauth") return null;

		const { session } = credential;

		if (!force && session.accessToken && isFresh(session, store.now())) return session.accessToken;

		if (!session.refreshToken) return null;

		const tokens = await refreshTokens(store.fetch, {
			tokenEndpoint: session.tokenEndpoint,
			refreshToken: session.refreshToken,
			resource: session.resource,
		});
		const renewed = sessionFromTokens(
			tokens,
			{
				tokenEndpoint: session.tokenEndpoint,
				revocationEndpoint: session.revocationEndpoint,
				resource: session.resource,
				now: store.now(),
			},
			session.refreshToken,
		);

		await store.write(encodeSession(renewed));

		return renewed.accessToken ?? null;
	});
}
