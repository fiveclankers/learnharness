import { randomUUID } from "node:crypto";
import type { Api, Model, SimpleStreamOptions, StreamFunction, TextContent } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { openAntigravitySession } from "./acp-client.ts";
import { ANTIGRAVITY_UNAVAILABLE, RUN_IDLE_TIMEOUT_MS } from "./constants.ts";
import { startMcpBridge, type BridgeTool } from "./mcp-bridge.ts";
import { createRun, findRun, StepWriter } from "./run.ts";
import { antigravityAbortController, antigravityAvailable, antigravityBackgroundAllowed, antigravityBinary, antigravityModel } from "./state.ts";
import { renderTranscript } from "./transcript.ts";

function runKey(sessionId: string | undefined, messages: readonly { role: string; content?: unknown }[]): string {
	if (sessionId) return `session:${sessionId}`;
	const firstUser = messages.find((m) => m.role === "user");
	const text = typeof firstUser?.content === "string"
		? firstUser.content.slice(0, 64)
		: Array.isArray(firstUser?.content)
			? (firstUser.content.find((c): c is TextContent => (c as { type?: string }).type === "text")?.text ?? "").slice(0, 64)
			: "";
	return `ephemeral:${text || randomUUID()}`;
}

export function streamAntigravity(purpose: () => boolean): StreamFunction<Api, SimpleStreamOptions> {
	return (model: Model<Api>, context, options) => {
		const writer = new StepWriter(model);
		void (async () => {
			const background = purpose();
			const binary = antigravityBinary();
			const liveModel = antigravityModel(model.id) ?? model;
			if (!antigravityAvailable() || !binary) {
				writer.fail("error", ANTIGRAVITY_UNAVAILABLE);
				return;
			}
			if (background && !antigravityBackgroundAllowed()) {
				writer.fail("error", "Background use is disabled for Antigravity.");
				return;
			}

			const tools = getCurrentTools(context.messages);
			const bridgeTools: BridgeTool[] = tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.parameters as BridgeTool["inputSchema"],
			}));
			const level = typeof options?.reasoning === "string" ? options.reasoning : undefined;
			const systemPrompt = getCurrentSystemPrompt(context.messages) ?? "";
			const signature = JSON.stringify({ modelId: liveModel.id, level, systemPrompt, tools: bridgeTools.map((t) => t.name) });
			const key = runKey(options?.sessionId, context.messages);

			const { controller, release } = antigravityAbortController(background);
			const onUserAbort = () => controller.abort("aborted");
			options?.signal?.addEventListener("abort", onUserAbort, { once: true });

			const existing = findRun(key);
			if (existing && existing.canResume(context.messages, signature)) {
				existing.background = background;
				const abortHook = () => existing.fail(options?.signal?.aborted ? "Request was aborted" : "Antigravity was disabled.", options?.signal?.aborted ? "aborted" : "error");
				controller.signal.addEventListener("abort", abortHook, { once: true });
				writer.out.result().finally(() => {
					controller.signal.removeEventListener("abort", abortHook);
					options?.signal?.removeEventListener("abort", onUserAbort);
					release();
				}).catch(() => {});
				existing.resume(writer, context.messages);
				return;
			}

			const run = createRun({ key, signature, tools: bridgeTools, idleMs: RUN_IDLE_TIMEOUT_MS });
			run.background = background;
			run.attach(writer, context.messages);

			const abortHook = () => {
				run.fail(options?.signal?.aborted ? "Request was aborted" : "Antigravity was disabled.", options?.signal?.aborted ? "aborted" : "error");
			};
			controller.signal.addEventListener("abort", abortHook, { once: true });
			writer.out.result().finally(() => {
				controller.signal.removeEventListener("abort", abortHook);
				options?.signal?.removeEventListener("abort", onUserAbort);
				release();
			}).catch(() => {});

			try {
				if (bridgeTools.length > 0) {
					run.bridge = await startMcpBridge({
						tools: () => run.tools,
						call: (req) => run.onBridgeCall(req),
					});
				}
				const session = await openAntigravitySession(run, { binary, model: liveModel, level });
				if (run.closed || controller.signal.aborted) {
					session.dispose();
					return;
				}
				run.session = session;
				const images = liveModel.input.includes("image");
				const prompt = renderTranscript(context.messages, { images });
				if (systemPrompt && prompt[0]?.type === "text") {
					prompt[0] = { type: "text", text: `<system>\n${systemPrompt}\n</system>\n\n${prompt[0].text}` };
				} else if (systemPrompt) {
					prompt.unshift({ type: "text", text: `<system>\n${systemPrompt}\n</system>` });
				}
				session.start(prompt);
			} catch (error) {
				run.fail(error instanceof Error ? error.message : String(error), controller.signal.aborted ? "aborted" : "error");
			}
		})();

		return writer.out;
	};
}
