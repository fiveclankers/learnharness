import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	BrowserActionStore,
	createStdoutJsonLineFilter,
	extractAuthUrlFromLine,
	parseValidatedGoogleOAuthUrl,
	validateManualCallbackUrl,
} from "../src/agent/antigravity-acp/auth-url.ts";
import {
	antigravityServerArgs,
	classifyAntigravityBinary,
	resolveAntigravityBinary,
} from "../src/agent/antigravity-acp/binary.ts";
import {
	AUTH_URL_MARKER,
	buildAntigravityChildEnv,
	configureAppHeldEnvVars,
	createBrowserCaptureHelper,
} from "../src/agent/antigravity-acp/env.ts";
import { probeAntigravityModels } from "../src/agent/antigravity-acp/acp-client.ts";
import {
	antigravityAvailable,
	antigravityBackgroundAllowed,
	antigravityModels,
	configureAntigravityPreferences,
	configureAntigravityTestDeps,
	getAntigravityStatus,
	notifyAntigravityPolicyChange,
	refreshAntigravity,
	resetAntigravityStateForTests,
	startAntigravitySignIn,
	submitAntigravityCallback,
	takeAntigravityBrowserAction,
} from "../src/agent/antigravity-acp/state.ts";
import { streamAntigravity } from "../src/agent/antigravity-acp/stream.ts";
import { ANTIGRAVITY_API, ANTIGRAVITY_CACHE_TTL_MS, ANTIGRAVITY_PROVIDER } from "../src/core/contracts/antigravity.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { callCost } from "../src/server/pricing.ts";

