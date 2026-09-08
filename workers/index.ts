// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { readMailboxSettings, requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	// EMAIL_ADDRESSES may be a JSON array (wrangler vars) or a comma-separated string
	// (--var CLI / dashboard override). Normalize both to an array.
	const raw = c.env.EMAIL_ADDRESSES;
	const emailAddresses = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(",").map((d) => d.trim()).filter(Boolean)
			: [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddressesRaw = c.env.EMAIL_ADDRESSES;
	const allowedAddresses = (Array.isArray(allowedAddressesRaw)
		? allowedAddressesRaw
		: typeof allowedAddressesRaw === "string"
			? allowedAddressesRaw.split(",").map((d) => d.trim())
			: []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	// readMailboxSettings repairs a corrupted settings file instead of 500-ing
	const settings = await readMailboxSettings(c.env.BUCKET, mailboxId);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Import .eml files (Zoho / Thunderbird export) ------------------
// Multipart form: field "files" (repeatable, one .eml per file), optional
// "folder" (default inbox). Dedup: the original Message-ID becomes the row id,
// so re-importing the same file hits the PRIMARY KEY and is skipped.
app.post("/api/v1/mailboxes/:mailboxId/import", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) return c.json({ error: "Not found" }, 404);
	const form = await c.req.formData();
	const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
	const folder = String(form.get("folder") || Folders.INBOX);
	if (files.length === 0) return c.json({ error: "No files uploaded (field 'files')" }, 400);
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
	let imported = 0, skipped = 0;
	const errors: string[] = [];
	for (const file of files) {
		try {
			const parsed = await new PostalMime().parse(await file.arrayBuffer());
			const extractId = (s: string | undefined) => { if (!s) return null; const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim(); };
			const originalMessageId = extractId(parsed.messageId);
			const id = originalMessageId ?? crypto.randomUUID();
			await retryOnDoReset(() => stub.createEmail(folder, {
				id, subject: parsed.subject || "(no subject)",
				sender: (parsed.from?.address || "unknown@imported").toLowerCase(),
				recipient: (parsed.to || []).map((t) => t.address).filter(Boolean).join(", ") || mailboxId,
				cc: null, bcc: null,
				date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
				body: parsed.html || parsed.text || "",
				in_reply_to: null, email_references: null,
				thread_id: id, message_id: originalMessageId, raw_headers: JSON.stringify(parsed.headers),
			}, []));
			imported++;
		} catch (e) {
			const msg = (e as Error).message || String(e);
			skipped++;
			if (!/UNIQUE/i.test(msg) && errors.length < 5) errors.push(`${file.name}: ${msg}`);
		}
	}
	return c.json({ imported, skipped, total: files.length, errors });
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const slug = slugify(folderId);
	if (!slug) return c.json({ error: "Invalid folder name" }, 400);
	// Custom folders are auto-created on first use (e.g. "Fournisseurs").
	const folders = await c.var.mailboxStub.getFolders();
	if (!folders.some((f: { id: string }) => f.id === slug)) {
		await c.var.mailboxStub.createFolder(slug, folderId.trim(), 1);
	}
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, slug);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

// [FIX] Durable Objects throw "reset because its code was updated" on the first access after each
// deployment — a transient error: the DO re-initializes on the very next request. Retry once so the
// first email after a deploy is not silently lost.
const retryOnDoReset = async <T,>(fn: () => Promise<T>): Promise<T> => {
	try { return await fn(); }
	catch (e) {
		if (/reset/i.test((e as Error).message || "")) {
			console.log("DO reset detected — retrying once in 2s");
			await new Promise((r) => setTimeout(r, 2000));
			return await fn();
		}
		throw e;
	}
};

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddressesRaw = (env.EMAIL_ADDRESSES ?? []) as string[] | string;
	const allowedAddresses = (Array.isArray(allowedAddressesRaw)
		? allowedAddressesRaw
		: typeof allowedAddressesRaw === "string"
			? allowedAddressesRaw.split(",").map((d) => d.trim())
			: []).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = allRecipients.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else { mailboxId = allRecipients[0]; }
	if (!mailboxId) throw new Error("received email with no valid recipient address");

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	// [03 — tri automatique] Heuristic pre-classification before storage:
	// newsletters (List-Unsubscribe) → « Newsletters », machine notifications → « Notifications ».
	const headerVal = (name: string): string => {
		const h = (parsedEmail.headers as unknown as Array<{ key?: string; value?: string }> | undefined)?.find?.(
			(hh) => hh.key?.toLowerCase() === name,
		);
		return typeof h?.value === "string" ? h.value : "";
	};
	const fromAddress = (parsedEmail.from?.address || "").toLowerCase();
	let targetFolder: string = Folders.INBOX;
	// [04 — tri fournisseurs] Known supplier senders → « Fournisseurs ».
	// Matched on the sender domain so replies and notifications from the same
	// suppliers land there too. Takes priority over newsletters/notifications:
	// supplier campaigns belong with supplier conversations.
	const fromDomain = fromAddress.split("@")[1] || "";
	const SUPPLIER_TOKENS = ["prodigi", "bigbuy", "affilae", "brickzonehub", "orderchimp", "imou", "awin"];
	if (SUPPLIER_TOKENS.some((t) => fromDomain.includes(t))) {
		targetFolder = "fournisseurs";
	} else if (headerVal("list-unsubscribe")) {
		targetFolder = "newsletter";
	} else if (/^(no-?reply|donotreply|notifications?|alert)@/.test(fromAddress) || /verification code|verify your email|code de vérification/i.test(parsedEmail.subject || "")) {
		targetFolder = "notifications";
	}
	if (targetFolder !== Folders.INBOX) {
		const FOLDER_NAMES: Record<string, string> = {
			fournisseurs: "Fournisseurs",
			newsletter: "Newsletters",
			notifications: "Notifications",
		};
		const folderName = FOLDER_NAMES[targetFolder] || targetFolder;
		try {
			await retryOnDoReset(() => stub.createFolder(targetFolder, folderName, 0));
			console.log(`Auto-classified email from ${fromAddress} → ${targetFolder}`);
		} catch (e) {
			console.log(`Folder ensure failed (${targetFolder}), falling back to inbox:`, (e as Error).message);
			targetFolder = Folders.INBOX;
		}
	}

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await retryOnDoReset(() => (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined));
		if (subjectThread) threadId = String(subjectThread);
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	try {
		await retryOnDoReset(() => stub.createEmail(targetFolder, {
			id: messageId, subject: parsedEmail.subject || "",
			sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
			cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
			date: new Date().toISOString(), // uses receive time, not the email's Date header
			body: parsedEmail.html || parsedEmail.text || "",
			in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
			thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
		}, attachmentData));
	} catch (storeErr) {
		console.error("Failed to store incoming email:", (storeErr as Error).message);
		throw storeErr;
	}

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	if (targetFolder !== Folders.INBOX) {
		// Newsletters / notifications : pas de brouillon automatique de l'agent.
		return;
	}
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));
}

export { app, receiveEmail, retryOnDoReset };
