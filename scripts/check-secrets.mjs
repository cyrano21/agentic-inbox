// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Secret scanner: fails if any tracked file contains a known secret pattern
 * (Cloudflare Access service tokens, API keys, n8n JWTs...).
 *
 * Usage: node scripts/check-secrets.mjs
 * Exit 0 = clean, exit 1 = secrets found (with details).
 */
import { execSync } from "node:child_process";

// Allowed placeholder tokens that may legitimately appear in docs/exports.
const ALLOW = /__CF_ACCESS_CLIENT_(ID|SECRET)__|your[_-]?(api[_-]?key|token)[_-]?here|<[^>]*>/gi;

const SECRET_PATTERNS = [
	// Cloudflare Access service token secret (cfast_ + 40+ base62 chars)
	[/\bcfast_[A-Za-z0-9]{20,}\b/g, "Cloudflare Access client secret"],
	// Cloudflare Access client id (hex32 .access)
	[/\b[0-9a-f]{32}\.access\b/g, "Cloudflare Access client id"],
	// Cloudflare API token
	[/\b[A-Za-z0-9_-]{40}\b(?=.*cloudflare)/gi, "possible Cloudflare API token"],
	// n8n / generic JWT
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT token"],
	// Generic password assignments in code/config
	[/(password|passwd|secret)\s*[:=]\s*['"][^'"]{8,}['"]/gi, "hardcoded password/secret"],
];

const files = execSync("git ls-files", { encoding: "utf8" })
	.split("\n")
	.filter(Boolean)
	// Never scan the scanner itself for JWT-ish test fixtures
	.filter((f) => f !== "scripts/check-secrets.mjs");

let findings = 0;
for (const file of files) {
	let content;
	try {
		content = execSync(`git show "HEAD:${file.replace(/"/g, '\\"')}"`, {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
	} catch {
		continue; // binary or unreadable
	}
	for (const [pattern, label] of SECRET_PATTERNS) {
		const matches = content.match(pattern) || [];
		for (const m of matches) {
			if (ALLOW.test(m)) {
				ALLOW.lastIndex = 0;
				continue;
			}
			ALLOW.lastIndex = 0;
			console.error(`SECRET DETECTED (${label}) in ${file}: ${m.slice(0, 12)}…`);
			findings++;
		}
	}
}

if (findings > 0) {
	console.error(`\n${findings} secret(s) detected. Remove them before committing.`);
	console.error("For n8n-workflows exports, run the export script that replaces secrets with __CF_ACCESS_*__ placeholders.");
	process.exit(1);
}
console.log(`No secrets found (${files.length} files scanned).`);
