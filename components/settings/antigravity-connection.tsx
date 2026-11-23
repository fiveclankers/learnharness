"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ANTIGRAVITY_PROVIDER, type AntigravityStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

const REQUEST_HEADERS = {
	"Content-Type": "application/json",
	"x-learnharness-antigravity": "1",
};

function isAntigravityStatus(value: unknown): value is AntigravityStatus {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.installed === "boolean" &&
		typeof v.enabled === "boolean" &&
		typeof v.allowBackgroundUse === "boolean" &&
		typeof v.signedIn === "boolean" &&
		typeof v.signingIn === "boolean" &&
		typeof v.connected === "boolean" &&
		Array.isArray(v.models)
	);
}

export function AntigravityConnection({ setup = false }: { setup?: boolean }) {
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [callbackUrl, setCallbackUrl] = useState("");
	const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	const mounted = useRef(true);

	const load = useCallback(async (force = false) => {
		try {
			const res = await fetch(force ? "/api/antigravity?force=1" : "/api/antigravity", {
				cache: "no-store",
				headers: { "x-learnharness-antigravity": "1" },
			});
			if (!res.ok) return;
			const data: unknown = await res.json();
			if (mounted.current && isAntigravityStatus(data)) {
				setStatus(data);
				setError(null);
			}
		} catch {
			// Ignore silent read failures when Settings mounts under mocked fetches.
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load(false);
		return () => {
			mounted.current = false;
			if (pollTimer.current) clearInterval(pollTimer.current);
		};
	}, [load]);

	useEffect(() => {
		if (!status?.signingIn) {
			if (pollTimer.current) {
				clearInterval(pollTimer.current);
				pollTimer.current = null;
			}
			return;
		}
		if (pollTimer.current) return;
		pollTimer.current = setInterval(() => {
			void load(false).then(() => {
				// Poll finishes when signingIn flips false; keys signal fires via mutate or transition below.
			});
		}, 1_500);
		return () => {
			if (pollTimer.current) {
				clearInterval(pollTimer.current);
				pollTimer.current = null;
			}
		};
	}, [status?.signingIn, load]);

	const wasConnected = useRef<boolean | null>(null);
	useEffect(() => {
		if (!status) return;
		if (wasConnected.current !== null && wasConnected.current !== status.connected) {
			notifySettingsSaved("keys");
		}
		wasConnected.current = status.connected;
	}, [status]);

	const mutate = async (payload: Record<string, unknown>, notifyCatalog = true) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/antigravity", {
				method: "POST",
				headers: REQUEST_HEADERS,
				body: JSON.stringify(payload),
			});
			const data = (await res.json().catch(() => null)) as unknown;
			if (!res.ok) {
				const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
				if (mounted.current) setError(msg);
				return null;
			}
			if (mounted.current && isAntigravityStatus(data)) {
				setStatus(data);
				if (notifyCatalog) notifySettingsSaved("keys");
				return data;
			}
		} catch {
			if (mounted.current) setError("Could not reach Antigravity service. Try again.");
		} finally {
			if (mounted.current) setBusy(false);
		}
		return null;
	};

	const enabled = status?.enabled ?? false;
	const modelCount = status?.models.length ?? 0;

	return (
		<div className="space-y-2 border-t border-border/50 pt-3" data-testid="antigravity-connection">
			<div className="flex flex-wrap items-center gap-3">
				<span className={setup ? "font-ui text-xs text-foreground" : "font-prose text-(length:--lh-prose-size) text-foreground"}>
					Antigravity (Google)
				</span>
				<Toggle
					label="Antigravity (Google)"
					checked={enabled}
					disabled={busy}
					onChange={(next) => void mutate({ action: "enable", enabled: next })}
				/>
			</div>

			{enabled && (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span role="status" data-testid="antigravity-status" className="text-xs text-muted-foreground">
							{busy && !status?.signingIn
								? "Checking…"
								: !status?.installed
									? "CLI ('agy') not found"
									: status.signingIn
										? "Waiting for Google sign-in…"
										: status.connected
											? `Connected · ${modelCount} model${modelCount === 1 ? "" : "s"}`
											: status.signedIn
												? "Signed in · 0 models loaded"
												: "Not signed in"}
						</span>
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="cursor-pointer disabled:cursor-not-allowed"
							disabled={busy}
							onClick={() => void mutate({ action: "refresh" })}
							data-testid="antigravity-refresh"
						>
							Refresh models
						</Button>
						{status?.installed && !status.signingIn && (
							<Button
								type="button"
								size="xs"
								variant="outline"
								className="cursor-pointer disabled:cursor-not-allowed"
								disabled={busy}
								onClick={() => void mutate({ action: "signIn" }, false)}
								data-testid="antigravity-signin"
							>
								{status.signedIn ? "Sign in again" : "Sign in with Google"}
							</Button>
						)}
						{status?.signingIn && (
							<Button
								type="button"
								size="xs"
								variant="ghost"
								disabled={busy}
								onClick={() => void mutate({ action: "cancelSignIn" }, false)}
								data-testid="antigravity-cancel-signin"
							>
								Cancel sign-in
							</Button>
						)}
					</div>

					{status?.signingIn && (
						<div className="space-y-2 rounded-sm border border-border/70 bg-background/50 p-2.5 text-xs" data-testid="antigravity-signin-panel">
							{status.browserAction && (
								<div className="flex flex-wrap items-center gap-2">
									<a
										href={`/api/antigravity/browser?id=${encodeURIComponent(status.browserAction.id)}`}
										target="_blank"
										rel="noreferrer"
										data-testid="antigravity-browser-link"
										className="inline-flex h-7 items-center rounded-sm border border-border bg-background px-2.5 font-ui text-xs text-foreground hover:border-muted-foreground/50"
									>
										Open Google sign-in ↗
									</a>
									<span className="text-muted-foreground">Complete login in your browser, or paste the callback URL below if redirected to localhost/127.0.0.1.</span>
								</div>
							)}
							{status.needsManualCallback && (
								<form
									className="flex items-center gap-2"
									onSubmit={(e) => {
										e.preventDefault();
										if (!callbackUrl.trim()) return;
										void mutate({ action: "submitCallback", url: callbackUrl.trim() }).then((next) => {
											if (next) setCallbackUrl("");
										});
									}}
								>
									<input
										type="text"
										value={callbackUrl}
										onChange={(e) => setCallbackUrl(e.target.value)}
										placeholder="Paste http://127.0.0.1:.../?code=... callback URL"
										aria-label="Google sign-in callback URL"
										data-testid="antigravity-callback-input"
										className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/50"
									/>
									<Button type="submit" size="xs" variant="outline" disabled={busy || !callbackUrl.trim()} data-testid="antigravity-callback-submit">
										Complete login
									</Button>
								</form>
							)}
						</div>
					)}

					<div className="flex items-center gap-3 text-xs text-foreground">
						<Toggle
							label="Allow Antigravity background use"
							checked={status?.allowBackgroundUse ?? true}
							disabled={busy}
							onChange={(next) => void mutate({ action: "consent", allowBackgroundUse: next }, false)}
						/>
						<span className="text-muted-foreground">Allow background helper agents to use Antigravity.</span>
					</div>

					{(error || status?.error) && (
						<p role="alert" data-testid="antigravity-error" className="text-xs text-error">
							{error ?? status?.error}
						</p>
					)}

					<p className="text-xs leading-relaxed text-muted-foreground">
						Drives the local Antigravity CLI (<code className="font-mono">agy acp</code>) using your Google account and shared CLI profile. Refresh anytime to pull updated models.
					</p>
				</div>
			)}
			{!enabled && error && (
				<p role="alert" data-testid="antigravity-error" className="text-xs text-error">
					{error}
				</p>
			)}
		</div>
	);
}

export function AntigravityBackgroundAccess({ provider }: { provider: string | undefined }) {
	const [needed, setNeeded] = useState(false);
	useEffect(() => {
		if (provider !== ANTIGRAVITY_PROVIDER) {
			setNeeded(false);
			return;
		}
		let cancelled = false;
		fetch("/api/antigravity", { cache: "no-store", headers: { "x-learnharness-antigravity": "1" } })
			.then((r) => (r.ok ? r.json() : null))
			.then((data: AntigravityStatus | null) => {
				if (!cancelled && data?.connected && !data.allowBackgroundUse) setNeeded(true);
				else if (!cancelled) setNeeded(false);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [provider]);

	if (provider !== ANTIGRAVITY_PROVIDER || !needed) return null;
	return (
		<Button
			type="button"
			size="xs"
			variant="ghost"
			onClick={() => {
				void fetch("/api/antigravity", {
					method: "POST",
					headers: REQUEST_HEADERS,
					body: JSON.stringify({ action: "consent", allowBackgroundUse: true }),
				})
					.then((r) => (r.ok ? r.json() : null))
					.then(() => {
						setNeeded(false);
						notifySettingsSaved("keys");
					})
					.catch(() => {});
			}}
		>
			Enable background use
		</Button>
	);
}
