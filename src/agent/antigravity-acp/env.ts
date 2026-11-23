import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { externalCliEnv } from "../../core/auth-env.ts";

let readAppHeldEnvVars: () => Iterable<string> = () => [];

export function configureAppHeldEnvVars(getter: () => Iterable<string>): void {
	readAppHeldEnvVars = getter;
}

export const REMOVED_ANTIGRAVITY_ENV_KEYS = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_PROJECT_ID",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GCLOUD_PROJECT",
	"CLOUDSDK_CORE_PROJECT",
	"VERTEXAI_PROJECT",
	"VERTEXAI_LOCATION",
	"AGY_ACP_CCPA_PROJECT",
	"AGY_ACP_ENABLE_OAUTH",
	"GEMINI_HOME",
	"GEMINI_CLI_HOME",
	"GEMINI_SYSTEM_MD",
	"GEMINI_WRITE_SYSTEM_MD",
	"AGY_ACP_FORCE_FILE_STORAGE",
	"ANTIGRAVITY_HARNESS_PATH",
	"ANTIGRAVITY_OAUTH_TOKEN",
	"ANTIGRAVITY_API_KEY",
	"ANTIGRAVITY_CLI_ALIAS",
	"NODE_OPTIONS",
	"NODE_DEBUG",
	"NODE_EXTRA_CA_CERTS",
	"ELECTRON_RUN_AS_NODE",
	"CHROME_CRASHPAD_PIPE_NAME",
	"PYTHONUNBUFFERED",
] as const;

export function buildAntigravityChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = externalCliEnv(baseEnv);
	for (const name of readAppHeldEnvVars()) delete env[name];
	for (const key of REMOVED_ANTIGRAVITY_ENV_KEYS) delete env[key];
	return env;
}

export interface BrowserCaptureHandle {
	browserScriptPath: string;
	cleanup(): void;
}

export const AUTH_URL_MARKER = "__LH_AGY_AUTH_URL__:";

/** Writes a temporary executable Node helper used as BROWSER during interactive
 *  sign-in so Antigravity's OAuth URL is captured cleanly via base64url on stderr
 *  without opening a desktop browser or splitting on ":" / ";". */
export function createBrowserCaptureHelper(): BrowserCaptureHandle {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-agy-browser-"));
	const scriptBody = [
		`"use strict";`,
		`const url = process.argv[2] || "";`,
		`const encoded = Buffer.from(url, "utf8").toString("base64url");`,
		`process.stderr.write(${JSON.stringify(AUTH_URL_MARKER)} + encoded + "\\n");`,
	].join("\n");
	if (process.platform === "win32") {
		const jsPath = path.join(dir, "capture.cjs");
		const cmdPath = path.join(dir, "capture.cmd");
		fs.writeFileSync(jsPath, scriptBody, { mode: 0o600 });
		fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" "%~1"\r\n`, { mode: 0o700 });
		return {
			browserScriptPath: cmdPath,
			cleanup: () => fs.rm(dir, { recursive: true, force: true }, () => {}),
		};
	}
	const shPath = path.join(dir, "capture");
	const jsPath = path.join(dir, "capture.cjs");
	fs.writeFileSync(jsPath, scriptBody, { mode: 0o600 });
	fs.writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$1"\n`, { mode: 0o700 });
	return {
		browserScriptPath: shPath,
		cleanup: () => fs.rm(dir, { recursive: true, force: true }, () => {}),
	};
}
