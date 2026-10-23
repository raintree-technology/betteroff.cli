import * as z from "zod";
import type { JsonValue } from "./json";

/**
 * The CLI's OAuth client ID is the URL of its Client ID Metadata Document. The auth server fetches
 * it to learn the client's name, its loopback redirect, and the read-only scopes it may ask for, and
 * shows the client as verified because the document lives on betteroff.finance.
 */
export const CLIENT_ID = "https://betteroff.finance/oauth/cli.json";

/** What the CLI's read-only tools need, plus a refresh token. The metadata document lists the same. */
export const SCOPES = [
	"accounts:read",
	"activity:read",
	"cashflow:read",
	"checklist:read",
	"debts:read",
	"investments:read",
	"networth:read",
	"transactions:read",
	"transfers:read",
	"offline_access",
];

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OAuthError extends Error {}

export type OAuthEndpoints = {
	issuer: string;
	resource: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint: string | undefined;
};

const resourceMetadataSchema = z.object({
	resource: z.string(),
	authorization_servers: z.array(z.string()).min(1),
});

const serverMetadataSchema = z.object({
	issuer: z.string(),
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	revocation_endpoint: z.string().optional(),
	code_challenge_methods_supported: z.array(z.string()).optional(),
	client_id_metadata_document_supported: z.boolean().optional(),
});

export const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().regex(/^bearer$/i),
	expires_in: z.number().int().positive(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

const tokenErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().optional(),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Endpoints must be HTTPS (HTTP only on this machine) and on the issuer's own origin. */
function checkedEndpoint(value: string, issuerOrigin: string, name: string): string {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new OAuthError(`The sign-in server sent an invalid ${name}.`);
	}

	const secure =
		url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));

	if (!secure || url.origin !== issuerOrigin)
		throw new OAuthError(`The sign-in server's ${name} is not on its own HTTPS origin.`);

	return url.href;
}

async function getJson(fetch: OAuthFetch, url: string): Promise<JsonValue> {
	const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error" });

	if (!response.ok) throw new OAuthError(`Could not read ${url} (HTTP ${response.status}).`);

	return z.json().parse(await response.json());
}

/**
 * Finds the sign-in server from the API's protected-resource metadata (RFC 9728), then reads its
 * metadata. Every value is checked, because the token is about to be sent wherever these point.
 */
export async function discover(fetch: OAuthFetch, apiOrigin: string): Promise<OAuthEndpoints> {
	const expectedResource = `${apiOrigin}/mcp`;
	const resourceMetadata = resourceMetadataSchema.safeParse(
		await getJson(fetch, `${apiOrigin}/.well-known/oauth-protected-resource/mcp`),
	);

	if (!resourceMetadata.success || resourceMetadata.data.resource !== expectedResource)
		throw new OAuthError("The API's sign-in metadata does not describe this API.");

	const issuer = (resourceMetadata.data.authorization_servers[0] ?? "").replace(/\/+$/, "");
	let issuerOrigin: string;

	try {
		issuerOrigin = new URL(issuer).origin;
	} catch {
		throw new OAuthError("The API names an invalid sign-in server.");
	}

	checkedEndpoint(issuer, issuerOrigin, "issuer");
	const server = serverMetadataSchema.safeParse(
		await getJson(fetch, `${issuer}/.well-known/openid-configuration`),
	);

	if (!server.success || server.data.issuer.replace(/\/+$/, "") !== issuer)
		throw new OAuthError("The sign-in server's metadata does not match the API.");

	const methods = server.data.code_challenge_methods_supported;

	if (methods && !methods.includes("S256"))
		throw new OAuthError("The sign-in server does not support PKCE with S256.");

	return {
		issuer: server.data.issuer,
		resource: expectedResource,
		authorizationEndpoint: checkedEndpoint(
			server.data.authorization_endpoint,
			issuerOrigin,
			"authorization endpoint",
		),
		tokenEndpoint: checkedEndpoint(server.data.token_endpoint, issuerOrigin, "token endpoint"),
		revocationEndpoint: server.data.revocation_endpoint
			? checkedEndpoint(server.data.revocation_endpoint, issuerOrigin, "revocation endpoint")
			: undefined,
	};
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256: the challenge is the base64url SHA-256 of the verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

	return base64url(new Uint8Array(digest));
}

