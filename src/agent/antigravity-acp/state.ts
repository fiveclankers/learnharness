import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AntigravityStatus } from "../../core/contracts/antigravity.ts";
import { authenticateAntigravity, probeAntigravityModels } from "./acp-client.ts";
import { BrowserActionStore, forwardLoopbackCallback, type ValidatedOAuthUrl } from "./auth-url.ts";
import { antigravityProfileDir, resolveAntigravityBinary, type ResolvedAntigravityBinary } from "./binary.ts";
import { ANTIGRAVITY_CACHE_TTL_MS } from "./constants.ts";
import { closeAntigravityRuns } from "./run.ts";

export interface AntigravityPreferences {
	enabled: boolean;
	allowBackgroundUse: boolean;
}

export interface AntigravityDeps {
	resolveBinary?: () => Promise<ResolvedAntigravityBinary | null>;
	tokenPresent?: () => Promise<boolean>;
	probeModels?: (binary: ResolvedAntigravityBinary, signal?: AbortSignal) => Promise<Model<Api>[]>;
	authenticate?: (
		binary: ResolvedAntigravityBinary,
		options: { signal?: AbortSignal; onAuthUrl?: (authUrl: ValidatedOAuthUrl) => void },
	) => Promise<Model<Api>[]>;
	forwardCallback?: (rawUrl: string, expected: { port: number; state: string }) => Promise<void>;
	now?: () => number;
}

const DEFAULT_PREFS: AntigravityPreferences = { enabled: false, allowBackgroundUse: true };

interface InternalState {
	readPrefs: () => AntigravityPreferences;
	deps: Required<AntigravityDeps>;
	binary: ResolvedAntigravityBinary | null;
	installed: boolean;
	signedIn: boolean;
	models: Model<Api>[];
	lastRefreshedAt: number | null;
	error: string | null;
	signInController: AbortController | null;
	refreshing: Promise<void> | null;
	browserStore: BrowserActionStore;
	listeners: Set<() => void>;
	controllers: Map<AbortController, { background: boolean }>;
}

const TOKEN_FILES = ["acp_token.json", "oauth_creds.json"];

export function defaultAntigravityTokenPresent(homeDir = os.homedir()): Promise<boolean> {
	const dir = antigravityProfileDir(homeDir);
	for (const file of TOKEN_FILES) {
		if (fs.existsSync(path.join(dir, file))) return Promise.resolve(true);
	}
	if (process.platform !== "darwin") return Promise.resolve(false);
	return new Promise((resolve) =>
		execFile(
			"/usr/bin/security",
			["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"],
			{ timeout: 5_000 },
			(error) => resolve(!error),
		),
	);
}

const DEFAULT_DEPS: Required<AntigravityDeps> = {
	resolveBinary: () => resolveAntigravityBinary(),
	tokenPresent: () => defaultAntigravityTokenPresent(),
	probeModels: probeAntigravityModels,
	authenticate: authenticateAntigravity,
	forwardCallback: forwardLoopbackCallback,
	now: () => Date.now(),
};

const STATE_KEY = Symbol.for("lh.antigravity.state");

function state(): InternalState {
	const g = globalThis as typeof globalThis & { [STATE_KEY]?: InternalState };
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = {
			readPrefs: () => DEFAULT_PREFS,
			deps: { ...DEFAULT_DEPS },
			binary: null,
			installed: false,
			signedIn: false,
			models: [],
			lastRefreshedAt: null,
			error: null,
			signInController: null,
			refreshing: null,
			browserStore: new BrowserActionStore(),
			listeners: new Set(),
			controllers: new Map(),
		};
	}
	return g[STATE_KEY];
}

function notify(): void {
	for (const listener of [...state().listeners]) listener();
}