const FIXTURE = path.resolve("tests/fixtures/antigravity/fake-acp.mjs");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	resetAntigravityStateForTests();
	configureAppHeldEnvVars(() => []);
	delete process.env.FAKE_ACP_LOG;
	delete process.env.FAKE_ACP_AUTO_CALLBACK;
	while (tempDirs.length) {
		fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

test("binary resolution prefers AGY_ACP_BIN, classifies agy vs legacy server, and prepares shared profile args", async () => {
	const home = makeTempDir("agy-home-");
	const binDir = path.join(home, ".local", "bin");
	fs.mkdirSync(binDir, { recursive: true });
	const agyPath = path.join(binDir, "agy");
	fs.writeFileSync(agyPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	const resolved = await resolveAntigravityBinary({ env: { NODE_ENV: "test", PATH: binDir }, homeDir: home });
	assert.deepEqual(resolved, { path: agyPath, kind: "cli" });
	assert.deepEqual(antigravityServerArgs("cli", home), [
		"acp",
		"--gemini-dir",
		path.join(home, ".gemini"),
		"--app-data-dir",
		"antigravity-acp",
	]);

	assert.equal(classifyAntigravityBinary("/opt/agy/agy_acp_server.par"), "legacy-server");
	const custom = path.join(home, "custom_agy_acp_server");
	fs.writeFileSync(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	assert.deepEqual(await resolveAntigravityBinary({ env: { NODE_ENV: "test", AGY_ACP_BIN: custom }, homeDir: home }), {
		path: custom,
		kind: "legacy-server",
	});
});

test("child env scrubs app-held and Google/Node injection vars, and BROWSER capture script executes cleanly", async () => {
	configureAppHeldEnvVars(() => ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]);
	const env = buildAntigravityChildEnv({
		NODE_ENV: "test",
		PATH: "/usr/bin",
		HOME: "/home/test",
		OPENROUTER_API_KEY: "secret-or",
		GEMINI_API_KEY: "secret-gem",
		GOOGLE_API_KEY: "secret-goog",
		NODE_OPTIONS: "--require=evil.js",
		ELECTRON_RUN_AS_NODE: "1",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.OPENROUTER_API_KEY, undefined);
	assert.equal(env.GEMINI_API_KEY, undefined);
	assert.equal(env.GOOGLE_API_KEY, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);

	const helper = createBrowserCaptureHelper();
	try {
		const target = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A45678%2F&response_type=code&state=s1%3Aa%3Bb";
		const stderr = await new Promise<string>((resolve, reject) => {
			execFile(helper.browserScriptPath, [target], (err, _stdout, errOut) => {
				if (err) reject(err);
				else resolve(errOut);
			});
		});
		assert.ok(stderr.includes(AUTH_URL_MARKER));
		const extracted = extractAuthUrlFromLine(stderr);
		assert.ok(extracted);
		assert.equal(extracted.port, 45678);
		assert.equal(extracted.state, "s1:a;b");
	} finally {
		helper.cleanup();
	}
});

test("auth-url validation, one-use browser tokens, stdout JSON filter, and manual callback validation work strictly", async () => {
	assert.equal(parseValidatedGoogleOAuthUrl("https://evil.example.com/auth"), null);
	assert.equal(
		parseValidatedGoogleOAuthUrl(
			"https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F&response_type=code&state=s",
		),
		null,
	);
	const okUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=http%3A%2F%2F127.0.0.1%3A42000%2Fcb&response_type=code&state=st1";
	const parsed = parseValidatedGoogleOAuthUrl(okUrl);
	assert.ok(parsed);
	assert.equal(parsed.port, 42000);
	assert.equal(parsed.state, "st1");

	const captured: string[] = [];
	const filter = createStdoutJsonLineFilter((v) => captured.push(v.url));
	const writer = filter.writable.getWriter();
	const reader = filter.readable.getReader();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	void (async () => {
		await writer.write(encoder.encode(`Open the following link to authenticate the ACP server: ${okUrl}\n{"jsonrpc":"2.0","id":1}\n`));
		await writer.close();
	})();

	let forwarded = "";
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		forwarded += decoder.decode(next.value, { stream: true });
	}
	assert.equal(forwarded.trim(), '{"jsonrpc":"2.0","id":1}');
	assert.equal(captured.length, 1);

	const store = new BrowserActionStore();
	const action = store.set(parsed);
	assert.equal(store.take(action.id), parsed.url);
	assert.equal(store.take(action.id), null);

	assert.throws(
		() => validateManualCallbackUrl("http://127.0.0.1:9999/?code=abc&state=st1", { port: 42000, state: "st1" }),
		/port does not match/,
	);
	assert.throws(
		() => validateManualCallbackUrl("http://127.0.0.1:42000/?code=abc&state=wrong", { port: 42000, state: "st1" }),
		/state does not match/,
	);
	const validCb = validateManualCallbackUrl("http://localhost:42000/oauth2callback?code=abc&state=st1", {
		port: 42000,
		state: "st1",
	});
	assert.equal(validCb.searchParams.get("code"), "abc");
});

test("fake ACP server discovers models + thought_level, enforces fail-closed permissions + default mode, and runs parked MCP tools + cold replay", async () => {
	const dir = makeTempDir("agy-e2e-");
	const logPath = path.join(dir, "acp.log");
	process.env.FAKE_ACP_LOG = logPath;

	const binary = { path: FIXTURE, kind: "cli" as const };
	const discovered = await probeAntigravityModels(binary);
	assert.deepEqual(
		discovered.map((m) => ({ id: m.id, levels: getSupportedThinkingLevels(m), contextWindow: m.contextWindow })),
		[
			{ id: "gemini-2.5-pro", levels: ["low", "medium", "high"], contextWindow: 1_048_576 },
			{ id: "claude-sonnet-4", levels: ["medium"], contextWindow: 200_000 },
		],
	);

	// Verify model DTO & pricing: keeps contextWindow/maxTokens, nulls cost, unpriced by server callCost.
	const dto = toModelDto(discovered[0]!);
	assert.equal(dto.cost, null);
	assert.equal(dto.contextWindow, 1_048_576);
	assert.equal(dto.maxTokens, 65_536);
	assert.equal(callCost({ inputTokens: 1000, outputTokens: 100 }, `${ANTIGRAVITY_PROVIDER}:gemini-2.5-pro`), null);

	configureAntigravityPreferences(() => ({ enabled: true, allowBackgroundUse: true }));
	configureAntigravityTestDeps({
		resolveBinary: async () => binary,
		tokenPresent: async () => true,
		probeModels: async () => discovered,
	});
	await refreshAntigravity(true);
	assert.equal(antigravityAvailable(), true);
	assert.equal(antigravityModels().length, 2);

	let lookupCalls = 0;
	const agent = new Agent({
		sessionId: "chat-agy-1",
		initialState: {
			model: discovered[0] as Model<Api>,
			systemPrompt: "You are a helpful tutor.",
			tools: [
				{
					name: "lookup",
					label: "Lookup",
					description: "Lookup a topic",
					parameters: Type.Object({ topic: Type.String() }),
					execute: async (_id, params) => {
						lookupCalls++;
						return {
							content: [{ type: "text", text: `Nile (${(params as { topic: string }).topic})` }],
							details: {},
						};
					},
				},
			],
		},
		streamFn: streamAntigravity(() => false),
	});

	await agent.prompt("Please use the tool now.");
	assert.equal(lookupCalls, 1);
	const lastAssistant = agent.state.messages.filter((m) => m.role === "assistant").at(-1)!;
	const text = lastAssistant.content.filter((b) => b.type === "text").map((b) => b.text).join("");
	assert.match(text, /got: Nile \(rivers\)/);

	// Second turn in same Agent (history appended with assistant+toolResult) triggers fresh cold replay on new prompt
	await agent.prompt("Summarize briefly.");
	const secondAssistant = agent.state.messages.filter((m) => m.role === "assistant").at(-1)!;
	const secondText = secondAssistant.content.filter((b) => b.type === "text").map((b) => b.text).join("");
	assert.match(secondText, /plain blocks=/);

	const entries = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const permissions = entries.filter((e) => e.type === "permission");
	assert.ok(permissions.length >= 1);
	for (const p of permissions) {
		assert.deepEqual(p.outcome, { outcome: "selected", optionId: "no" });
		assert.equal(p.mode, "default");
	}
	const newSessions = entries.filter((e) => e.type === "request" && e.method === "session/new");
	assert.equal(newSessions.at(-1).params._meta?.antigravity?.disabledTools?.[0], "run_workflow");
});

test("state machine enforces 60s TTL cache, force=true bypass, manual callback completion, and immediate abort on policy changes", async () => {
	let clock = 1_000_000;
	let probeCalls = 0;
	let signedInFlag = false;
	const server = http.createServer((req, res) => {
		res.writeHead(200).end("ok");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;

	const binary = { path: "/bin/agy", kind: "cli" as const };
	const sampleModel: Model<Api> = {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};

	let resolveAuth!: (models: Model<Api>[]) => void;
	configureAntigravityPreferences(() => ({ enabled: true, allowBackgroundUse: true }));
	configureAntigravityTestDeps({
		now: () => clock,
		resolveBinary: async () => binary,
		tokenPresent: async () => signedInFlag,
		probeModels: async () => {
			probeCalls++;
			return [sampleModel];
		},
		authenticate: (_bin, opts) => {
			opts.onAuthUrl?.({
				url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&response_type=code&state=s9`,
				port,
				state: "s9",
			});
			return new Promise<Model<Api>[]>((resolve) => {
				resolveAuth = (models) => {
					signedInFlag = true;
					resolve(models);
				};
			});
		},
	});

	try {
		await startAntigravitySignIn();
		const during = getAntigravityStatus();
		assert.equal(during.signingIn, true);
		assert.ok(during.browserAction?.id);
		assert.equal(during.needsManualCallback, true);
		// One-use browser token returns the OAuth URL once and clears
		const target = takeAntigravityBrowserAction(during.browserAction!.id);
		assert.match(target!, /^https:\/\/accounts\.google\.com/);
		assert.equal(takeAntigravityBrowserAction(during.browserAction!.id), null);

		// Forward manual callback
		await submitAntigravityCallback(`http://127.0.0.1:${port}/cb?code=auth1&state=s9`);
		resolveAuth([sampleModel]);
		await new Promise((r) => setTimeout(r, 30));

		assert.equal(antigravityAvailable(), true);
		const afterLoginProbes = probeCalls;
		// Within 60s TTL, force=false reuses cache
		clock += 30_000;
		await refreshAntigravity(false);
		assert.equal(probeCalls, afterLoginProbes);
		// Explicit force=true re-probes immediately
		await refreshAntigravity(true);
		assert.equal(probeCalls, afterLoginProbes + 1);
		// Past 60s TTL, force=false re-probes
		clock += ANTIGRAVITY_CACHE_TTL_MS + 1;
		await refreshAntigravity(false);
		assert.equal(probeCalls, afterLoginProbes + 2);

		// Disabling background consent revokes antigravityBackgroundAllowed immediately
		configureAntigravityPreferences(() => ({ enabled: true, allowBackgroundUse: false }));
		notifyAntigravityPolicyChange();
		assert.equal(antigravityBackgroundAllowed(), false);
		assert.equal(antigravityAvailable(), true);
	} finally {
		server.close();
	}
});
