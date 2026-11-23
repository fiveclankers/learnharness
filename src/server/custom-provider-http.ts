/** Connect / manual-model / offline-pin / 1-click refresh workflow for multiple
 * OpenAI-compatible endpoints, preserving host request, credential-binding, and
 * optimistic-write boundaries. No secret reaches GET. */
import { createHmac, randomBytes } from "node:crypto";
import { CUSTOM_PROVIDER, customProviderLabel, isCustomProviderId } from "../core/auth-keys.ts";
import {
	CUSTOM_PROVIDER_LABEL_MAX,
	normalizeBaseUrl,
	parseModelIds,
	sanitizeCustomModelOverrides,
	type CustomProviderSettings,
} from "../core/settings.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { readCustomAuth } from "../store/auth.ts";
import { customAuthState, customKeyAuthorized, persistCustomAuth, type CustomAuthState } from "./custom-provider-auth.ts";
import { customProviderId, type CustomAuthBinding } from "../core/custom-provider-auth.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";
import { discoverModels, mergeManualModels, syncCustomProvider } from "./custom-provider.ts";
import { parseCustomModelOverridesBody } from "./settings-body.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";

const revisionKey = Symbol.for("learnharness.custom-provider-revision");
const globals = globalThis as typeof globalThis & { [revisionKey]?: Buffer };
const secret = globals[revisionKey] ??= randomBytes(32);
const failure = (error: string, status = 400) => Response.json({ error }, { status });
const stale = () => failure("Custom configuration or credentials changed. Reload configuration and retry.", 409);

interface ProviderSnapshot {
	id: string;
	label: string;
	cp: CustomProviderSettings;
	auth: CustomAuthState;
}

function snapshot(inspectKey = false) {
	const record = readSettings() ?? { version: 1 };
	const list = record.customProviders ?? [];
	const providers: ProviderSnapshot[] = list.map((cp) => {
		const id = customProviderId(cp);
		const label = customProviderLabel(cp);
		// Keyless never looks up a key for authentication or revision generation.
		// Stored apiKey endpoints and explicit UI apiKey inspections inspect auth.
		const auth = customAuthState(id, inspectKey || cp.authMode === "apiKey");
		return { id, label, cp, auth };
	});
	// Global ETag across the whole endpoint collection (never leaks credentials).
	const etag = `"${createHmac("sha256", secret)
		.update(JSON.stringify(providers.map((p) => [p.id, p.cp, p.auth.binding ?? null, p.auth.readable])))
		.digest("base64url")}"`;
	return { record, providers, etag };
}

function projectProvider(p: ProviderSnapshot) {
	return {
		id: p.id,
		label: p.label,
		baseUrl: p.cp.baseUrl ?? "",
		authMode: p.cp.authMode ?? "keyless",
		models: p.cp.models ?? [],
		overrides: p.cp.overrides ?? {},
		manualModels: p.cp.manualModels ?? [],
		keyPresent: Boolean(p.auth.key),
		keySource: p.auth.source,
		keyReuseRequired: Boolean(p.auth.key) && !customKeyAuthorized(p.cp, p.auth),
	};
}

function response(body: object) {
	return Response.json(body, { headers: { etag: snapshot().etag, "cache-control": "no-store" } });
}

export function customProviderGet(request: Request): Response {
	const inspect = new URL(request.url).searchParams.get("authMode") === "apiKey";
	const s = snapshot(inspect);
	return response({ providers: s.providers.map(projectProvider) });
}

