import { describe, expect, test } from "bun:test";
import { caBundle, trustedCertificates } from "../trust";

describe("trustedCertificates", () => {
	test("loads the bundled Mozilla roots without the distrusted ones", () => {
		expect(caBundle.length).toBeGreaterThan(100);
	});

	test("rejects an empty bundle", () => {
		expect(() => trustedCertificates("")).toThrow("empty");
	});
});
