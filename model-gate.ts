/**
 * model-gate
 *
 * Blocks the first prompt of every Pi session until you have explicitly
 * confirmed which model is active. In directories covered by a RULE below, an
 * unapproved model cannot be confirmed at all — you are forced to switch.
 *
 * Why the `input` event and not settings: `defaultModel` only picks the model
 * you START on, and session restore can quietly reinstate a cloud model. The
 * `input` event is the only hook that can refuse to start an agent run
 * (`action: "handled"`), so it is the only place a hard gate can live.
 *
 * Install: ~/.pi/agent/extensions/model-gate.ts   (then /reload)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Directory rules. `dir` is matched against the absolute cwd as a prefix, so
 * "~/Projects/acme" also covers every subdirectory. `allow` is a
 * list of glob patterns matched against `provider/modelId` (and against the
 * bare modelId), the same shape as `enabledModels`.
 *
 * A cwd matching a rule can ONLY run a model in `allow`. Longest matching
 * `dir` wins, so a general rule can be narrowed by a more specific one.
 */
interface Rule {
	dir: string;
	allow: string[];
	/** Shown when the active model is rejected. Say who required it. */
	reason: string;
}

const RULES: Rule[] = [
	// Example — edit these. Local-only work for a sensitive project:
	// {
	// 	dir: "/home/you/Projects/acme",
	// 	allow: ["llama-cpp/*", "ollama/*"],
	// 	reason: "Acme: local models only, no data leaves the host",
	// },
];

/**
 * Directories with no rule still get a soft gate: one confirmation per
 * session. Set false to gate only RULES directories.
 */
const CONFIRM_UNGOVERNED_DIRS = true;

/**
 * Whether an explicit /model or Ctrl+P selection counts as confirmation.
 * true is the ergonomic choice: deliberately choosing a model IS the check.
 */
const EXPLICIT_SELECT_CONFIRMS = true;

const STATUS_ID = "model-gate";

