import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATUS_KEY = "codex-fast-mode";
const STATE_PATH = join(getAgentDir(), "codex-fast-mode.json");
const FAST_THINKING_LEVEL: ThinkingLevel = "low";

type State = {
	enabled: boolean;
	previousThinkingLevel?: ThinkingLevel;
};

const VALID_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
let state: State = { enabled: false };
let loaded = false;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_LEVELS.has(value);
}

async function loadState(): Promise<State> {
	if (loaded) return state;
	loaded = true;
	try {
		const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
		state = {
			enabled: Boolean(parsed.enabled),
			previousThinkingLevel: isThinkingLevel(parsed.previousThinkingLevel) ? parsed.previousThinkingLevel : undefined,
		};
	} catch {
		state = { enabled: false };
	}
	return state;
}

async function saveState(next: State): Promise<void> {
	state = next;
	loaded = true;
	await mkdir(dirname(STATE_PATH), { recursive: true });
	await writeFile(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function isCodexContext(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return model?.provider === "openai-codex" || /codex/i.test(model?.provider ?? "");
}

function updateStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		STATUS_KEY,
		state.enabled ? "Codex fast: on" : ctx.ui.theme.fg("dim", "Codex fast: off"),
	);
}

async function applyFastMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await loadState();
	updateStatus(ctx);
	if (!state.enabled || !isCodexContext(ctx)) return;

	if (!state.previousThinkingLevel) {
		state.previousThinkingLevel = pi.getThinkingLevel();
		await saveState(state);
	}

	if (pi.getThinkingLevel() !== FAST_THINKING_LEVEL) {
		ctx.ui.notify("Codex fast mode is on: setting thinking level to low.", "info");
		ctx.ui.setWorkingMessage("Codex fast mode: low reasoning");
		// Pi maps thinking level to the provider request reasoning parameter.
		pi.setThinkingLevel(FAST_THINKING_LEVEL);
	}
}

function patchPayload(payload: unknown, ctx: ExtensionContext): unknown {
	if (!state.enabled || !isCodexContext(ctx) || !isObject(payload)) return payload;

	const next: Record<string, unknown> = { ...payload };

	// OpenAI Responses API uses: reasoning: { effort: "low" }.
	const existingReasoning = isObject(next.reasoning) ? next.reasoning : {};
	next.reasoning = { ...existingReasoning, effort: FAST_THINKING_LEVEL };

	// OpenAI-compatible Chat Completions often uses this spelling.
	next.reasoning_effort = FAST_THINKING_LEVEL;

	return next;
}

async function setFastMode(pi: ExtensionAPI, enabled: boolean, ctx: ExtensionCommandContext): Promise<void> {
	const current = await loadState();

	if (enabled) {
		const previousThinkingLevel = pi.getThinkingLevel() === FAST_THINKING_LEVEL
			? current.previousThinkingLevel
			: pi.getThinkingLevel();
		await saveState({ enabled: true, previousThinkingLevel });
		ctx.ui.notify("Codex fast mode enabled. Future Codex requests will use low reasoning effort.", "info");
		ctx.ui.setWorkingMessage("Codex fast mode: low reasoning");
		if (isCodexContext(ctx)) {
			pi.setThinkingLevel(FAST_THINKING_LEVEL);
		}
	} else {
		const restoreLevel = current.previousThinkingLevel;
		await saveState({ enabled: false });
		ctx.ui.setWorkingMessage();
		if (restoreLevel && restoreLevel !== pi.getThinkingLevel()) {
			pi.setThinkingLevel(restoreLevel);
			ctx.ui.notify(`Codex fast mode disabled. Restored thinking level to ${restoreLevel}.`, "info");
		} else {
			ctx.ui.notify("Codex fast mode disabled.", "info");
		}
	}

	updateStatus(ctx);
}

function usage(ctx: ExtensionContext): void {
	ctx.ui.notify("Usage: /fast on, /fast off, /fast status, or /fast toggle", "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await applyFastMode(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await applyFastMode(pi, ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		await loadState();
		updateStatus(ctx);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		await loadState();
		return patchPayload(event.payload, ctx);
	});

	pi.registerCommand("fast", {
		description: "Toggle Codex fast mode: /fast on or /fast off",
		getArgumentCompletions: (prefix) => ["on", "off", "toggle", "status"]
			.filter((item) => item.startsWith(prefix.trim().toLowerCase()))
			.map((value) => ({ value })),
		handler: async (args, ctx) => {
			await loadState();
			const action = args.trim().toLowerCase();

			if (action === "on" || action === "enable") {
				await setFastMode(pi, true, ctx);
				return;
			}

			if (action === "off" || action === "disable") {
				await setFastMode(pi, false, ctx);
				return;
			}

			if (action === "toggle" || action === "") {
				await setFastMode(pi, !state.enabled, ctx);
				return;
			}

			if (action === "status") {
				updateStatus(ctx);
				ctx.ui.notify(
					`Codex fast mode is ${state.enabled ? "on" : "off"}. Current thinking level: ${pi.getThinkingLevel()}.`,
					"info",
				);
				return;
			}

			usage(ctx);
		},
	});
}
