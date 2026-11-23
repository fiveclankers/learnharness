import { createProvider, type Api, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "./constants.ts";

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity (Google)",
		auth: {
			apiKey: {
				name: "Antigravity Google sign-in",
				resolve: async () => ({ auth: {}, source: "antigravity ACP" }),
			},
		},
		models: [],
		api: { stream: streamSimple, streamSimple },
	});
}
