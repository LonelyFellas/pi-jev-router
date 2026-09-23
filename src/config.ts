import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouterConfig } from "./types.ts";

const DEFAULT_CONFIG: RouterConfig = {
	mode: "auto",
	fallbackModelRef: undefined,
	candidates: [],
	jev: {
		baseUrl: "https://api.typesafe.ai",
		apiKeyEnv: "TYPESAFE_API_KEY",
		timeoutMs: 5000,
	},
};

/**
 * Load router config from:
 *   1. ~/.pi/agent/pi-jev-router.json (global)
 *   2. .pi/pi-jev-router.json (project-local, overrides)
 * Falls back to defaults. Missing files are fine.
 */
export async function loadConfig(cwd: string, home: string): Promise<RouterConfig> {
	let config = { ...DEFAULT_CONFIG, jev: { ...DEFAULT_CONFIG.jev } };

	for (const path of [
		join(home, ".pi", "agent", "pi-jev-router.json"),
		join(cwd, ".pi", "pi-jev-router.json"),
	]) {
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as Partial<RouterConfig>;
			config = {
				...config,
				...parsed,
				jev: { ...config.jev, ...(parsed.jev ?? {}) },
			};
		} catch {
			// Missing or invalid file: keep existing config.
		}
	}

	return config;
}
