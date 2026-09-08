// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [isImporting, setIsImporting] = useState(false);
	const [importResult, setImportResult] = useState<string | null>(null);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	// Import .eml files (Zoho/Thunderbird export) in batches of 20 to stay under
	// the Workers free-plan subrequest limit per request.
	const handleImport = async (fileList: FileList | null) => {
		if (!fileList || fileList.length === 0 || !mailboxId) return;
		setIsImporting(true);
		setImportResult(null);
		const files = Array.from(fileList);
		let imported = 0, skipped = 0;
		const BATCH = 20;
		try {
			for (let i = 0; i < files.length; i += BATCH) {
				const fd = new FormData();
				fd.append("folder", "inbox");
				for (const f of files.slice(i, i + BATCH)) fd.append("files", f);
				const res = await fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/import`, {
					method: "POST",
					body: fd,
				});
				const json = await res.json().catch(() => ({})) as { error?: string; imported?: number; skipped?: number };
				if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
				imported += json.imported ?? 0;
				skipped += json.skipped ?? 0;
			}
			setImportResult(`${imported} imported · ${skipped} skipped (duplicates or errors)`);
			toastManager.add({ title: `${imported} email(s) imported` });
		} catch (e) {
			toastManager.add({
				title: "Import failed",
				description: (e as Error).message,
				variant: "error",
			});
		} finally {
			setIsImporting(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Import emails (.eml) */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-2">
						Import emails
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Import your old emails (Zoho, Gmail Takeout, Thunderbird export) as
						.eml files into this mailbox's inbox. Duplicates (same Message-ID)
						are skipped automatically, so you can re-run an import safely.
					</p>
					<input
						ref={fileInputRef}
						type="file"
						accept=".eml,message/rfc822"
						multiple
						className="hidden"
						onChange={(e) => handleImport(e.target.files)}
					/>
					<div className="flex items-center gap-3">
						<Button
							variant="secondary"
							loading={isImporting}
							onClick={() => fileInputRef.current?.click()}
						>
							Choose .eml files…
						</Button>
						{importResult && (
							<span className="text-xs text-kumo-subtle">{importResult}</span>
						)}
					</div>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
