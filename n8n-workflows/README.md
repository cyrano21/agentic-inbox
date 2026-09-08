# Workflows n8n — Orchidy Mail

Workflows hébergés sur `https://n8n.orchidy.fr`, exportés pour versionnement.

## Fichiers

| Fichier | Workflow n8n | Déclencheur | Rôle |
|---|---|---|---|
| `alerte-fournisseurs.json` | 📧 Alerte fournisseurs — Orchidy | toutes les 15 min | Alertes Gmail nouveaux e-mails fournisseurs (louis@ + olivier@), tri auto de secours (inbox → Fournisseurs), relances > 72 h |
| `resume-hebdo-fournisseurs.json` | 📅 Résumé hebdo fournisseurs — Orchidy | lundi 08:00 UTC | Récapitulatif hebdo groupé par boîte + fournisseur, envoyé sur Gmail |

## Ré-importer

1. n8n → Workflows → Import from file
2. Les placeholders `__CF_ACCESS_CLIENT_ID__` / `__CF_ACCESS_CLIENT_SECRET__`
   (en-têtes CF-Access des nœuds HTTP) sont à remplacer par les vraies valeurs
   du service token Cloudflare Access (stockées dans le gestionnaire de secrets,
   jamais committées).
3. Activer le workflow après import.

## Secrets

Aucun secret n'est committé : les service tokens Access sont remplacés par des
placeholders à l'export. Voir `wrangler.jsonc` (vars non sensibles) et le
gestionnaire de mots de passe pour les credentials réels.

## Veille secrets (VPS)

Le scanner `scripts/check-secrets.mjs` s'exécute **toutes les heures sur le VPS
Contabo** (cron root : `/usr/local/bin/orchidy-secrets-watch.sh`, log dans
`/var/log/orchidy-secrets.log`) :

1. `git pull` du fork dans `/opt/orchidy-mail-tools`
2. Scan de tous les fichiers suivis
3. En cas de détection : alerte e-mail sur Gmail via l'app (1 max par
   empreinte de secret, pas de spam)

Pas de GitHub Action : l'infrastructure reste sur le VPS (Coolify/cron).