const RED = "\x1b[38;5;203m";
const GREEN = "\x1b[38;5;114m";
const DIM = "\x1b[38;5;103m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Minimal glob: `*` matches within a segment, `**` matches across `/`. */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if ("\\^$.|?+()[]{}".includes(ch)) {
			out += `\\${ch}`;
		} else {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`);
}

function modelMatches(model: { provider: string; id: string }, patterns: string[]): boolean {
	const full = `${model.provider}/${model.id}`;
	return patterns.some((p) => {
		const re = globToRegExp(p);
		return re.test(full) || re.test(model.id);
	});
}

/** Longest matching `dir` prefix wins. */
function ruleFor(cwd: string): Rule | null {
	let best: Rule | null = null;
	for (const rule of RULES) {
		const dir = rule.dir.replace(/\/+$/, "");
		if (cwd === dir || cwd.startsWith(`${dir}/`)) {
			if (!best || dir.length > best.dir.replace(/\/+$/, "").length) best = rule;
		}
	}
	return best;
}

const label = (m: { provider: string; id: string } | undefined) =>
	m ? `${m.provider}/${m.id}` : "(no model)";

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** Cleared at session start; set once you have approved the active model. */
	let confirmed: string | null = null;
	/** Guards against a second dialog while one is already open. */
	let asking = false;

	function isConfirmed(ctx: ExtensionContext): boolean {
		return confirmed !== null && confirmed === label(ctx.model);
	}

	function paint(ctx: ExtensionContext) {
		const rule = ruleFor(ctx.cwd);
		const model = ctx.model;
		const ok = model && (!rule || modelMatches(model, rule.allow));

		if (!ok) {
			ctx.ui.setStatus(STATUS_ID, `${RED}⚠ ${label(model)} — not allowed here${RESET}`);
			return;
		}
		if (!isConfirmed(ctx)) {
			ctx.ui.setStatus(STATUS_ID, `${DIM}○ ${label(model)} — unconfirmed${RESET}`);
			return;
		}
		const lock = rule ? " \u{1f512}" : "";
		ctx.ui.setStatus(STATUS_ID, `${GREEN}● ${label(model)}${lock}${RESET}`);
	}

	/** Models offerable in the picker, narrowed by the directory rule. */
	function candidates(ctx: ExtensionContext) {
		const scoped = ctx.scopedModels.length > 0
			? ctx.scopedModels.map((s) => s.model)
			: ctx.modelRegistry.getAvailable();
		const rule = ruleFor(ctx.cwd);
		return rule ? scoped.filter((m) => modelMatches(m, rule.allow)) : scoped;
	}

	async function pickModel(ctx: ExtensionContext): Promise<boolean> {
		const options = candidates(ctx);
		if (options.length === 0) {
			ctx.ui.notify(
				"No model available that this directory's rule permits. Check RULES in model-gate.ts and your auth.",
				"error",
			);
			return false;
		}
		const chosen = await ctx.ui.select("Select the model to use", options.map(label));
		if (!chosen) return false;
		const model = options.find((m) => label(m) === chosen);
		if (!model) return false;
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`Cannot use ${chosen}: no API key available.`, "error");
			return false;
		}
		// model_select fires and records the confirmation; belt and braces here
		// in case EXPLICIT_SELECT_CONFIRMS is off.
		confirmed = chosen;
		return true;
	}

	/**
	 * Returns true when it is safe to let the prompt proceed. Blocks otherwise.
	 */
	async function gate(ctx: ExtensionContext): Promise<boolean> {
		const rule = ruleFor(ctx.cwd);
		const model = ctx.model;

		// Nothing to enforce and nothing to confirm.
		if (!rule && !CONFIRM_UNGOVERNED_DIRS) return true;
		if (isConfirmed(ctx) && (!rule || (model && modelMatches(model, rule.allow)))) return true;

		// Print/JSON mode cannot show a dialog. Fail CLOSED where a rule exists —
		// silently proceeding is exactly the accident this guards against.
		if (!ctx.hasUI) {
			if (rule && (!model || !modelMatches(model, rule.allow))) {
				ctx.ui.notify(
					`model-gate: ${label(model)} is not permitted in ${ctx.cwd} (${rule.reason}). ` +
						`Re-run with --model set to one of: ${rule.allow.join(", ")}`,
					"error",
				);
				return false;
			}
			return true;
		}

		if (asking) return false;
		asking = true;
		try {
			// Hard block: the active model violates the directory rule.
			if (rule && (!model || !modelMatches(model, rule.allow))) {
				const choice = await ctx.ui.select(
					`${label(model)} is NOT permitted here — ${rule.reason}`,
					["Switch model", "Cancel this prompt"],
				);
				if (choice !== "Switch model") return false;
				return (await pickModel(ctx)) && isConfirmed(ctx);
			}

			// Soft gate: right model, not yet acknowledged this session.
			const scope = rule ? `permitted in ${ctx.cwd}` : "no directory rule for this folder";
			const choice = await ctx.ui.select(
				`Use ${label(model)}? (${scope})`,
				[`Yes — ${label(model)}`, "Switch model", "Cancel this prompt"],
			);
			if (choice?.startsWith("Yes")) {
				confirmed = label(model);
				return true;
			}
			if (choice === "Switch model") return (await pickModel(ctx)) && isConfirmed(ctx);
			return false;
		} finally {
			asking = false;
			paint(ctx);
		}
	}

	// -- events ---------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Deliberately NOT persisted in session entries: a resumed session must
		// re-confirm, because restore can reinstate a model you did not pick.
		confirmed = null;
		paint(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.on("model_select", async (event, ctx) => {
		const next = label(event.model);
		const rule = ruleFor(ctx.cwd);
		const permitted = !rule || modelMatches(event.model, rule.allow);

		if (event.source === "restore" || !EXPLICIT_SELECT_CONFIRMS || !permitted) {
			// A restored or disallowed model is never trusted.
			confirmed = null;
		} else {
			confirmed = next;
		}

		if (!permitted && rule) {
			ctx.ui.notify(
				`${next} is not permitted in this directory — ${rule.reason}`,
				"warning",
			);
		}
		paint(ctx);
	});

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages (sub-agents, /goal continuations) are not
		// user intent and must not trigger a dialog.
		if (event.source === "extension") return;
		// Steering mid-stream: the run was already gated when it started.
		if (event.streamingBehavior === "steer") return;

		if (await gate(ctx)) return;

		// Hold the prompt rather than dropping it, then replay verbatim.
		const content =
			event.images && event.images.length > 0
				? [{ type: "text" as const, text: event.text }, ...event.images]
				: event.text;

		if (isConfirmed(ctx)) {
			pi.sendUserMessage(content);
		} else {
			ctx.ui.setEditorText?.(event.text);
			ctx.ui.notify("Prompt held. Confirm a model, then send again.", "warning");
		}
		return { action: "handled" as const };
	});

	// -- /model-gate ----------------------------------------------------------

	pi.registerCommand("model-gate", {
		description: "Re-arm the model confirmation gate, or show its state",
		getArgumentCompletions: (prefix: string) => {
			const items = ["status", "rearm", "switch"]
				.filter((s) => s.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim() || "status";
			const rule = ruleFor(ctx.cwd);

			if (arg === "rearm") {
				confirmed = null;
				paint(ctx);
				ctx.ui.notify("Gate re-armed — the next prompt will ask again.", "info");
				return;
			}
			if (arg === "switch") {
				await pickModel(ctx);
				paint(ctx);
				return;
			}
			ctx.ui.notify(
				`Model: ${label(ctx.model)}\n` +
					`Confirmed: ${isConfirmed(ctx) ? "yes" : "no"}\n` +
					`Directory: ${ctx.cwd}\n` +
					(rule
						? `Rule: ${rule.dir}\nAllowed: ${rule.allow.join(", ")}\nReason: ${rule.reason}`
						: "Rule: none (soft confirmation only)"),
				"info",
			);
		},
	});
}
