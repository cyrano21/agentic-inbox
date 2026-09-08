// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";

/**
 * Default mailbox settings — used both for new mailboxes and to repair
 * a corrupted settings file instead of crashing with a 500.
 */
export function defaultMailboxSettings(mailboxId: string) {
	return {
		fromName: mailboxId,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
}

/**
 * Read a mailbox's settings.json from R2. If the file exists but is
 * corrupted (truncated/partial write), log it, overwrite it with defaults
 * and keep serving instead of throwing a 500.
 */
export async function readMailboxSettings(
	bucket: Env["BUCKET"],
	mailboxId: string,
): Promise<Record<string, unknown>> {
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await bucket.get(key);
	if (!obj) return defaultMailboxSettings(mailboxId);
	const raw = await obj.text();
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		console.error(`Corrupted settings file for ${mailboxId} (${raw.length} bytes) — repairing with defaults`);
		const repaired = defaultMailboxSettings(mailboxId);
		await bucket.put(key, JSON.stringify(repaired));
		return repaired;
	}
}

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);
	
	await next();
});
