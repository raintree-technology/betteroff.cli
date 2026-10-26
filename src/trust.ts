import { X509Certificate } from "node:crypto";
import bundle from "./ca.pem" with { type: "text" };

/**
 * Bun 1.4.3 still trusts the distrusted eMudhra roots. The CLI sends an API token, so its requests
 * use this Mozilla root snapshot (Homebrew ca-certificates 2026-10-20) instead of Bun's built-in
 * store. Refresh the snapshot when Mozilla's roots change, and drop it once Bun ships without them.
 */
const DISTRUSTED_ROOTS = new Set([
	"D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4",
	"86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
]);

export function trustedCertificates(pem: string): string[] {
	const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);

	if (!certificates?.length) throw new Error("TLS CA bundle is empty");

	for (const certificate of certificates) {
		const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(":", "");

		if (DISTRUSTED_ROOTS.has(fingerprint))
			throw new Error("TLS CA bundle contains a distrusted root");
	}

	return certificates;
}

export const caBundle = trustedCertificates(bundle);
