// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input } from "@cloudflare/kumo";
import {
	ChatCircleDotsIcon,
	EnvelopeSimpleIcon,
	MagnifyingGlassIcon,
	UsersIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { useSupplierContacts } from "~/queries/supplierContacts";
import { useUIStore } from "~/hooks/useUIStore";

function formatDate(iso: string | null): string {
	if (!iso) return "—";
	try {
		return new Date(iso).toLocaleDateString("fr-FR", {
			day: "2-digit",
			month: "short",
			year: "numeric",
		});
	} catch {
		return iso.slice(0, 10);
	}
}

type SortKey = "recent" | "count" | "name";

export default function SupplierContactsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: contacts = [], isLoading } = useSupplierContacts(mailboxId);
	const openComposeModal = useUIStore((s) => s.openComposeModal);
	const [query, setQuery] = useState("");
	const [sortKey, setSortKey] = useState<SortKey>("recent");

	const stats = useMemo(() => {
		const totalEmails = contacts.reduce((a, c) => a + (c.email_count || 0), 0);
		const domains = new Set(contacts.map((c) => c.email.split("@")[1] || ""));
		return { suppliers: contacts.length, totalEmails, domains: domains.size };
	}, [contacts]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const base = q
			? contacts.filter(
					(c) =>
						c.email.toLowerCase().includes(q) ||
						(c.name || "").toLowerCase().includes(q) ||
						(c.last_subject || "").toLowerCase().includes(q),
				)
			: contacts;
		const sorted = [...base];
		if (sortKey === "count") sorted.sort((a, b) => b.email_count - a.email_count);
		else if (sortKey === "name") sorted.sort((a, b) => a.email.localeCompare(b.email));
		// "recent" = déjà trié par last_seen DESC côté API
		return sorted;
	}, [contacts, query, sortKey]);

	const handleReply = (email: string, subject: string | null) => {
		openComposeModal({
			mode: "new",
			prefill: {
				to: email,
				subject: subject ? (subject.startsWith("Re:") ? subject : `Re: ${subject}`) : "",
				body: "Bonjour,\n\n",
			},
		});
	};

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-4xl p-6">
				{/* En-tête */}
				<div className="mb-6 flex items-center gap-3">
					<div className="flex size-10 items-center justify-center rounded-lg bg-kumo-tint">
						<UsersIcon className="size-5 text-kumo-strong" />
					</div>
					<div>
						<h1 className="text-xl font-semibold text-kumo-default">
							Carnet fournisseurs
						</h1>
						<p className="text-sm text-kumo-strong">
							Expéditeurs connus, dossier attribué et dernier échange —
							alimenté automatiquement par le tri des e-mails.
						</p>
					</div>
				</div>

				{/* Cartes de statistiques */}
				<div className="mb-6 grid grid-cols-3 gap-3">
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<div className="text-2xl font-semibold text-kumo-default tabular-nums">
							{stats.suppliers}
						</div>
						<div className="text-xs text-kumo-strong">Fournisseurs connus</div>
					</div>
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<div className="text-2xl font-semibold text-kumo-default tabular-nums">
							{stats.totalEmails}
						</div>
						<div className="text-xs text-kumo-strong">E-mails échangés</div>
					</div>
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<div className="text-2xl font-semibold text-kumo-default tabular-nums">
							{stats.domains}
						</div>
						<div className="text-xs text-kumo-strong">Domaines différents</div>
					</div>
				</div>

				{/* Barre outils : recherche + tri */}
				<div className="mb-4 flex items-center gap-2">
					<div className="relative flex-1">
						<MagnifyingGlassIcon
							size={16}
							className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle"
						/>
						<Input
							type="text"
							size="sm"
							placeholder="Rechercher un fournisseur, un objet…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
					<div className="flex shrink-0 rounded-md border border-kumo-line p-0.5">
						{(
							[
								["recent", "Récents"],
								["count", "Volume"],
								["name", "A→Z"],
							] as [SortKey, string][]
						).map(([key, label]) => (
							<button
								key={key}
								type="button"
								onClick={() => setSortKey(key)}
								className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
									sortKey === key
										? "bg-kumo-fill text-kumo-default"
										: "text-kumo-strong hover:text-kumo-default"
								}`}
							>
								{label}
							</button>
						))}
					</div>
				</div>

				{/* Liste */}
				{isLoading ? (
					<p className="py-8 text-center text-sm text-kumo-strong">Chargement…</p>
				) : filtered.length === 0 ? (
					<div className="rounded-lg border border-kumo-line p-8 text-center">
						<p className="text-sm text-kumo-strong">
							{query
								? "Aucun fournisseur ne correspond à cette recherche."
								: "Aucun fournisseur enregistré pour le moment. Le carnet se remplit automatiquement quand un e-mail d'un fournisseur arrive dans le dossier « Fournisseurs »."}
						</p>
					</div>
				) : (
					<div className="space-y-2">
						{filtered.map((ct) => (
							<div
								key={ct.email}
								className="group flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base p-4 transition-colors hover:bg-kumo-tint/50"
							>
								{/* Avatar initiale */}
								<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-default">
									{(ct.name || ct.email).charAt(0).toUpperCase()}
								</div>

								{/* Infos principales */}
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="truncate font-medium text-kumo-default">
											{ct.name || ct.email.split("@")[0]}
										</span>
										{ct.last_folder && (
											<Badge variant="secondary">{ct.last_folder}</Badge>
										)}
									</div>
									<div className="truncate text-sm text-kumo-strong">
										{ct.email}
									</div>
									{ct.last_subject && (
										<div className="mt-1 truncate text-sm text-kumo-strong">
											<EnvelopeSimpleIcon size={13} className="mr-1 inline align-[-2px]" />
											{ct.last_subject}
										</div>
									)}
								</div>

								{/* Métriques */}
								<div className="hidden shrink-0 text-right sm:block">
									<div className="text-sm font-medium text-kumo-default tabular-nums">
										{ct.email_count} e-mail{ct.email_count > 1 ? "s" : ""}
									</div>
									<div className="text-xs text-kumo-strong">
										vu le {formatDate(ct.last_seen)}
									</div>
								</div>

								{/* Action : réponse en 1 clic */}
								<Button
									variant="secondary"
									size="sm"
									icon={<ChatCircleDotsIcon size={14} />}
									onClick={() => handleReply(ct.email, ct.last_subject)}
									aria-label={`Répondre à ${ct.email}`}
								>
									Répondre
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
