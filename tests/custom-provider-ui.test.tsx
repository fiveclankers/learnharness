import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { KeysSection, CustomEndpointSetup } from "../components/settings/keys-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
const FIXTURE = { id: "custom", label: "Fixture endpoint", baseUrl: "http://fixture.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "fixture-model" }], overrides: {}, manualModels: [] };
let mountedProviders = [FIXTURE];
async function mount(setup = false, providers = mountedProviders) {
	globalThis.fetch = async (input, init) => {
		assert.equal(init?.method ?? "GET", "GET", "polish interactions must not save credentials/settings");
		if (String(input).startsWith("/api/custom-provider")) return Response.json({ providers }, { headers: { etag: '"fixture"' } });
		return Response.json({ keys: [], providers: [] });
	};
	host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
	await act(async () => root!.render(<InteractionLayersProvider>{setup ? <CustomEndpointSetup onSaved={() => assert.fail("unexpected save")} /> : <KeysSection />}</InteractionLayersProvider>));
	if (!setup) await click("custom-endpoint-row-btn");
}
function element(id: string) {
	const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
	const node = nodes.find((n) => !n.closest("[hidden]")) ?? nodes[0];
	assert.ok(node, id);
	return node;
}
async function click(id: string) { await act(async () => element(id).dispatchEvent(new dom.window.Event("click", { bubbles: true }))); }
async function selectMode(value: string) {
	const select = element("custom-auth-mode");
	Object.defineProperty(select, "value", { value, configurable: true });
	await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; globalThis.fetch = originalFetch; });
for (const setup of [false, true]) {
	test(`${setup ? "Setup" : "Settings"} hides key input in Keyless and reveals it only in API key mode`, async () => {
		await mount(setup);
		assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		await selectMode("apiKey"); assert.equal(element("custom-key-input").getAttribute("type"), "password");
		await selectMode("keyless"); assert.equal(document.querySelector('[data-testid="custom-key-input"]'), null);
		assert.ok(element("custom-save"));
	});
}
test("renders one labelled row per configured endpoint, edits the chosen one, and supports 1-click inline Refresh", async () => {
	mountedProviders = [
		FIXTURE,
		{ id: "custom-0123456789ab", label: "Local GPU", baseUrl: "http://local.invalid/v1", authMode: "keyless", keySource: "none", keyPresent: false, keyReuseRequired: false, models: [{ id: "local-model" }], overrides: {}, manualModels: [] },
	];
	try {
		await mount();
		const rows = document.querySelectorAll<HTMLElement>('[data-testid="custom-endpoint-row-btn"]');
		assert.equal(rows.length, 2);
		assert.ok(rows[0]!.textContent?.includes("Fixture endpoint"));
		assert.ok(rows[1]!.textContent?.includes("Local GPU"));
		await act(async () => rows[1]!.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal((element("custom-label-input") as HTMLInputElement).value, "Local GPU");
		assert.equal((element("custom-baseurl-input") as HTMLInputElement).value, "http://local.invalid/v1");
		assert.ok(element("custom-refresh"));

		let refreshedBody: Record<string, unknown> | undefined;
		globalThis.fetch = async (input, init) => {
			if (String(input).startsWith("/api/custom-provider") && init?.method === "POST") {
				refreshedBody = JSON.parse(String(init.body));
				return Response.json({ ok: true, provider: { id: "custom-0123456789ab", label: "Local GPU", models: [{ id: "local-model" }, { id: "new-model" }] } }, { headers: { etag: '"fixture-2"' } });
			}
			if (String(input).startsWith("/api/custom-provider")) {
				return Response.json({ providers: mountedProviders }, { headers: { etag: '"fixture-2"' } });
			}
			return Response.json({ keys: [], providers: [] });
		};
		await click("custom-refresh-custom-0123456789ab");
		assert.equal(refreshedBody?.id, "custom-0123456789ab");
		assert.equal(refreshedBody?.baseUrl, "http://local.invalid/v1");
	} finally {
		mountedProviders = [FIXTURE];
	}
});
test("model controls use approved effort labels, right-align Save limits, and group help below", async () => {
	await mount();
	const select = element("custom-pin-reasoning-fixture-model");
	assert.equal(select.getAttribute("aria-label"), "fixture-model reasoning effort support");
	assert.deepEqual(Array.from(select.children).map(option => option.textContent), ["Reasoning effort: Use reported", "Reasoning effort: Supported", "Reasoning effort: Not supported"]);
	assert.deepEqual(Array.from(select.children).map(option => option.getAttribute("value")), ["", "on", "off"], "capability values unchanged");
	const save = element("custom-pins-save"); assert.ok(save.classList.contains("ml-auto")); assert.equal(save.parentElement!.lastElementChild, save);
	const help = element("custom-help"); assert.equal(element("custom-budget-help").parentElement, help); assert.equal(element("custom-reasoning-help").parentElement, help);
	const children = Array.from(element("custom-endpoint-editor").children); assert.ok(children.indexOf(help) > children.indexOf(element("custom-pins")));
	assert.match(help.textContent ?? "", /do not resize backend context/); assert.match(help.textContent ?? "", /Off may not disable/);
});
