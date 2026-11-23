import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ANTIGRAVITY_API, ANTIGRAVITY_CACHE_TTL_MS, ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export { ANTIGRAVITY_API, ANTIGRAVITY_CACHE_TTL_MS, ANTIGRAVITY_PROVIDER };

export const ANTIGRAVITY_UNAVAILABLE = "Antigravity ACP is unavailable. Enable and set it up in Settings → Providers.";
export const PROTOCOL_VERSION = 1;
export const REQUEST_TIMEOUT_MS = 60_000;
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
export const RUN_IDLE_TIMEOUT_MS = 10 * 60_000;
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
