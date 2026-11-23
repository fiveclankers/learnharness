import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject } from "@earendil-works/pi-ai";

export const BRIDGE_SERVER_NAME = "learnharness";
const PROTOCOL_VERSION = "2025-06-18";
const KEEPALIVE_MS = 20_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeTool {
	name: string;
	description: string;
	inputSchema: JsonObject;
}

export interface BridgeToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
}

export interface BridgeToolCall {
	name: string;
	arguments: Record<string, unknown>;
	abandoned: AbortSignal;
}

export interface ToolBridge {
	url: string;
	token: string;
	close(): Promise<void>;
}

interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

function authorized(header: string | undefined, token: string): boolean {
	if (!header) return false;
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startMcpBridge(options: {
	tools: () => BridgeTool[];
	call: (request: BridgeToolCall) => Promise<BridgeToolResult>;
}): Promise<ToolBridge> {
	const token = randomBytes(32).toString("hex");
	const open = new Set<ServerResponse>();

	async function handle(message: JsonRpcMessage, res: ServerResponse, req: IncomingMessage): Promise<object | "streamed" | null> {
		if (!message || typeof message !== "object") return rpcError(null, -32600, "invalid request");
		const id = message.id;
		const isNotification = id === undefined || id === null;
		if (typeof message.method !== "string") {
			return isNotification ? null : rpcError(id, -32600, "method required");
		}
		if (isNotification) return null;
		switch (message.method) {
			case "initialize": {
				const requested = typeof (message.params as { protocolVersion?: unknown })?.protocolVersion === "string"
					? (message.params as { protocolVersion: string }).protocolVersion
					: PROTOCOL_VERSION;
				return rpcResult(id, {
					protocolVersion: requested || PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
				});
			}
			case "ping":
				return rpcResult(id, {});
			case "tools/list":
				return rpcResult(id, { tools: options.tools() });
			case "tools/call": {
				const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
				if (typeof params.name !== "string") return rpcError(id, -32602, "tool name required");
				const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
					? (params.arguments as Record<string, unknown>)
					: {};
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});
				res.flushHeaders();
				const abandoned = new AbortController();
				const keepalive = setInterval(() => {
					if (!res.writableEnded) res.write(": keep-alive\n\n");
				}, KEEPALIVE_MS);
				keepalive.unref();
				const onClose = () => {
					clearInterval(keepalive);
					if (!res.writableEnded) abandoned.abort();
				};
				req.on("close", onClose);
				res.on("close", onClose);
				let result: BridgeToolResult;
				try {
					result = await options.call({ name: params.name, arguments: args, abandoned: abandoned.signal });
				} catch (error) {
					result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
				} finally {
					clearInterval(keepalive);
				}
				if (!res.writableEnded) res.end(`event: message\ndata: ${JSON.stringify(rpcResult(id, result))}\n\n`);
				return "streamed";
			}
			default:
				return rpcError(id, -32601, `method not found: ${message.method}`);
		}
	}

	const server = http.createServer(async (req, res) => {
		open.add(res);
		res.on("close", () => open.delete(res));
		if (!authorized(req.headers.authorization, token)) {
			res.writeHead(401).end();
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(200).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST, DELETE" }).end();
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readBody(req));
		} catch {
			if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(rpcError(null, -32700, "parse error")));
			return;
		}
		const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
		const lone = !Array.isArray(parsed) && messages[0]?.method === "tools/call";
		const replies: object[] = [];
		for (const message of messages) {
			const reply = lone
				? await handle(message, res, req)
				: message?.method === "tools/call"
					? message.id === undefined || message.id === null
						? null
						: rpcError(message.id, -32600, "tools/call cannot be batched")
					: await handle(message, res, req);
			if (reply === "streamed") return;
			if (reply) replies.push(reply);
		}
		if (replies.length === 0) {
			res.writeHead(202).end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
	});

	server.requestTimeout = 0;
	server.headersTimeout = 30_000;
	server.keepAliveTimeout = 60_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		token,
		close: () => new Promise<void>((resolve) => {
			for (const res of open) res.destroy();
			server.close(() => resolve());
			server.closeAllConnections();
		}),
	};
}
