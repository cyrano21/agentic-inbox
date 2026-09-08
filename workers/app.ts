// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail, retryOnDoReset } from "./index";
import { sendEmail } from "./email-sender";
import { Folders } from "../shared/folders";
import { EmailMCP } from "./mcp";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env }>();

// Cloudflare Access JWT validation middleware (production only)
app.use("*", async (c, next) => {
	// Skip validation in development
	if (import.meta.env.DEV) {
		return next();
	}

	const { POLICY_AUD, TEAM_DOMAIN } = c.env;

	// Fail closed in production if Access is not configured.
	if (!POLICY_AUD || !TEAM_DOMAIN) {
		return c.text(
			"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
			500,
		);
	}

	const token = c.req.header("cf-access-jwt-assertion");
	if (!token) {
		return c.text("Missing required CF Access JWT", 403);
	}

	try {
		const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
		const JWKS = createRemoteJWKSet(certsUrl);
		await jwtVerify(token, JWKS, {
			issuer,
			audience: POLICY_AUD,
		});
	} catch {
		return c.text("Invalid or expired Access token", 403);
	}

	// Authorization model note: once a teammate passes the shared Cloudflare
	// Access policy, they can access all mailboxes in this app by design.
	return next();
});

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });
app.all("/mcp", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});
app.all("/mcp/*", async (c) => {
	return mcpHandler.fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
// [03] Résumé quotidien : chaque matin, liste des e-mails non lus envoyée à SUMMARY_TO.
async function dailyDigest(env: Env, ctx: ExecutionContext) {
	const summaryTo = (env as { SUMMARY_TO?: string }).SUMMARY_TO;
	if (!summaryTo) {
		console.log("Digest skipped: SUMMARY_TO not set");
		return;
	}
	const listing = await env.BUCKET.list({ prefix: "mailboxes/" });
	for (const obj of listing.objects) {
		const mailboxId = obj.key.replace(/^mailboxes\//, "").replace(/\.json$/, "");
		try {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
			const emails = (await retryOnDoReset(() =>
				stub.getEmails({ folder: Folders.INBOX, limit: 50, page: 1, sortColumn: "date", sortDirection: "DESC" }),
			)) as Array<{ subject?: string | null; sender?: string | null; read?: boolean }>;
			const unread = (emails || []).filter((e) => !e.read);
			if (unread.length === 0) {
				console.log(`Digest ${mailboxId}: no unread emails`);
				continue;
			}
			const lines = unread.map(
				(e, i) => `${i + 1}. ${e.subject || "(sans objet)"} — de ${e.sender || "?"}`,
			);
			const text =
				`Bonjour !\n\nVoici votre résumé quotidien de ${mailboxId}:\n\n` +
				lines.join("\n") +
				`\n\nTotal : ${unread.length} e-mail(s) non lu(s).` +
				`\n\n→ Ouvrez l'app : https://agentic-inbox.louiscyrano.workers.dev`;
			await sendEmail(env.EMAIL, {
				to: summaryTo,
				from: { email: mailboxId, name: "Agent Orchidy" },
				subject: `☀️ Résumé quotidien — ${unread.length} e-mail(s) non lu(s)`,
				text,
			});
			console.log(`Digest ${mailboxId}: summary sent (${unread.length} unread) → ${summaryTo}`);
		} catch (e) {
			console.error(`Digest error for ${mailboxId}:`, (e as Error).message);
		}
	}
}

export default {
	fetch: app.fetch,
	async scheduled(
		_event: unknown,
		env: Env,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(dailyDigest(env, ctx));
	},
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
