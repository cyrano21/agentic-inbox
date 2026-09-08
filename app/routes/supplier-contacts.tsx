// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge } from "@cloudflare/kumo";
import { UsersIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useSupplierContacts } from "~/queries/supplierContacts";

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

export default function SupplierContactsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: contacts = [], isLoading } = useSupplierContacts(mailboxId);

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto max-w-3xl p-6">
				<div className="mb-6 flex items-center gap-3">
					<UsersIcon className="size-6 text-kumo-strong" />
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

				{isLoading ? (
					<p className="text-sm text-kumo-strong">Chargement…</p>
				) : contacts.length === 0 ? (
					<div className="rounded-lg border border-kumo-line p-8 text-center">
						<p className="text-sm text-kumo-strong">
							Aucun fournisseur enregistré pour le moment. Le carnet se
							remplit automatiquement quand un e-mail d'un fournisseur
							arrive dans le dossier « Fournisseurs ».
						</p>
					</div>
				) : (
					<div className="overflow-hidden rounded-lg border border-kumo-line">
						<table className="w-full text-sm">
							<thead className="bg-kumo-tint text-left text-kumo-strong">
								<tr>
									<th className="px-4 py-2.5 font-medium">Fournisseur</th>
									<th className="px-4 py-2.5 font-medium">Dernier objet</th>
									<th className="px-4 py-2.5 font-medium">Dossier</th>
									<th className="px-4 py-2.5 font-medium">E-mails</th>
									<th className="px-4 py-2.5 font-medium">Vu le</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-kumo-line">
								{contacts.map((ct) => (
									<tr key={ct.email} className="hover:bg-kumo-tint/50">
										<td className="px-4 py-2.5">
											<div className="font-medium text-kumo-default">
												{ct.name || ct.email.split("@")[0]}
											</div>
											<div className="text-kumo-strong">{ct.email}</div>
										</td>
										<td className="max-w-[240px] truncate px-4 py-2.5 text-kumo-default">
											{ct.last_subject || "—"}
										</td>
										<td className="px-4 py-2.5">
											{ct.last_folder ? (
												<Badge variant="secondary">{ct.last_folder}</Badge>
											) : (
												<span className="text-kumo-strong">—</span>
											)}
										</td>
										<td className="px-4 py-2.5 tabular-nums">
											{ct.email_count}
										</td>
										<td className="px-4 py-2.5 text-kumo-strong">
											{formatDate(ct.last_seen)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
