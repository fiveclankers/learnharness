import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AntigravityBinaryKind = "cli" | "legacy-server";

export interface ResolvedAntigravityBinary {
	path: string;
	kind: AntigravityBinaryKind;
}

const MODERN_NAMES = process.platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy", "antigravity"];
const LEGACY_NAMES = process.platform === "win32" ? ["agy_acp_server.exe"] : ["agy_acp_server.par", "agy_acp_server"];

function knownDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string): string[] {
	if (platform === "win32") {
		const localAppData = env.LOCALAPPDATA ?? path.win32.join(homeDir, "AppData", "Local");
		return [
			path.win32.join(localAppData, "Programs", "antigravity"),
			path.win32.join(localAppData, "antigravity", "bin"),
			path.win32.join(homeDir, ".local", "opt", "agy-acp", "current"),
			path.win32.join(homeDir, ".local", "bin"),
		];
	}
	return [
		path.posix.join(homeDir, ".local", "opt", "agy-acp", "current"),
		path.posix.join(homeDir, ".gemini", "antigravity-cli", "bin"),
		path.posix.join(homeDir, ".antigravity", "bin"),
		path.posix.join(homeDir, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		...(env.USER ? [path.posix.join("/etc/profiles/per-user", env.USER, "bin")] : []),
		path.posix.join(homeDir, ".nix-profile", "bin"),
		"/run/current-system/sw/bin",
	];
}

function isExecutableFile(candidate: string): boolean {
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function resolveFromDirs(
	dirs: readonly string[],
	names: readonly string[],
	paths: path.PlatformPath,
	isExecutable: (p: string) => boolean,
): string | null {
	for (const name of names) {
		for (const dir of dirs) {
			const candidate = paths.resolve(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}

function loginShellPath(env: NodeJS.ProcessEnv): Promise<string[]> {
	if (process.platform === "win32") return Promise.resolve([]);
	const shell = env.SHELL && env.SHELL.startsWith("/") ? env.SHELL : "/bin/sh";
	const start = "__LH_PATH_START__";
	const end = "__LH_PATH_END__";
	return new Promise((resolve) => {
		execFile(
			shell,
			["-lc", `printf "${start}%s${end}" "$PATH"`],
			{ timeout: 3_000, env },
			(error, stdout) => {
				if (error || typeof stdout !== "string") {
					resolve([]);
					return;
				}
				const a = stdout.indexOf(start);
				const b = stdout.indexOf(end, a + start.length);
				if (a < 0 || b < 0) {
					resolve([]);
					return;
				}
				resolve(stdout.slice(a + start.length, b).split(path.posix.delimiter).filter(Boolean));
			},
		);
	});
}

export function classifyAntigravityBinary(filePath: string): AntigravityBinaryKind {
	const base = path.basename(filePath).toLowerCase();
	return base.includes("agy_acp_server") ? "legacy-server" : "cli";
}

export function antigravityServerArgs(kind: AntigravityBinaryKind, homeDir = os.homedir()): string[] {
	if (kind === "legacy-server") return process.platform === "linux" ? ["--uid="] : [];
	return ["acp", "--gemini-dir", path.join(homeDir, ".gemini"), "--app-data-dir", "antigravity-acp"];
}

export function antigravityProfileDir(homeDir = os.homedir()): string {
	return path.join(homeDir, ".gemini", "antigravity-acp");
}

export function ensureAntigravityProfileDir(homeDir = os.homedir()): string {
	const geminiDir = path.join(homeDir, ".gemini");
	const profileDir = antigravityProfileDir(homeDir);
	fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
	return profileDir;
}

export interface BinaryResolverOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homeDir?: string;
	isExecutable?: (filePath: string) => boolean;
	getShellPath?: () => Promise<string[]>;
}

export async function resolveAntigravityBinary(options: BinaryResolverOptions = {}): Promise<ResolvedAntigravityBinary | null> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const isExecutable = options.isExecutable ?? isExecutableFile;
	const paths = platform === "win32" ? path.win32 : path.posix;

	const override = env.AGY_ACP_BIN?.trim();
	if (override) {
		const resolved = path.isAbsolute(override) ? override : paths.resolve(override);
		if (isExecutable(resolved)) return { path: resolved, kind: classifyAntigravityBinary(resolved) };
		return null;
	}

	const pathDirs = (env.PATH ?? "").split(paths.delimiter).filter(Boolean);
	const known = knownDirs(platform, env, homeDir);
	const allNames = [...MODERN_NAMES, ...LEGACY_NAMES];

	const direct = resolveFromDirs([...pathDirs, ...known], allNames, paths, isExecutable);
	if (direct) return { path: direct, kind: classifyAntigravityBinary(direct) };

	const shellDirs = await (options.getShellPath ?? (() => loginShellPath(env)))();
	if (shellDirs.length > 0) {
		const fromShell = resolveFromDirs(shellDirs, allNames, paths, isExecutable);
		if (fromShell) return { path: fromShell, kind: classifyAntigravityBinary(fromShell) };
	}

	return null;
}
