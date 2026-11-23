import { createHash, randomUUID } from "node:crypto";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import type { BridgeTool, BridgeToolCall, BridgeToolResult, ToolBridge } from "./mcp-bridge.ts";
import type { PromptBlock } from "./transcript.ts";

export interface RunSession {
	start(prompt: PromptBlock[]): void;
	dispose(): void;
}

export class StepWriter {
	readonly out: AssistantMessageEventStream = createAssistantMessageEventStream();
	readonly partial: AssistantMessage;
	private openBlock?: { kind: "text" | "thinking"; index: number };
	private _ended = false;

	constructor(model: Model<Api>) {
		this.partial = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.out.push({ type: "start", partial: this.partial });
	}

	get ended(): boolean {
		return this._ended;
	}

	private closeBlock(): void {
		if (!this.openBlock) return;
		const { kind, index } = this.openBlock;
		const block = this.partial.content[index];
		if (kind === "text" && block?.type === "text") {
			this.out.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.partial });
		} else if (kind === "thinking" && block?.type === "thinking") {
			this.out.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.partial });
		}
		this.openBlock = undefined;
	}

	text(delta: string): void {
		if (this._ended || !delta) return;
		if (this.openBlock?.kind !== "text") {
			this.closeBlock();
			this.partial.content.push({ type: "text", text: "" });
			this.openBlock = { kind: "text", index: this.partial.content.length - 1 };
			this.out.push({ type: "text_start", contentIndex: this.openBlock.index, partial: this.partial });
		}
		(this.partial.content[this.openBlock.index] as { text: string }).text += delta;
		this.out.push({ type: "text_delta", contentIndex: this.openBlock.index, delta, partial: this.partial });
	}

	thinking(delta: string): void {
		if (this._ended || !delta) return;
		if (this.openBlock?.kind !== "thinking") {
			this.closeBlock();
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.openBlock = { kind: "thinking", index: this.partial.content.length - 1 };
			this.out.push({ type: "thinking_start", contentIndex: this.openBlock.index, partial: this.partial });
		}
		(this.partial.content[this.openBlock.index] as { thinking: string }).thinking += delta;
		this.out.push({ type: "thinking_delta", contentIndex: this.openBlock.index, delta, partial: this.partial });
	}

	toolCall(call: { id: string; name: string; arguments: Record<string, unknown> }): void {
		if (this._ended) return;
		this.closeBlock();
		const block: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments as ToolCall["arguments"] };
		this.partial.content.push(block);
		const index = this.partial.content.length - 1;
		this.out.push({ type: "toolcall_start", contentIndex: index, partial: this.partial });
		this.out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.partial });
	}

	get toolCallIds(): string[] {
		return this.partial.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));
	}

	usage(usage: Partial<Omit<Usage, "cost" | "totalTokens">>): void {
		const u = this.partial.usage;
		Object.assign(u, usage);
		u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
	}

	done(reason: "stop" | "length" | "toolUse"): void {
		if (this._ended) return;
		this.closeBlock();
		this._ended = true;
		this.partial.stopReason = reason;
		this.out.push({ type: "done", reason, message: this.partial });
		this.out.end();
	}

	fail(reason: "error" | "aborted", message: string): void {
		if (this._ended) return;
		this.closeBlock();
		this._ended = true;
		this.partial.stopReason = reason;
		this.partial.errorMessage = message;
		this.out.push({ type: "error", reason, error: this.partial });
		this.out.end();
	}
}

export function toBridgeResult(result: ToolResultMessage): BridgeToolResult {
	const content: BridgeToolResult["content"] = result.content.map((part) =>
		part.type === "image" ? { type: "image", data: part.data, mimeType: part.mimeType } : { type: "text", text: part.text },
	);
	return { content: content.length ? content : [{ type: "text", text: "" }], ...(result.isError ? { isError: true } : {}) };
}

function messageKey(message: Message): string {
	let key: string;
	if (message.role === "user") {
		key = `u:${typeof message.content === "string" ? message.content : message.content.map((p) => (p.type === "text" ? p.text : `[${p.mimeType}]`)).join("\n")}`;
	} else if (message.role === "assistant") {
		key = `a:${message.content.map((p) => (p.type === "text" ? p.text : p.type === "toolCall" ? `#${p.id}` : "")).join("")}`;
	} else if (message.role === "toolResult") {
		key = `r:${message.toolCallId}`;
	} else {
		key = message.role;
	}
	return createHash("sha1").update(key).digest("base64");
}

