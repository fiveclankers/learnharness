import { antigravityMutationResponse, antigravityStatusResponse } from "@/src/server";

export async function GET(request: Request) {
	return antigravityStatusResponse(request);
}

export async function POST(request: Request) {
	return antigravityMutationResponse(request);
}