function authorized(request: Request): boolean {
	const desktop = process.env.LH_DESKTOP_SERVER === "1" || Boolean(process.env.LH_DESKTOP_API_SECRET);
	if (desktop) return desktopAPIAuthorized(request.headers);
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	try {
		return origin === subscriptionRequestOrigin(request)
			&& (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
	} catch {
		return false;
	}
}

/** Auth pair FIRST, matching config nonce SECOND with rollback on failure. */
function commit(
	providers: CustomProviderSettings[],
	change?: { id: string; binding?: CustomAuthBinding; fileKey?: string },
): void {
	const latest = readSettings() ?? { version: 1 };
	const oldAuth = change ? readCustomAuth(change.id) : undefined;
	let published = false;
	try {
		if (change && change.binding) {
			persistCustomAuth(change.id, change.binding, change.fileKey);
			published = true;
		}
		const { customProviders: _old, customProvider: _legacy, ...rest } = latest;
		writeSettings(providers.length ? { ...rest, customProviders: providers } : rest);
	} catch {
		if (published && change) {
			try {
				if (oldAuth) persistCustomAuth(change.id, oldAuth.binding, oldAuth.fileKey());
				else persistCustomAuth(change.id, undefined, undefined);
			} catch {
				// durable nonce mismatch fails closed after restart
			}
		}
		throw new Error("Unable to save custom configuration. Reload configuration and retry.");
	}
	syncCustomProvider();
}

function withProvider(providers: CustomProviderSettings[], next: CustomProviderSettings): CustomProviderSettings[] {
	const targetId = customProviderId(next);
	const index = providers.findIndex((cp) => customProviderId(cp) === targetId);
	if (index < 0) return [...providers, next];
	return providers.map((cp, i) => (i === index ? next : cp));
}

export async function customProviderMutation(request: Request): Promise<Response> {
	if (!authorized(request)) return failure("Custom configuration requires a trusted same-origin request.", 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
		return failure("JSON content-type is required.", 415);
	}
	try {
		const body = await readBoundedJson(request, 64 * 1024, request.method === "DELETE");
		if (!body || typeof body !== "object" || Array.isArray(body)) return failure("Invalid JSON body");
		const raw = body as Record<string, unknown>;
		const before = snapshot(raw.authMode === "apiKey");
		if (before.providers.some((p) => !p.auth.readable)) {
			return failure("Custom authorization storage is unavailable. No changes were saved.", 500);
		}
		if (request.headers.get("if-match") !== before.etag) return stale();

		const requestedId = typeof raw.id === "string" && raw.id ? raw.id : undefined;
		if (requestedId && !isCustomProviderId(requestedId)) return failure("Unknown custom endpoint id.", 404);
		const current = requestedId ? before.providers.find((p) => p.id === requestedId) : undefined;

		if (request.method === "DELETE") {
			const id = requestedId ?? CUSTOM_PROVIDER.id;
			if (!before.providers.some((p) => p.id === id)) return failure("No such custom endpoint.", 404);
			commit(
				before.providers.filter((p) => p.id !== id).map((p) => p.cp),
				{ id, binding: { version: 1, id: randomBytes(16).toString("hex"), authMode: "disabled" } },
			);
			return response({ ok: true });
		}

		if (request.method === "PATCH") {
			if (!current) return failure("No custom endpoint configured", 409);
			const parsed = parseCustomModelOverridesBody(raw);
			if (!parsed.ok) return failure(parsed.error);
			const overrides = sanitizeCustomModelOverrides(parsed.settings, current.cp.models?.map((m) => m.id));
			commit(withProvider(before.providers.map((p) => p.cp), { ...current.cp, id: current.id, overrides }));
			return response({ ok: true, overrides });
		}

		if (request.method !== "POST") return failure("Unsupported method", 405);
		if (requestedId && !current) return failure("No such custom endpoint.", 404);

		const base = normalizeBaseUrl(typeof raw.baseUrl === "string" ? raw.baseUrl : "");
		if (!base) return failure("Base URL must be http(s), with no credentials, query or fragment.");
		if (raw.authMode !== "keyless" && raw.authMode !== "apiKey") {
			return failure("Choose Keyless or API key authentication.");
		}
		const authMode = raw.authMode;
		if (raw.key !== undefined && typeof raw.key !== "string") return failure("API key must be a string.");
		const supplied = typeof raw.key === "string" ? raw.key.trim() : undefined;
		if (authMode === "apiKey" && supplied === "") return failure("Choose Keyless to clear authentication.");

		let label = customProviderLabel(current?.cp);
		if (raw.label !== undefined) {
			if (typeof raw.label !== "string") return failure("Endpoint name must be a string.");
			label = raw.label.trim().slice(0, CUSTOM_PROVIDER_LABEL_MAX);
			if (!label) return failure("Give the endpoint a name.");
		}

		const creating = !requestedId;
		const id = requestedId ?? `custom-${randomBytes(6).toString("hex")}`;
		if (creating && before.providers.some((p) => p.id === id)) {
			return failure("Custom endpoint already exists.", 409);
		}

		const beforeAuth = current?.auth;
		const envOwned = beforeAuth?.source === "env";
		if (envOwned && supplied) {
			return failure("Environment owns the effective key. Change the environment or explicitly reuse that key.");
		}
		const hasNewEffectiveKey = Boolean(supplied) && !envOwned;
		const changedTarget = current?.cp.baseUrl !== base;
		if (
			authMode === "apiKey" &&
			(changedTarget || !current || !customKeyAuthorized(current.cp, current.auth)) &&
			!hasNewEffectiveKey &&
			raw.reuseKey !== true
		) {
			return failure("Enter a new key or explicitly allow reuse of the effective existing key for this URL.");
		}
		const effectiveKey = authMode === "apiKey" ? (envOwned ? beforeAuth?.key : supplied || beforeAuth?.key) : undefined;
		if (authMode === "apiKey" && !effectiveKey) return failure("API key mode requires an effective key.");

		const manualModels = parseModelIds(raw.manualModels);
		if (manualModels.length > 10_000) return failure("Model list exceeds 10000 entries");

		const found = await discoverModels(base, effectiveKey);
		if (!found.ok && (found.fatal || found.status === 401 || found.status === 403)) return failure(found.error, 502);
		if (!found.ok && !manualModels.length) {
			return failure(`${found.error}. If this endpoint has no /models list, add model IDs manually.`, 502);
		}

		const now = snapshot(raw.authMode === "apiKey");
		const nowAuth = now.providers.find((p) => p.id === id)?.auth;
		if (before.etag !== now.etag || (beforeAuth && JSON.stringify(beforeAuth) !== JSON.stringify(nowAuth))) {
			return stale();
		}

		const discovered = found.ok ? found.models : !changedTarget ? current?.cp.models ?? [] : [];
		const models = mergeManualModels(discovered, manualModels);
		if (models.length > 10_000) return failure("Model list exceeds 10000 entries");
		const overrides = sanitizeCustomModelOverrides(!changedTarget ? current?.cp.overrides : undefined, models.map((m) => m.id));
		const bindingId = randomBytes(16).toString("hex");
		const fileKey = authMode === "keyless" ? undefined : supplied && !envOwned ? supplied : nowAuth?.fileKey;
		const fileKeyBaseUrl = authMode === "apiKey" ? (envOwned ? nowAuth?.binding?.fileKeyBaseUrl : base) : undefined;
		const binding: CustomAuthBinding = {
			version: 1,
			id: bindingId,
			baseUrl: base,
			authMode,
			...(fileKey && fileKeyBaseUrl ? { fileKeyBaseUrl } : {}),
		};
		const next: CustomProviderSettings = {
			id,
			label,
			baseUrl: base,
			authMode,
			credentialBindingId: bindingId,
			models,
			overrides,
			...(manualModels.length ? { manualModels } : {}),
		};
		commit(withProvider(before.providers.map((p) => p.cp), next), { id, binding, fileKey });
		return response({ ok: true, provider: { id, label, models } });
	} catch (error) {
		return failure(
			error instanceof CustomBodyLimitError
				? "Configuration body exceeds 64 KiB."
				: error instanceof SyntaxError
					? "Invalid JSON body."
					: "Unable to save custom configuration. Reload configuration and retry.",
			error instanceof CustomBodyLimitError ? 413 : error instanceof SyntaxError ? 400 : 500,
		);
	}
}
