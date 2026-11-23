import { antigravityBrowserResponse } from "@/src/server";

export async function GET(request: Request) {
	return antigravityBrowserResponse(request);
}