function enforceRunPolicies(): void {
	const s = state();
	const prefs = s.readPrefs();
	const active = prefs.enabled && s.installed && s.signedIn && s.models.length > 0;
	if (!active) {
		for (const controller of s.controllers.keys()) controller.abort("antigravity-disabled");
		closeAntigravityRuns();
		return;
	}
	if (!prefs.allowBackgroundUse) {
		for (const [controller, meta] of s.controllers) {
			if (meta.background) controller.abort("antigravity-background-disabled");
		}
		closeAntigravityRuns({ backgroundOnly: true });
	}
}

export function configureAntigravityPreferences(reader: () => AntigravityPreferences): void {
	state().readPrefs = reader;
	enforceRunPolicies();
}

export function configureAntigravityTestDeps(deps: AntigravityDeps | null): void {
	const s = state();
	s.deps = deps ? { ...DEFAULT_DEPS, ...deps } : { ...DEFAULT_DEPS };
}

export function resetAntigravityStateForTests(): void {
	const s = state();
	s.signInController?.abort();
	s.signInController = null;
	s.binary = null;
	s.installed = false;
	s.signedIn = false;
	s.models = [];
	s.lastRefreshedAt = null;
	s.error = null;
	s.refreshing = null;
	s.browserStore.clear();
	s.deps = { ...DEFAULT_DEPS };
	closeAntigravityRuns();
}

export function onAntigravityChange(listener: () => void): () => void {
	const s = state();
	s.listeners.add(listener);
	return () => {
		s.listeners.delete(listener);
	};
}

export function notifyAntigravityPolicyChange(): void {
	enforceRunPolicies();
	notify();
}

export function getAntigravityStatus(): AntigravityStatus {
	const s = state();
	const prefs = s.readPrefs();
	const signingIn = Boolean(s.signInController);
	const currentAuth = s.browserStore.current();
	const connected = prefs.enabled && s.installed && s.signedIn && s.models.length > 0;
	return {
		installed: s.installed,
		binary: s.binary?.path ?? null,
		enabled: prefs.enabled,
		allowBackgroundUse: prefs.allowBackgroundUse,
		signedIn: s.signedIn,
		signingIn,
		connected,
		models: s.models.map((m) => ({ id: m.id, name: m.name })),
		lastRefreshedAt: s.lastRefreshedAt,
		error: s.error,
		...(signingIn && currentAuth?.id ? { browserAction: { id: currentAuth.id } } : {}),
		...(signingIn && currentAuth ? { needsManualCallback: true } : {}),
	};
}

export function antigravityBinary(): ResolvedAntigravityBinary | null {
	return state().binary;
}

export function antigravityAvailable(): boolean {
	const s = state();
	const prefs = s.readPrefs();
	return prefs.enabled && s.installed && s.signedIn && s.models.length > 0;
}

export function antigravityBackgroundAllowed(): boolean {
	return antigravityAvailable() && state().readPrefs().allowBackgroundUse;
}

export function antigravityModels(): Model<Api>[] {
	return antigravityAvailable() ? state().models : [];
}

export function antigravityModel(id: string): Model<Api> | undefined {
	return antigravityModels().find((m) => m.id === id);
}

export function antigravityAbortController(background: boolean) {
	const controller = new AbortController();
	state().controllers.set(controller, { background });
	return {
		controller,
		release: () => {
			state().controllers.delete(controller);
		},
	};
}

