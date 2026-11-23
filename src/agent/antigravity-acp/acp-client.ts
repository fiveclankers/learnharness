import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
	ClientApp,
	ndJsonStream,
	type ClientConnection,
	type InitializeResponse,
	type NewSessionResponse,
	type PromptResponse,
	type RequestPermissionResponse,
	type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import packageMetadata from "../../../package.json" with { type: "json" };
import { extractAuthUrlFromLine, createStdoutJsonLineFilter, type ValidatedOAuthUrl } from "./auth-url.ts";
import {
	antigravityServerArgs,
	ensureAntigravityProfileDir,
	type ResolvedAntigravityBinary,
} from "./binary.ts";
import {
	ANTIGRAVITY_API,
	ANTIGRAVITY_PROVIDER,
	PROTOCOL_VERSION,
	REQUEST_TIMEOUT_MS,
	SIGN_IN_TIMEOUT_MS,
	THINKING_LEVELS,
} from "./constants.ts";
import { buildAntigravityChildEnv, createBrowserCaptureHelper } from "./env.ts";
import { BRIDGE_SERVER_NAME } from "./mcp-bridge.ts";
import type { AntigravityRun, RunSession } from "./run.ts";
import type { PromptBlock } from "./transcript.ts";

export interface AcpProcess {
	child: ChildProcess;
	connection: ClientConnection;
	initialize: InitializeResponse;
	cwd: string;
	close(): void;
}

export interface AcpHandlers {
	onUpdate?: (update: Record<string, unknown>) => void;
	onExit?: (message: string) => void;
	onAuthUrl?: (authUrl: ValidatedOAuthUrl) => void;
	captureBrowser?: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("cancelled"));
			return;
		}
		const timer = setTimeout(() => reject(new Error(`Antigravity ${what} timed out.`)), ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function selectOptions(option: SessionConfigOption | undefined): Array<{ value: string; name: string }> {
	if (!option || option.type !== "select") return [];
	const entries = option.options as Array<{ value?: string; name: string; options?: Array<{ value: string; name: string }> }>;
	return entries.flatMap((entry) => entry.options ?? (entry.value !== undefined ? [{ value: entry.value, name: entry.name }] : []));
}

function configOption(options: SessionConfigOption[] | null | undefined, category: string): SessionConfigOption | undefined {
	return options?.find((option) => option.category === category || option.id === category);
}

function levelMap(values: string[]): Model<Api>["thinkingLevelMap"] {
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVELS) map[level] = values.includes(level) ? level : null;
	return map as Model<Api>["thinkingLevelMap"];
}

function catalogModel(id: string, name: string, initialize: InitializeResponse, thoughtLevels: string[]): Model<Api> {
	return {
		id,
		name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		reasoning: thoughtLevels.length > 0,
		...(thoughtLevels.length > 0 ? { thinkingLevelMap: levelMap(thoughtLevels) } : {}),
		input: initialize.agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: /^gemini/i.test(id) ? 1_048_576 : 200_000,
		maxTokens: 65_536,
	} as Model<Api>;
}

