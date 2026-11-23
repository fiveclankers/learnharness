import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { AntigravityConnection } from "../components/settings/antigravity-connection.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import { ANTIGRAVITY_PROVIDER, type AntigravityStatus, type ModelCatalogEntry, type TurnUsage } from "../src/core/index.ts";
import { antigravityStatusResponse, antigravityMutationResponse, antigravityBrowserResponse } from "../src/server/antigravity.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("KeysSection renders AntigravityConnection inside group-external-cli and triggers refresh/enable", async () => {
	const seen: Array<{ url: string; body?: unknown }> = [];
	const connectedStatus: AntigravityStatus = {
		installed: true,
		binary: "/usr/local/bin/agy",
		enabled: true,
		allowBackgroundUse: true,
		signedIn: true,
		signingIn: false,
		connected: true,
		models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
		lastRefreshedAt: Date.now(),
		error: null,
	};
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url === "/api/keys") return Response.json({ providers: [], keys: [] });
		if (url === "/api/custom-provider") return Response.json({ baseUrl: "", authMode: "keyless", models: [], overrides: {}, manualModels: [], keyPresent: false, keySource: "none", keyReuseRequired: false }, { headers: { etag: '"1"' } });
		if (url === "/api/settings") return Response.json({ settings: { version: 1 } });
		if (url === "/api/antigravity" && init?.method === "POST") {
			seen.push({ url, body: JSON.parse(String(init.body)) });
			return Response.json(connectedStatus);
		}
		if (url === "/api/antigravity") {
			return Response.json({ ...connectedStatus, enabled: false, connected: false, models: [] });
		}
		return Response.json({});
	};

	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<InteractionLayersProvider>
				<KeysSection />
			</InteractionLayersProvider>,
		);
	});
	const agyEl = document.querySelector('[data-testid="antigravity-connection"]');
	assert.ok(agyEl);
	assert.ok(agyEl.closest('[data-testid="group-external-cli"]'));

	const toggle = agyEl.querySelector<HTMLElement>('[role="switch"]')!;
	await act(async () => toggle.click());
	assert.deepEqual(seen[0]?.body, { action: "enable", enabled: true });

	const refreshBtn = document.querySelector<HTMLButtonElement>('[data-testid="antigravity-refresh"]')!;
	await act(async () => refreshBtn.click());
	assert.deepEqual(seen[1]?.body, { action: "refresh" });
});

test("ModelMenuList and StatsBar show CLI billing for Antigravity while retaining catalog context window", () => {
	const model: ModelCatalogEntry = {
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		provider: ANTIGRAVITY_PROVIDER,
		reasoning: true,
		input: ["text"],
		supportedLevels: ["low", "medium", "high"],
		cost: null,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
	const menuHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<ModelMenuList models={[model]} effectiveId={undefined} onPick={() => {}} />
		</InteractionLayersProvider>,
	);
	assert.match(menuHtml, />CLI billing<\/span>/);
	assert.match(menuHtml, />1M<\/span>/);

	const turn: TurnUsage = {
		id: "t1",
		messageId: "m1",
		at: "2026-11-20T00:00:00Z",
		model: `${ANTIGRAVITY_PROVIDER}:gemini-2.5-pro`,
		steps: [{ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: undefined }],
	};
	const statsHtml = renderToStaticMarkup(
		<InteractionLayersProvider>
			<StatsBar turns={[turn]} pricing={{ cost: 0, unpriced: 1, turnCosts: { t1: null } }} />
		</InteractionLayersProvider>,
	);
	assert.match(statsHtml, /data-testid="stats-cost">CLI<\/span>/);
});

test("Antigravity HTTP handlers require same-origin header and handle missing browser token safely", async () => {
	const unauth = await antigravityStatusResponse(new Request("http://localhost:3000/api/antigravity"));
	assert.equal(unauth.status, 403);

	const badMethod = await antigravityMutationResponse(
		new Request("http://localhost:3000/api/antigravity", {
			method: "POST",
			headers: {
				host: "localhost:3000",
				origin: "http://localhost:3000",
				"content-type": "application/json",
				"x-learnharness-antigravity": "1",
			},
			body: JSON.stringify({ action: "unknown" }),
		}),
	);
	assert.equal(badMethod.status, 400);

	const missingBrowser = await antigravityBrowserResponse(
		new Request("http://localhost:3000/api/antigravity/browser?id=00000000-0000-0000-0000-000000000000", {
			headers: { host: "localhost:3000", "sec-fetch-site": "same-origin" },
		}),
	);
	assert.equal(missingBrowser.status, 410);
});