export function conversationKeys(messages: readonly Message[]): string[] {
	return messages.filter((m) => m.role !== "system").map(messageKey);
}

interface CallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	answer?: (result: BridgeToolResult) => void;
}

const SURFACE_DEBOUNCE_MS = 150;

export interface AntigravityRunOptions {
	key: string;
	signature: string;
	tools: BridgeTool[];
	idleMs: number;
	onClosed: (run: AntigravityRun) => void;
}

export class AntigravityRun {
	readonly key: string;
	readonly signature: string;
	readonly tools: BridgeTool[];
	private state: "running" | "parked" | "closed" = "running";
	private writer?: StepWriter;
	private calls: CallRecord[] = [];
	private unsurfaced: CallRecord[] = [];
	private buffered: Array<{ kind: "text" | "thinking"; delta: string }> = [];
	private surfaceTimer?: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private stepKeys: string[] = [];
	private seenKeys: string[] = [];
	session?: RunSession;
	bridge?: ToolBridge;
	background = false;
	lastUsed = Date.now();

	constructor(private readonly options: AntigravityRunOptions) {
		this.key = options.key;
		this.signature = options.signature;
		this.tools = options.tools;
	}

	get closed(): boolean {
		return this.state === "closed";
	}

	get parked(): boolean {
		return this.state === "parked";
	}

	attach(writer: StepWriter, messages: readonly Message[]): void {
		this.writer = writer;
		this.state = "running";
		this.stepKeys = conversationKeys(messages);
	}

	text(delta: string): void {
		if (this.writer && !this.writer.ended) this.writer.text(delta);
		else if (delta) this.buffered.push({ kind: "text", delta });
	}

	thinking(delta: string): void {
		if (this.writer && !this.writer.ended) this.writer.thinking(delta);
		else if (delta) this.buffered.push({ kind: "thinking", delta });
	}

	endTurn(reason: "stop" | "length"): void {
		if (this.writer && !this.writer.ended) {
			if (this.writer.toolCallIds.length > 0) {
				clearTimeout(this.surfaceTimer);
				this.park();
				this.close();
				return;
			}
			this.flushBuffered();
			this.finish(reason);
		} else {
			this.close();
		}
	}

	fail(message: string, reason: "error" | "aborted" = "error"): void {
		this.writer?.fail(reason, message);
		this.close();
	}

	onBridgeCall(request: BridgeToolCall): Promise<BridgeToolResult> {
		if (this.closed) {
			return Promise.resolve({ content: [{ type: "text", text: "The session ended before the tool could run." }], isError: true });
		}
		if (!this.tools.some((t) => t.name === request.name)) {
			return Promise.resolve({ content: [{ type: "text", text: `Unknown tool: ${request.name}` }], isError: true });
		}
		if (this.state !== "running") {
			this.close();
			return Promise.resolve({ content: [{ type: "text", text: "The tool arrived outside an active step." }], isError: true });
		}
		const record: CallRecord = { id: `agy-${randomUUID()}`, name: request.name, arguments: request.arguments };
		this.calls.push(record);
		return this.awaitResult(record, request);
	}

	private awaitResult(record: CallRecord, request: BridgeToolCall): Promise<BridgeToolResult> {
		return new Promise<BridgeToolResult>((resolve) => {
			let settled = false;
			const settle = (result: BridgeToolResult) => {
				if (settled) return;
				settled = true;
				record.answer = undefined;
				resolve(result);
			};
			record.answer = settle;
			request.abandoned.addEventListener("abort", () => {
				this.calls = this.calls.filter((c) => c !== record);
				settle({ content: [{ type: "text", text: "Tool call cancelled." }], isError: true });
			}, { once: true });
			this.unsurfaced.push(record);
			if (!this.surfaceTimer) {
				this.surfaceTimer = setTimeout(() => {
					this.surfaceTimer = undefined;
					if (this.state !== "running" || !this.writer || this.writer.ended || !this.unsurfaced.length) return;
					for (const call of this.unsurfaced) this.writer.toolCall(call);
					this.unsurfaced = [];
					this.park();
				}, SURFACE_DEBOUNCE_MS);
				this.surfaceTimer.unref?.();
			}
		});
	}

