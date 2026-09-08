// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	ChatCircleDotsIcon,
	EnvelopeSimpleIcon,
	MagnifyingGlassIcon,
	RobotIcon,
	UsersIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import {
	useRequestSupplierDraft,
	useSetSupplierStatus,
	useSupplierContacts,
} from "~/queries/supplierContacts";
import { useUIStore } from "~/hooks/useUIStore";
import type { SupplierContact } from "~/types";

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

const STATUS_OPTIONS: Array<{ value: string; label: string; variant: "outline" | "secondary" }> = [
	{ value: "actif", label: "Actif", variant: "outline" },
	{ value: "negociation", label: "En négociation", variant: "outline" },
	{ value: "dormant", label: "Dormant", variant: "secondary" },
];

function StatusBadge({ status }: { status: string }) {
	const opt = STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];
	return <Badge variant={opt.variant}>{opt.label}</Badge>;
}

export default function SupplierContactsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: contacts = [], isLoading } = useSupplierContacts(mailboxId);
	const openComposeModal = useUIStore((s) => s.openComposeModal);
	const setStatusMutation = useSetSupplierStatus(mailboxId);
	const requestDraftMutation = useRequestSupplierDraft(mailboxId);
	const [query, setQuery] = useState("");
	const [sortKey, setSortKey] = useState<SortKey>("recent");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [statusMenuFor, setStatusMenuFor] = useState<string | null>(null);

	const stats = useMemo(() => {
		const totalEmails = contacts.reduce((a, c) => a + (c.email_count || 0), 0);
		const domains = new Set(contacts.map((c) => c.email.split("@")[1] || ""));
		const actifs = contacts.filter((c) => (c.status || "actif") === "actif").length;
		return { suppliers: contacts.length, totalEmails, domains: domains.size, actifs };
	}, [contacts]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		let base = q
			? contacts.filter(
					(c) =>
						c.email.toLowerCase().includes(q) ||
						(c.name || "").toLowerCase().includes(q) ||
						(c.last_subject || "").toLowerCase().includes(q),
				)
			: contacts;
		if (statusFilter !== "all") {
			base = base.filter((c) => (c.status || "actif") === statusFilter);
		}
		const sorted = [...base];
		if (sortKey === "count") sorted.sort((a, b) => b.email_count - a.email_count);
		else if (sortKey === "name") sorted.sort((a, b) => a.email.localeCompare(b.email));
		return sorted;
	}, [contacts, query, sortKey, statusFilter]);

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

	const handleAgentDraft = (ct: SupplierContact) => {
		const last = ct.recent_emails?.[0];
		if (!last) return;
		requestDraftMutation.mutate({ email: ct.email, emailId: last.id });
	};

	const toggleExpand = (email: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(email)) next.delete(email);
			else next.add(email);
			return next;
		});
	};

	const handleStatusChange = (email: string, status: string) => {
		setStatusMutation.mutate({ email, status });
		setStatusMenuFor(null);
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
							Expéditeurs connus, statut de la relation et derniers échanges —
							alimenté automatiquement par le tri des e-mails.
						</p>
					</div>
				</div>

				{/* Cartes de statistiques */}
				<div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<div className="text-2xl font-semibold text-kumo-default tabular-nums">
							{stats.suppliers}
						</div>
						<div className="text-xs text-kumo-strong">Fournisseurs</div>
					</div>
					<div className="rounded-lg border border-kumo-line bg-kumo-base p-4">
						<div className="text-2xl font-semibold text-kumo-default tabular-nums">
							{stats.actifs}
						</div>
						<div className="text-xs text-kumo-strong">Relations actives</div>
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
						<div className="text-xs text-kumo-strong">Domaines</div>
					</div>
				</div>

				{/* Barre outils : recherche + statut + tri */}
				<div className="mb-4 flex flex-wrap items-center gap-2">
					<div className="relative min-w-[200px] flex-1">
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
						{(["all", "actif", "negociation", "dormant"] as const).map((key) => (
							<button
								key={key}
								type="button"
								onClick={() => setStatusFilter(key)}
								className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
									statusFilter === key
										? "bg-kumo-fill text-kumo-default"
										: "text-kumo-strong hover:text-kumo-default"
								}`}
							>
								{key === "all"
									? "Tous"
									: STATUS_OPTIONS.find((o) => o.value === key)?.label}
							</button>
						))}
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
							{query || statusFilter !== "all"
								? "Aucun fournisseur ne correspond à ces critères."
								: "Aucun fournisseur enregistré pour le moment. Le carnet se remplit automatiquement quand un e-mail d'un fournisseur arrive dans le dossier « Fournisseurs »."}
						</p>
					</div>
				) : (
					<div className="space-y-2">
						{filtered.map((ct) => {
							const isOpen = expanded.has(ct.email);
							const lastEmail = ct.recent_emails?.[0];
							return (
								<div
									key={ct.email}
									className="rounded-lg border border-kumo-line bg-kumo-base transition-colors hover:bg-kumo-tint/30"
								>
									<div className="flex items-center gap-4 p-4">
										{/* Avatar + dépliage historique */}
										<button
											type="button"
											onClick={() => toggleExpand(ct.email)}
											className="flex shrink-0 items-center gap-2"
											aria-label={isOpen ? "Replier l'historique" : "Déplier l'historique"}
											aria-expanded={isOpen}
										>
											<CaretDownIcon
												size={14}
												className={`text-kumo-subtle transition-transform ${isOpen ? "rotate-180" : ""}`}
											/>
											<span className="flex size-9 items-center justify-center rounded-full bg-kumo-tint text-sm font-semibold text-kumo-default">
												{(ct.name || ct.email).charAt(0).toUpperCase()}
											</span>
										</button>

										{/* Infos principales */}
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="truncate font-medium text-kumo-default">
													{ct.name || ct.email.split("@")[0]}
												</span>
												<StatusBadge status={ct.status || "actif"} />
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

										{/* Actions */}
										<div className="flex shrink-0 items-center gap-1.5">
											<Button
												variant="ghost"
												size="sm"
												icon={<RobotIcon size={14} />}
												loading={requestDraftMutation.isPending && requestDraftMutation.variables?.email === ct.email}
												disabled={!lastEmail}
												onClick={() => handleAgentDraft(ct)}
												aria-label="Demander un brouillon à l'agent"
												title="L'agent prépare un brouillon de réponse dans le fil"
											>
												Agent
											</Button>
											<div className="relative">
												<button
													type="button"
													onClick={() => setStatusMenuFor(statusMenuFor === ct.email ? null : ct.email)}
													className="rounded-md border border-kumo-line px-2 py-1.5 text-xs text-kumo-strong hover:text-kumo-default"
													aria-label="Changer le statut"
												>
													Statut
												</button>
												{statusMenuFor === ct.email && (
													<div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-kumo-line bg-kumo-base p-1 shadow-lg">
														{STATUS_OPTIONS.map((opt) => (
															<button
																key={opt.value}
																type="button"
																onClick={() => handleStatusChange(ct.email, opt.value)}
																className={`block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-kumo-tint ${
																	(ct.status || "actif") === opt.value
																		? "font-semibold text-kumo-default"
																		: "text-kumo-strong"
																}`}
															>
																{opt.label}
															</button>
														))}
													</div>
												)}
											</div>
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
									</div>

									{/* Historique dépliable : 3 derniers échanges */}
									{isOpen && (
										<div className="border-t border-kumo-line px-4 py-3 pl-16">
											<div className="mb-2 text-xs font-semibold uppercase tracking-wider text-kumo-subtle">
												Derniers échanges reçus
											</div>
											{(ct.recent_emails?.length ?? 0) === 0 ? (
												<p className="text-sm text-kumo-strong">
													Aucun échange enregistré.
												</p>
											) : (
												<ul className="space-y-1.5">
													{ct.recent_emails!.map((e) => (
														<li key={e.id} className="flex items-center gap-2 text-sm">
															<span className="w-20 shrink-0 text-kumo-strong tabular-nums">
																{formatDate(e.date)}
															</span>
															<span className={`truncate ${e.read ? "text-kumo-strong" : "font-medium text-kumo-default"}`}>
																{e.subject || "(sans objet)"}
															</span>
															{!e.read && <Badge variant="outline">non lu</Badge>}
														</li>
													))}
												</ul>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
