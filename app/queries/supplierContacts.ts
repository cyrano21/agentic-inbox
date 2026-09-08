// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useKumoToastManager } from "@cloudflare/kumo";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useSupplierContacts(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId
			? queryKeys.supplierContacts.list(mailboxId)
			: ["supplier-contacts", "_disabled"],
		queryFn: () => api.listSupplierContacts(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useSetSupplierStatus(mailboxId: string | undefined) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, status }: { email: string; status: string }) =>
			api.setSupplierContactStatus(mailboxId!, email, status),
		onSuccess: () => {
			if (mailboxId) {
				qc.invalidateQueries({ queryKey: queryKeys.supplierContacts.list(mailboxId) });
			}
		},
	});
}

export function useRequestSupplierDraft(mailboxId: string | undefined) {
	const qc = useQueryClient();
	const toastManager = useKumoToastManager();
	return useMutation({
		mutationFn: ({ email, emailId }: { email: string; emailId: string }) =>
			api.requestSupplierDraft(mailboxId!, email, emailId),
		onSuccess: () => {
			toastManager.add({ title: "Brouillon préparé par l'agent — dossier Brouillons" });
			if (mailboxId) {
				qc.invalidateQueries({ queryKey: queryKeys.supplierContacts.list(mailboxId) });
			}
		},
		onError: () => {
			toastManager.add({
				title: "Échec : l'agent n'a pas pu préparer le brouillon",
				variant: "error",
			});
		},
	});
}
