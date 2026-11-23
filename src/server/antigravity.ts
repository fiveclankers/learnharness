import { configureAppHeldEnvVars } from "../agent/antigravity-acp/env.ts";
import {
	cancelAntigravitySignIn,
	configureAntigravityPreferences,
	notifyAntigravityPolicyChange,
	refreshAntigravity,
	startAntigravitySignIn,
	submitAntigravityCallback,
	takeAntigravityBrowserAction,
	type AntigravityPreferences,
} from "../agent/antigravity-acp/state.ts";
import { authStore } from "../store/auth.ts";
import { settingsStore } from "../store/settings.ts";
import { readBoundedJson } from "./custom-provider-body.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

const HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

export function readAntigravityPreferences(): AntigravityPreferences {
	const raw = settingsStore.readSettings()?.antigravity;
	return {
		enabled: raw?.enabled === true,
		allowBackgroundUse: raw?.allowBackgroundUse !== false,
	};
}

let wired = false;
export function initAntigravityServer(): void {
	if (wired) return;
	wired = true;
	initAuthEnv();
	configureAppHeldEnvVars(() => Object.keys(authStore.authVars()));
	configureAntigravityPreferences(readAntigravityPreferences);
}

function authorized(request: Request): boolean {
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("x-learnharness-antigravity") !== "1") return false;
	if (request.headers.get("sec-fetch-site") === "cross-site") return false;
	const supplied = request.headers.get("origin");
	return request.method === "GET" ? !supplied || supplied === origin : supplied === origin;
}

function errorResponse(message: string, status: number): Response {
	return Response.json({ error: message }, { status, headers: HEADERS });
}

export async function antigravityStatusResponse(request: Request): Promise<Response> {
	initAntigravityServer();
	if (request.method !== "GET" || !authorized(request)) {
		return errorResponse("Antigravity controls require a same-origin LearnHarness request.", 403);
	}
	const force = new URL(request.url).searchParams.get("force") === "1";
	const status = await refreshAntigravity(force);
	return Response.json(status, { headers: HEADERS });
}

export async function antigravityMutationResponse(request: Request): Promise<Response> {
	initAntigravityServer();
	if (request.method !== "POST" || !authorized(request)) {
		return errorResponse("Antigravity controls require a same-origin LearnHarness request.", 403);
	}
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
		return errorResponse("Expected JSON.", 415);
	}
	try {
		const raw = await readBoundedJson(request, 16_384);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return errorResponse("Invalid JSON body.", 400);
		}
		const body = raw as Record<string, unknown>;
		switch (body.action) {
			case "refresh":
				return Response.json(await refreshAntigravity(true), { headers: HEADERS });
			case "enable": {
				if (typeof body.enabled !== "boolean") return errorResponse("enabled must be a boolean.", 400);
				const current = settingsStore.readSettings() ?? { version: 1 };
				const next = { ...current.antigravity, enabled: body.enabled };
				settingsStore.writeSettings({ ...current, antigravity: next });
				notifyAntigravityPolicyChange();
				const status = await refreshAntigravity(true);
				return Response.json(status, { headers: HEADERS });
			}
			case "consent": {
				if (typeof body.allowBackgroundUse !== "boolean") {
					return errorResponse("allowBackgroundUse must be a boolean.", 400);
				}
				const current = settingsStore.readSettings() ?? { version: 1 };
				const next = { ...current.antigravity, allowBackgroundUse: body.allowBackgroundUse };
				settingsStore.writeSettings({ ...current, antigravity: next });
				notifyAntigravityPolicyChange();
				return Response.json(await refreshAntigravity(false), { headers: HEADERS });
			}
			case "signIn": {
				const current = settingsStore.readSettings() ?? { version: 1 };
				if (current.antigravity?.enabled !== true) {
					settingsStore.writeSettings({ ...current, antigravity: { ...current.antigravity, enabled: true } });
					notifyAntigravityPolicyChange();
				}
				return Response.json(await startAntigravitySignIn(), { headers: HEADERS });
			}
			case "cancelSignIn":
				return Response.json(cancelAntigravitySignIn(), { headers: HEADERS });
			case "submitCallback": {
				if (typeof body.url !== "string" || !body.url.trim()) {
					return errorResponse("url must be a non-empty string.", 400);
				}
				const status = await submitAntigravityCallback(body.url);
				return Response.json(status, { headers: HEADERS });
			}
			default:
				return errorResponse("Unsupported Antigravity action.", 400);
		}
	} catch (error) {
		return errorResponse(error instanceof Error ? error.message : "Antigravity request failed.", 400);
	}
}

export async function antigravityBrowserResponse(request: Request): Promise<Response> {
	initAntigravityServer();
	const origin = subscriptionRequestOrigin(request);
	if (!origin || request.headers.get("sec-fetch-site") === "cross-site") {
		return errorResponse("Open sign-in from LearnHarness.", 403);
	}
	const id = new URL(request.url).searchParams.get("id");
	if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
		return errorResponse("This sign-in action is no longer available.", 410);
	}
	const target = takeAntigravityBrowserAction(id);
	if (!target) {
		return errorResponse("This sign-in action is no longer available.", 410);
	}
	return new Response(null, { status: 303, headers: { ...HEADERS, Location: target } });
}