export async function startAcp(
	binary: ResolvedAntigravityBinary,
	handlers: AcpHandlers = {},
	signal?: AbortSignal,
): Promise<AcpProcess> {
	if (binary.kind === "cli") ensureAntigravityProfileDir();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-antigravity-"));
	const cwd = path.join(dir, "workspace");
	fs.mkdirSync(cwd, { mode: 0o700 });

	const env = buildAntigravityChildEnv();
	const browserCapture = handlers.captureBrowser ? createBrowserCaptureHelper() : undefined;
	if (browserCapture) env.BROWSER = browserCapture.browserScriptPath;

	const child = spawn(binary.path, antigravityServerArgs(binary.kind), {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let stderr = "";
	let stderrBuffer = "";
	let closed = false;
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
		if (handlers.onAuthUrl) {
			stderrBuffer += chunk;
			for (;;) {
				const nl = stderrBuffer.indexOf("\n");
				if (nl < 0) break;
				const line = stderrBuffer.slice(0, nl);
				stderrBuffer = stderrBuffer.slice(nl + 1);
				const found = extractAuthUrlFromLine(line);
				if (found) handlers.onAuthUrl(found);
			}
		}
	});
	child.stdin!.on("error", () => {});

	const app = new ClientApp({ name: "learnharness" })
		.onRequest("session/request_permission", ({ params }): RequestPermissionResponse => {
			const reject = params.options.find((option) => option.kind === "reject_once")
				?? params.options.find((option) => option.kind === "reject_always");
			return { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } };
		})
		.onNotification("session/update", ({ params }) => {
			handlers.onUpdate?.(params.update as unknown as Record<string, unknown>);
		});

	const rawStdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
	const filteredStdout = rawStdout.pipeThrough(
		createStdoutJsonLineFilter((validated) => handlers.onAuthUrl?.(validated)),
	);
	const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, filteredStdout);
	const connection = app.connect(stream);

	const close = () => {
		if (closed) return;
		closed = true;
		try {
			connection.close();
		} catch {
			// already closed
		}
		child.kill("SIGTERM");
		const force = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 3_000);
		force.unref();
		browserCapture?.cleanup();
		fs.rm(dir, { recursive: true, force: true }, () => {});
	};

	const exited = new Promise<never>((_, reject) => {
		child.on("error", (error) => {
			if (!closed) handlers.onExit?.(error.message);
			reject(new Error(`Antigravity could not start: ${error.message}`));
		});
		child.on("exit", (code) => {
			if (stderrBuffer.trim() && handlers.onAuthUrl) {
				const found = extractAuthUrlFromLine(stderrBuffer);
				if (found) handlers.onAuthUrl(found);
			}
			const message = stderr.trim().split("\n").pop() || `Antigravity exited (${code ?? "signal"}).`;
			if (!closed) handlers.onExit?.(message);
			reject(new Error(message));
		});
	});
	exited.catch(() => {});

	try {
		const clientInfoName = binary.kind === "legacy-server" ? "zed" : packageMetadata.name;
		const initialize = await withTimeout(
			Promise.race([
				connection.agent.request("initialize", {
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					clientInfo: { name: clientInfoName, title: "LearnHarness", version: packageMetadata.version },
				}),
				exited,
			]),
			REQUEST_TIMEOUT_MS,
			"start",
			signal,
		);
		if (initialize.protocolVersion < PROTOCOL_VERSION) {
			throw new Error("This Antigravity version speaks an unsupported protocol. Update it and refresh.");
		}
		return { child, connection, initialize, cwd, close };
	} catch (error) {
		close();
		throw error;
	}
}

export async function discoverAntigravityModels(
	acp: AcpProcess,
	session: NewSessionResponse,
	signal?: AbortSignal,
): Promise<Model<Api>[]> {
	const modelOption = configOption(session.configOptions, "model");
	const models = selectOptions(modelOption);
	if (models.length > 0) {
		const out: Model<Api>[] = [];
		for (const model of models) {
			let options = session.configOptions;
			if (modelOption?.type === "select" && modelOption.currentValue !== model.value) {
				const response = await withTimeout(
					acp.connection.agent.request("session/set_config_option", {
						sessionId: session.sessionId,
						configId: modelOption.id,
						value: model.value,
					}),
					REQUEST_TIMEOUT_MS,
					"model listing",
					signal,
				);
				options = response.configOptions;
			}
			out.push(
				catalogModel(
					model.value,
					model.name,
					acp.initialize,
					selectOptions(configOption(options, "thought_level")).map((o) => o.value),
				),
			);
		}
		return out;
	}
	const draft = (session as unknown as { models?: { availableModels?: Array<{ modelId: string; name?: string }> } }).models?.availableModels ?? [];
	return draft.map((model) => catalogModel(model.modelId, model.name ?? model.modelId, acp.initialize, []));
}

export async function probeAntigravityModels(binary: ResolvedAntigravityBinary, signal?: AbortSignal): Promise<Model<Api>[]> {
	const acp = await startAcp(binary, {}, signal);
	try {
		const session = await withTimeout(
			acp.connection.agent.request("session/new", {
				cwd: acp.cwd,
				mcpServers: [],
				_meta: { antigravity: { disabledTools: ["run_workflow"] } },
			} as never),
			REQUEST_TIMEOUT_MS,
			"session",
			signal,
		);
		return await discoverAntigravityModels(acp, session, signal);
	} finally {
		acp.close();
	}
}

export async function authenticateAntigravity(
	binary: ResolvedAntigravityBinary,
	options: { signal?: AbortSignal; onAuthUrl?: (authUrl: ValidatedOAuthUrl) => void },
): Promise<Model<Api>[]> {
	const acp = await startAcp(
		binary,
		{ captureBrowser: true, onAuthUrl: options.onAuthUrl },
		options.signal,
	);
	try {
		const method = acp.initialize.authMethods?.find((candidate) => /oauth-personal|google/i.test(`${candidate.id} ${candidate.name}`));
		if (!method) throw new Error("This Antigravity version does not offer Google sign-in.");
		await withTimeout(
			acp.connection.agent.request("authenticate", { methodId: method.id }),
			SIGN_IN_TIMEOUT_MS,
			"sign-in",
			options.signal,
		);
		const session = await withTimeout(
			acp.connection.agent.request("session/new", {
				cwd: acp.cwd,
				mcpServers: [],
				_meta: { antigravity: { disabledTools: ["run_workflow"] } },
			} as never),
			REQUEST_TIMEOUT_MS,
			"session",
			options.signal,
		);
		return await discoverAntigravityModels(acp, session, options.signal);
	} finally {
		acp.close();
	}
}