	canResume(messages: readonly Message[], signature: string): boolean {
		if (this.state !== "parked" || this.signature !== signature) return false;
		const keys = conversationKeys(messages);
		if (keys.length < this.seenKeys.length) return false;
		for (let i = 0; i < this.seenKeys.length; i++) if (keys[i] !== this.seenKeys[i]) return false;
		const results = new Map<string, ToolResultMessage>();
		for (let i = this.seenKeys.length; i < keys.length; i++) {
			const msg = messages.filter((m) => m.role !== "system")[i];
			if (msg?.role !== "toolResult") return false;
			results.set(msg.toolCallId, msg);
		}
		return this.calls.length > 0 && this.calls.every((c) => results.has(c.id));
	}

	resume(writer: StepWriter, messages: readonly Message[]): void {
		clearTimeout(this.idleTimer);
		this.attach(writer, messages);
		const results = new Map(
			messages
				.filter((m): m is ToolResultMessage => m.role === "toolResult")
				.map((r) => [r.toolCallId, r]),
		);
		const pending = this.calls;
		this.calls = [];
		this.flushBuffered();
		for (const call of pending) {
			const result = results.get(call.id);
			call.answer?.(result ? toBridgeResult(result) : { content: [{ type: "text", text: "Missing tool result." }], isError: true });
		}
	}

	private flushBuffered(): void {
		if (!this.writer || this.writer.ended) return;
		for (const item of this.buffered) {
			if (item.kind === "text") this.writer.text(item.delta);
			else this.writer.thinking(item.delta);
		}
		this.buffered = [];
	}

	private park(): void {
		if (this.writer) this.seenKeys = [...this.stepKeys, messageKey(this.writer.partial)];
		this.writer?.done("toolUse");
		this.writer = undefined;
		this.state = "parked";
		this.lastUsed = Date.now();
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close(), this.options.idleMs);
		this.idleTimer.unref?.();
	}

	private finish(reason: "stop" | "length"): void {
		this.writer?.done(reason);
		this.close();
	}

	close(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		clearTimeout(this.idleTimer);
		clearTimeout(this.surfaceTimer);
		this.writer?.fail("error", "The Antigravity session closed.");
		const closedMessage = { content: [{ type: "text" as const, text: "The session closed before the tool result arrived." }], isError: true };
		for (const call of this.calls) call.answer?.(closedMessage);
		this.calls = [];
		this.unsurfaced = [];
		this.session?.dispose();
		void this.bridge?.close();
		this.options.onClosed(this);
	}
}

const MAX_RUNS = 6;
const REGISTRY = Symbol.for("lh.antigravity.runs");

function registry(): Map<string, AntigravityRun> {
	const g = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, AntigravityRun> };
	if (!g[REGISTRY]) {
		const runs = new Map<string, AntigravityRun>();
		g[REGISTRY] = runs;
		process.once("exit", () => {
			for (const run of [...runs.values()]) run.close();
		});
	}
	return g[REGISTRY];
}

export function findRun(key: string): AntigravityRun | undefined {
	return registry().get(key);
}

export function createRun(options: Omit<AntigravityRunOptions, "onClosed">): AntigravityRun {
	const runs = registry();
	runs.get(options.key)?.close();
	const parked = [...runs.values()].filter((run) => run.parked).sort((a, b) => a.lastUsed - b.lastUsed);
	while (runs.size >= MAX_RUNS && parked.length) parked.shift()!.close();
	const run = new AntigravityRun({
		...options,
		onClosed: (closed) => {
			if (runs.get(closed.key) === closed) runs.delete(closed.key);
		},
	});
	runs.set(options.key, run);
	return run;
}

export function closeAntigravityRuns(options: { backgroundOnly?: boolean } = {}): void {
	for (const run of [...registry().values()]) {
		if (!options.backgroundOnly || run.background) run.close();
	}
}
