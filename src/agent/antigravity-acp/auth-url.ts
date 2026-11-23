import { randomUUID } from "node:crypto";
import http from "node:http";
import { AUTH_URL_MARKER } from "./env.ts";

export interface ValidatedOAuthUrl {
	url: string;
	port: number;
	state: string;
}

const AUTH_LINE_PREFIX = "Open the following link to authenticate";

export function parseValidatedGoogleOAuthUrl(rawUrl: string): ValidatedOAuthUrl | null {
	try {
		const trimmed = rawUrl.trim();
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com" || parsed.pathname !== "/o/oauth2/v2/auth") {
			return null;
		}
		if (parsed.username || parsed.password || parsed.hash) return null;
		const states = parsed.searchParams.getAll("state");
		if (states.length !== 1 || !states[0]) return null;
		const responseTypes = parsed.searchParams.getAll("response_type");
		if (responseTypes.length !== 1 || responseTypes[0] !== "code") return null;
		const redirects = parsed.searchParams.getAll("redirect_uri");
		if (redirects.length !== 1) return null;
		const redirect = new URL(redirects[0]!);
		if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1") return null;
		if (!/^\d+$/.test(redirect.port)) return null;
		const port = Number(redirect.port);
		if (!Number.isInteger(port) || port < 1024 || port > 65_535) return null;
		return { url: parsed.toString(), port, state: states[0]! };
	} catch {
		return null;
	}
}

export function extractAuthUrlFromLine(line: string): ValidatedOAuthUrl | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const markerIndex = trimmed.indexOf(AUTH_URL_MARKER);
	if (markerIndex >= 0) {
		const payload = trimmed.slice(markerIndex + AUTH_URL_MARKER.length).trim();
		try {
			const decoded = Buffer.from(payload, "base64url").toString("utf8");
			return parseValidatedGoogleOAuthUrl(decoded);
		} catch {
			return null;
		}
	}
	const urlMatch = trimmed.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\S+/);
	if (urlMatch) return parseValidatedGoogleOAuthUrl(urlMatch[0]);
	return null;
}

/** Filters non-JSON stdout auth chatter before ACP ndJsonStream parses JSON-RPC. */
export function createStdoutJsonLineFilter(onAuthUrl: (validated: ValidatedOAuthUrl) => void): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";
	const forwardLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		if (trimmed.startsWith(AUTH_LINE_PREFIX) || trimmed.includes(AUTH_URL_MARKER)) {
			const found = extractAuthUrlFromLine(trimmed);
			if (found) onAuthUrl(found);
			return;
		}
		if (!trimmed.startsWith("{")) {
			const found = extractAuthUrlFromLine(trimmed);
			if (found) onAuthUrl(found);
			return;
		}
		controller.enqueue(encoder.encode(`${trimmed}\n`));
	};
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			for (;;) {
				const nl = buffer.indexOf("\n");
				if (nl < 0) break;
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				forwardLine(line, controller);
			}
		},
		flush(controller) {
			const tail = buffer + decoder.decode();
			if (tail.trim()) forwardLine(tail, controller);
		},
	});
}

export class BrowserActionStore {
	private pendingBrowser: { id: string; url: string } | null = null;
	private activeCallback: { port: number; state: string } | null = null;

	set(auth: ValidatedOAuthUrl): { id: string } {
		const id = randomUUID();
		this.pendingBrowser = { id, url: auth.url };
		this.activeCallback = { port: auth.port, state: auth.state };
		return { id };
	}

	current(): { id?: string; auth: { port: number; state: string } } | null {
		if (!this.activeCallback) return null;
		return {
			...(this.pendingBrowser ? { id: this.pendingBrowser.id } : {}),
			auth: this.activeCallback,
		};
	}

	take(id: string): string | null {
		if (!this.pendingBrowser || this.pendingBrowser.id !== id) return null;
		const url = this.pendingBrowser.url;
		this.pendingBrowser = null;
		return url;
	}

	clear(): void {
		this.pendingBrowser = null;
		this.activeCallback = null;
	}
}

export function validateManualCallbackUrl(rawUrl: string, expected: { port: number; state: string }): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		throw new Error("Enter a valid callback URL copied from your browser address bar.");
	}
	if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
		throw new Error("Callback URL must target the local loopback listener (http://127.0.0.1 or http://localhost).");
	}
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port !== expected.port) {
		throw new Error("Callback URL port does not match the active sign-in attempt.");
	}
	const states = parsed.searchParams.getAll("state");
	if (states.length !== 1 || states[0] !== expected.state) {
		throw new Error("Callback URL state does not match the active sign-in attempt.");
	}
	if (!parsed.searchParams.get("code") && !parsed.searchParams.get("error")) {
		throw new Error("Callback URL is missing the authorization code.");
	}
	return parsed;
}

export async function forwardLoopbackCallback(rawUrl: string, expected: { port: number; state: string }): Promise<void> {
	const validated = validateManualCallbackUrl(rawUrl, expected);
	const pathWithQuery = `${validated.pathname}${validated.search}`;
	await new Promise<void>((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: expected.port,
				path: pathWithQuery,
				method: "GET",
				agent: false,
				timeout: 10_000,
			},
			(res) => {
				res.resume();
				if ((res.statusCode ?? 500) >= 400) {
					reject(new Error(`Local sign-in listener rejected callback (HTTP ${res.statusCode}).`));
					return;
				}
				resolve();
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Local sign-in callback request timed out."));
		});
		req.on("error", (err) => {
			reject(new Error(`Could not deliver sign-in callback: ${err.message}`));
		});
		req.end();
	});
}
