import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "codex-subscription-usage";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type UsageWindow = {
	used_percent?: number;
	reset_after_seconds?: number;
	limit_window_seconds?: number;
};

type UsageResponse = {
	plan_type?: string;
	rate_limit?: {
		primary_window?: UsageWindow;
		secondary_window?: UsageWindow;
	};
};

type AuthFile = {
	"openai-codex"?: { accountId?: string };
};

function formatDuration(seconds: number | undefined): string {
	if (seconds === undefined || !Number.isFinite(seconds)) return "?";
	const minutes = Math.max(0, Math.ceil(seconds / 60));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
}

function windowLabel(window: UsageWindow | undefined, fallback: string): string | undefined {
	if (!window || typeof window.used_percent !== "number") return undefined;
	const hours = window.limit_window_seconds
		? Math.round(window.limit_window_seconds / 3600)
		: undefined;
	const period = hours === 168 ? "week" : hours ? `${hours}h` : fallback;
	return `${period} ${Math.round(window.used_percent)}% ↻${formatDuration(window.reset_after_seconds)}`;
}

async function getCredentials(): Promise<{ token: string; accountId: string }> {
	// Ask Pi for the token so an expired OAuth credential is refreshed safely.
	const { stdout } = await execFileAsync(
		"pi",
		["auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "10m"],
		{ timeout: 20_000, maxBuffer: 1024 * 1024 },
	);
	const token = stdout.trim();
	if (!token) throw new Error("Pi returned an empty Codex bearer token");

	const auth = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as AuthFile;
	const accountId = auth["openai-codex"]?.accountId;
	if (!accountId) throw new Error("No ChatGPT account ID found; run /login openai-codex");
	return { token, accountId };
}

async function fetchUsage(): Promise<UsageResponse> {
	const { token, accountId } = await getCredentials();
	const response = await fetch(USAGE_URL, {
		headers: {
			Authorization: `Bearer ${token}`,
			"ChatGPT-Account-Id": accountId,
		},
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`usage endpoint returned HTTP ${response.status}`);
	return (await response.json()) as UsageResponse;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let lastContext: ExtensionContext | undefined;

	const refresh = async (ctx: ExtensionContext, notifyOnError = false) => {
		if (refreshing) return;
		refreshing = true;
		try {
			const usage = await fetchUsage();
			const primary = windowLabel(usage.rate_limit?.primary_window, "primary");
			const secondary = windowLabel(usage.rate_limit?.secondary_window, "secondary");
			const metrics = [primary, secondary].filter(Boolean).join(" · ");
			if (!metrics) throw new Error("usage endpoint did not return rate-limit windows");
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Codex ${metrics}`));
			if (notifyOnError) ctx.ui.notify(`Codex subscription usage refreshed: ${metrics}`, "info");
		} catch (error) {
			if (notifyOnError) {
				ctx.ui.notify(`Could not refresh Codex usage: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} finally {
			refreshing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		await refresh(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (lastContext) void refresh(lastContext);
		}, REFRESH_INTERVAL_MS);
	});

	pi.on("turn_end", async (_event, ctx) => {
		lastContext = ctx;
		await refresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("usage", {
		description: "Refresh ChatGPT/Codex subscription usage in the footer",
		handler: async (_args, ctx) => {
			lastContext = ctx;
			await refresh(ctx, true);
		},
	});
}