function toAcpContent(blocks: PromptBlock[], images: boolean) {
	return blocks.map((block) =>
		block.type === "image"
			? images
				? { type: "image" as const, data: block.data, mimeType: block.mimeType }
				: { type: "text" as const, text: `[image omitted: ${block.mimeType}]` }
			: { type: "text" as const, text: block.text },
	);
}

export async function openAntigravitySession(
	run: AntigravityRun,
	request: { binary: ResolvedAntigravityBinary; model: Model<Api>; level?: string },
): Promise<RunSession> {
	let sessionId: string | undefined;
	const acp = await startAcp(request.binary, {
		onUpdate: (update) => {
			const content = update.content as { type?: unknown; text?: unknown } | undefined;
			if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
				run.text(content.text);
			} else if (update.sessionUpdate === "agent_thought_chunk" && content?.type === "text" && typeof content.text === "string") {
				run.thinking(content.text);
			}
		},
		onExit: (message) => run.fail(message),
	});
	try {
		const mcp = acp.initialize.agentCapabilities?.mcpCapabilities;
		if (run.tools.length > 0 && !mcp?.http) {
			throw new Error("This Antigravity version cannot use LearnHarness's tools (no HTTP MCP support). Update it and refresh.");
		}
		const session = await withTimeout(
			acp.connection.agent.request("session/new", {
				cwd: acp.cwd,
				mcpServers:
					run.tools.length > 0 && run.bridge
						? [
								{
									type: "http",
									name: BRIDGE_SERVER_NAME,
									url: run.bridge.url,
									headers: [{ name: "Authorization", value: `Bearer ${run.bridge.token}` }],
								},
							]
						: [],
				_meta: { antigravity: { disabledTools: ["run_workflow"] } },
			} as never),
			REQUEST_TIMEOUT_MS,
			"session",
		);
		sessionId = session.sessionId;
		if (session.modes && session.modes.currentModeId !== "default" && session.modes.availableModes.some((mode) => mode.id === "default")) {
			await withTimeout(
				acp.connection.agent.request("session/set_mode", { sessionId, modeId: "default" }),
				REQUEST_TIMEOUT_MS,
				"mode",
			);
		}
		let options = session.configOptions;
		const modelOption = configOption(options, "model");
		if (modelOption?.type === "select") {
			if (modelOption.currentValue !== request.model.id) {
				options = (
					await withTimeout(
						acp.connection.agent.request("session/set_config_option", {
							sessionId,
							configId: modelOption.id,
							value: request.model.id,
						}),
						REQUEST_TIMEOUT_MS,
						"model",
					)
				).configOptions;
			}
			const thought = configOption(options, "thought_level");
			const wanted = request.level && (request.model.thinkingLevelMap as Record<string, string | null> | undefined)?.[request.level];
			if (thought?.type === "select" && wanted && thought.currentValue !== wanted) {
				await withTimeout(
					acp.connection.agent.request("session/set_config_option", {
						sessionId,
						configId: thought.id,
						value: wanted,
					}),
					REQUEST_TIMEOUT_MS,
					"thinking level",
				);
			}
		} else {
			await withTimeout(
				acp.connection.agent.request("session/set_model" as never, { sessionId, modelId: request.model.id } as never),
				REQUEST_TIMEOUT_MS,
				"model",
			);
		}
	} catch (error) {
		acp.close();
		throw error;
	}

	const images = acp.initialize.agentCapabilities?.promptCapabilities?.image === true;
	let disposed = false;
	return {
		start(prompt) {
			acp.connection.agent
				.request<PromptResponse>("session/prompt", { sessionId: sessionId!, prompt: toAcpContent(prompt, images) })
				.then(
					(response) => run.endTurn(response.stopReason === "max_tokens" ? "length" : "stop"),
					(error) => {
						if (!disposed) run.fail(error instanceof Error ? error.message : String(error));
					},
				);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (sessionId) void acp.connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
			acp.close();
		},
	};
}