export async function refreshAntigravity(force = false): Promise<AntigravityStatus> {
	const s = state();
	if (s.refreshing) {
		await s.refreshing;
		if (!force) return getAntigravityStatus();
	}
	if (s.refreshing) {
		await s.refreshing;
		return getAntigravityStatus();
	}

	const prefs = s.readPrefs();
	const now = s.deps.now();
	if (
		!force &&
		s.lastRefreshedAt !== null &&
		now - s.lastRefreshedAt < ANTIGRAVITY_CACHE_TTL_MS &&
		(!prefs.enabled || !s.installed || !s.signedIn || s.models.length > 0)
	) {
		return getAntigravityStatus();
	}

	const before = JSON.stringify({ ...getAntigravityStatus(), lastRefreshedAt: 0 });
	s.refreshing = (async () => {
		const binary = await s.deps.resolveBinary();
		if (!binary) {
			s.binary = null;
			s.installed = false;
			s.signedIn = false;
			s.models = [];
			s.error = prefs.enabled ? "Antigravity CLI ('agy') was not found on PATH or in standard locations." : null;
			s.lastRefreshedAt = s.deps.now();
			enforceRunPolicies();
			return;
		}
		s.binary = binary;
		s.installed = true;

		if (!prefs.enabled) {
			s.signedIn = await s.deps.tokenPresent().catch(() => false);
			s.models = [];
			s.error = null;
			s.lastRefreshedAt = s.deps.now();
			enforceRunPolicies();
			return;
		}

		const hasToken = await s.deps.tokenPresent().catch(() => false);
		if (!hasToken) {
			s.signedIn = false;
			s.models = [];
			s.error = null;
			s.lastRefreshedAt = s.deps.now();
			enforceRunPolicies();
			return;
		}

		try {
			const models = await s.deps.probeModels(binary);
			s.signedIn = true;
			s.models = models;
			s.error = models.length === 0 ? "Antigravity returned no models. Click Refresh models or sign in again." : null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isAuth = /auth|credential|sign|login|unauth|token/i.test(message);
			s.signedIn = !isAuth;
			if (isAuth) s.models = [];
			s.error = isAuth
				? "Antigravity's Google sign-in is missing or expired. Sign in again."
				: `Antigravity failed to load models: ${message}`;
		}
		s.lastRefreshedAt = s.deps.now();
		enforceRunPolicies();
	})().finally(() => {
		s.refreshing = null;
		const after = JSON.stringify({ ...getAntigravityStatus(), lastRefreshedAt: 0 });
		if (before !== after) notify();
	});

	await s.refreshing;
	return getAntigravityStatus();
}

export async function startAntigravitySignIn(): Promise<AntigravityStatus> {
	const s = state();
	if (s.signInController) return getAntigravityStatus();
	const binary = s.binary ?? (await s.deps.resolveBinary());
	if (!binary) {
		s.installed = false;
		s.binary = null;
		s.error = "Install the Antigravity CLI ('agy') first, then refresh.";
		notify();
		return getAntigravityStatus();
	}
	s.binary = binary;
	s.installed = true;
	const controller = new AbortController();
	s.signInController = controller;
	s.browserStore.clear();
	s.error = null;
	notify();

	void (async () => {
		try {
			const models = await s.deps.authenticate(binary, {
				signal: controller.signal,
				onAuthUrl: (validated) => {
					if (s.signInController !== controller) return;
					s.browserStore.set(validated);
					notify();
				},
			});
			s.signedIn = true;
			s.models = models;
			s.error = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!controller.signal.aborted) {
				s.error = `Google sign-in failed: ${message}`;
			}
		} finally {
			if (s.signInController === controller) {
				s.signInController = null;
				s.browserStore.clear();
				s.lastRefreshedAt = null;
			}
			await refreshAntigravity(true).catch(() => {});
			notify();
		}
	})();

	return getAntigravityStatus();
}

export function cancelAntigravitySignIn(): AntigravityStatus {
	const s = state();
	if (s.signInController) {
		s.signInController.abort();
		s.signInController = null;
		s.browserStore.clear();
		notify();
	}
	return getAntigravityStatus();
}

export function takeAntigravityBrowserAction(id: string): string | null {
	return state().browserStore.take(id);
}

export async function submitAntigravityCallback(rawUrl: string): Promise<AntigravityStatus> {
	const s = state();
	const current = s.browserStore.current();
	if (!s.signInController || !current) {
		throw new Error("No active Google sign-in attempt is waiting for a callback.");
	}
	await s.deps.forwardCallback(rawUrl, { port: current.auth.port, state: current.auth.state });
	return getAntigravityStatus();
}