export function authorizationUrl(
	endpoints: OAuthEndpoints,
	request: { redirectUri: string; state: string; challenge: string },
): string {
	const url = new URL(endpoints.authorizationEndpoint);

	url.search = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: request.redirectUri,
		scope: SCOPES.join(" "),
		state: request.state,
		code_challenge: request.challenge,
		code_challenge_method: "S256",
		resource: endpoints.resource,
	}).toString();

	return url.href;
}

/**
 * Checks the browser's redirect back to the CLI. `state` must match (RFC 6749 §10.12), and when the
 * server names itself with `iss` it must be the issuer the CLI asked (RFC 9207, mix-up attacks).
 */
export function authorizationCode(
	params: URLSearchParams,
	expected: { state: string; issuer: string },
): string {
	if (params.get("state") !== expected.state)
		throw new OAuthError("The sign-in response did not match this request. Nothing was saved.");

	const issuer = params.get("iss");

	if (issuer !== null && issuer.replace(/\/+$/, "") !== expected.issuer.replace(/\/+$/, ""))
		throw new OAuthError("The sign-in response came from a different server. Nothing was saved.");

	const error = params.get("error");

	if (error !== null) {
		const reason = params.get("error_description") ?? error;

		throw new OAuthError(
			error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed: ${reason}`,
		);
	}

	const code = params.get("code");

	if (!code) throw new OAuthError("The sign-in response had no authorization code.");

	return code;
}

/**
 * The address the browser was sent to, pasted by hand. Over SSH the browser runs on another
 * computer, so its redirect to 127.0.0.1 cannot reach the CLI; the user copies the address from the
 * error page instead. It must be this CLI's own redirect URI; `state` and PKCE are checked as usual.
 */
export function pastedRedirect(text: string, redirectUri: string): URLSearchParams | null {
	let url: URL;

	try {
		url = new URL(text.trim());
	} catch {
		return null;
	}

	const expected = new URL(redirectUri);

	return url.origin === expected.origin && url.pathname === expected.pathname ? url.searchParams : null;
}

/** Thrown when the server refuses a refresh token, so the user has to sign in again. */
export class SignInExpiredError extends OAuthError {}

async function tokenRequest(
	fetch: OAuthFetch,
	endpoint: string,
	form: Record<string, string>,
): Promise<TokenResponse> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		redirect: "error",
	});
	const body = z.json().safeParse(await response.json().catch(() => null)).data ?? null;

	if (!response.ok) {
		const failure = tokenErrorSchema.safeParse(body).data;

		if (failure?.error === "invalid_grant")
			throw new SignInExpiredError("Your BetterOff sign-in has expired or was revoked.");

		throw new OAuthError(
			`The sign-in server refused the request (${failure?.error ?? `HTTP ${response.status}`}).`,
		);
	}

	const tokens = tokenResponseSchema.safeParse(body);

	if (!tokens.success) throw new OAuthError("The sign-in server sent an unexpected token response.");

	return tokens.data;
}

export function exchangeCode(
	fetch: OAuthFetch,
	endpoints: OAuthEndpoints,
	request: { code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
	return tokenRequest(fetch, endpoints.tokenEndpoint, {
		grant_type: "authorization_code",
		code: request.code,
		code_verifier: request.verifier,
		redirect_uri: request.redirectUri,
		client_id: CLIENT_ID,
		resource: endpoints.resource,
	});
}

export function refreshTokens(
	fetch: OAuthFetch,
	request: { tokenEndpoint: string; refreshToken: string; resource: string },
): Promise<TokenResponse> {
	return tokenRequest(fetch, request.tokenEndpoint, {
		grant_type: "refresh_token",
		refresh_token: request.refreshToken,
		client_id: CLIENT_ID,
		resource: request.resource,
	});
}

/**
 * RFC 7009. Revoking the refresh token ends the whole grant. BetterOff answers 400 `invalid_request`
 * for a token it no longer knows, which means the sign-in had already ended.
 */
export async function revokeToken(
	fetch: OAuthFetch,
	request: { revocationEndpoint: string; refreshToken: string },
): Promise<"revoked" | "already-ended" | "failed"> {
	const response = await fetch(request.revocationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token: request.refreshToken,
			token_type_hint: "refresh_token",
			client_id: CLIENT_ID,
		}).toString(),
		redirect: "error",
	});

	if (response.ok) return "revoked";

	const failure = tokenErrorSchema.safeParse(await response.json().catch(() => null)).data;

	return response.status === 400 &&
		(failure?.error === "invalid_request" || failure?.error === "invalid_grant")
		? "already-ended"
		: "failed";
}
