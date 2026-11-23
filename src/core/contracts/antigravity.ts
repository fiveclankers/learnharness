export const ANTIGRAVITY_PROVIDER = "antigravity";
export const ANTIGRAVITY_API = "antigravity-acp";
export const ANTIGRAVITY_CACHE_TTL_MS = 60_000;

export interface AntigravityModelSummary {
	id: string;
	name: string;
}

export interface AntigravityStatus {
	installed: boolean;
	binary: string | null;
	enabled: boolean;
	allowBackgroundUse: boolean;
	signedIn: boolean;
	signingIn: boolean;
	connected: boolean;
	models: AntigravityModelSummary[];
	lastRefreshedAt: number | null;
	error: string | null;
	browserAction?: { id: string };
	needsManualCallback?: boolean;
}

export type AntigravityAction =
	| { action: "refresh" }
	| { action: "enable"; enabled: boolean }
	| { action: "consent"; allowBackgroundUse: boolean }
	| { action: "signIn" }
	| { action: "cancelSignIn" }
	| { action: "submitCallback"; url: string };
