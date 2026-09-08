// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	// Local-dev proxy vars (set in .dev.vars, absent in production where the
	// Workers AI fallback is used). Optional: llm.ts checks all three.
	LLM_BASE_URL?: string;
	LLM_API_KEY?: string;
	LLM_MODEL?: string;
}
