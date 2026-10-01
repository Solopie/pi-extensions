import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(getAgentDir(), "tps.jsonl");

// Responses shorter than this are dominated by startup jitter, so they are
// logged but excluded from the aggregate stats.
const MIN_TOKENS_FOR_STATS = 20;

interface Sample {
  ts: number;
  session: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  reasoning: number;
  ttftMs: number;
  genMs: number;
  totalMs: number;
  tps: number;
}

interface Pending {
  start: number;
  firstToken?: number;
  deltas: number;
  lastStatus: number;
}

export default function (pi: ExtensionAPI) {
  let pending: Pending | undefined;
  let requestSentAt: number | undefined;
  const sessionSamples: Sample[] = [];

  // message_start only fires once the provider's first stream chunk lands, so
  // anchor time-to-first-token to the moment the request actually went out.
  pi.on("before_provider_request", () => {
    requestSentAt = Date.now();
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const start = requestSentAt ?? Date.now();
    requestSentAt = undefined; // consume: a stale value would inflate the next ttft
    pending = { start, deltas: 0, lastStatus: 0 };
    if (ctx.hasUI) ctx.ui.setStatus("tps", undefined);
  });

  pi.on("message_update", (event, ctx) => {
    if (!pending) return;
    const delta = (event.assistantMessageEvent as any)?.delta;
    if (typeof delta !== "string" || delta.length === 0) return;

    const now = Date.now();
    if (pending.firstToken === undefined) pending.firstToken = now;
    pending.deltas++;

    // Live readout. Stream chunks approximate tokens closely enough for a
    // moving number; message_end replaces it with the provider's real count.
    if (!ctx.hasUI || now - pending.lastStatus < 250) return;
    pending.lastStatus = now;
    const secs = (now - pending.firstToken) / 1000;
    if (secs <= 0) return;
    ctx.ui.setStatus("tps", `~${(pending.deltas / secs).toFixed(1)} tok/s`);
  });

  pi.on("message_end", (event, ctx) => {
    const started = pending;
    pending = undefined;
    if (!started || event.message.role !== "assistant") return;

    const msg = event.message as any;
    const usage = msg.usage ?? {};
    const output: number = usage.output ?? 0; // already includes reasoning tokens
    const end = Date.now();
    const firstToken = started.firstToken ?? started.start;
    const genMs = Math.max(0, end - firstToken);
    if (output <= 0 || genMs <= 0) return;

    const sample: Sample = {
      ts: end,
      session: ctx.sessionManager.getSessionFile?.() ?? "ephemeral",
      provider: msg.provider ?? "unknown",
      model: msg.model ?? "unknown",
      input: usage.input ?? 0,
      output,
      reasoning: usage.reasoning ?? 0,
      ttftMs: firstToken - started.start,
      genMs,
      totalMs: end - started.start,
      tps: output / (genMs / 1000),
    };
    sessionSamples.push(sample);

    try {
      appendFileSync(LOG_PATH, `${JSON.stringify(sample)}\n`);
    } catch {
      // Never break a turn over a stats write.
    }

    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "tps",
      `${sample.tps.toFixed(1)} tok/s · ${(sample.ttftMs / 1000).toFixed(2)}s ttft · ${output} tok`,
    );
  });

  pi.registerCommand("tps", {
    description: "Token throughput stats by model (args: session | all | clear)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["session", "all", "clear"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();

      if (mode === "clear") {
        try {
          if (existsSync(LOG_PATH)) rmSync(LOG_PATH);
        } catch (e) {
          ctx.ui.notify(`Could not clear ${LOG_PATH}: ${e}`, "error");
          return;
        }
        sessionSamples.length = 0;
        ctx.ui.notify("tps log cleared", "info");
        return;
      }

      const samples = mode === "session" ? sessionSamples : readLog();
      const scope = mode === "session" ? "this session" : "all sessions";
      const report = formatReport(samples, scope);
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      else console.log(report);
    },
  });
}

function readLog(): Sample[] {
  try {
    if (!existsSync(LOG_PATH)) return [];
    return readFileSync(LOG_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Sample;
        } catch {
          return undefined;
        }
      })
      .filter((s): s is Sample => s !== undefined);
  } catch {
    return [];
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatReport(samples: Sample[], scope: string): string {
  if (samples.length === 0) {
    return `tok/s (${scope}): no samples yet — send a message first.`;
  }

  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.provider}/${s.model}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }

  const rows = [...groups.entries()]
    .map(([key, all]) => {
      const scored = all.filter((s) => s.output >= MIN_TOKENS_FOR_STATS);
      const rates = scored.map((s) => s.tps);
      const tokens = all.reduce((a, s) => a + s.output, 0);
      const genMs = scored.reduce((a, s) => a + s.genMs, 0);
      // Prompt-processing rate. Cache hits make ttft collapse, so samples with
      // an implausibly fast prefill would skew this — drop them.
      const prefills = all
        .filter((s) => s.ttftMs > 50 && s.input > 0)
        .map((s) => s.input / (s.ttftMs / 1000));
      return {
        key,
        responses: all.length,
        scored: scored.length,
        med: median(rates),
        prefill: median(prefills),
        // Total tokens over total generation time: what you actually feel
        // across a session, unlike a mean of per-response rates.
        sustained: genMs > 0 ? (scored.reduce((a, s) => a + s.output, 0) / genMs) * 1000 : 0,
        best: rates.length > 0 ? Math.max(...rates) : 0,
        ttft: median(scored.map((s) => s.ttftMs)) / 1000,
        tokens,
      };
    })
    .sort((a, b) => b.med - a.med);

  const nameWidth = Math.max(14, ...rows.map((r) => r.key.length));
  const header =
    "  " +
    "provider/model".padEnd(nameWidth) +
    "   n".padStart(5) +
    "   med".padStart(8) +
    "  sustained".padStart(11) +
    "    best".padStart(9) +
    "    ttft".padStart(9) +
    "  prefill".padStart(10) +
    "  tokens".padStart(9);

  const lines = rows.map(
    (r) =>
      "  " +
      r.key.padEnd(nameWidth) +
      String(r.scored).padStart(5) +
      r.med.toFixed(1).padStart(8) +
      r.sustained.toFixed(1).padStart(11) +
      r.best.toFixed(1).padStart(9) +
      `${r.ttft.toFixed(2)}s`.padStart(9) +
      r.prefill.toFixed(0).padStart(10) +
      formatTokens(r.tokens).padStart(9),
  );

  return [
    `tok/s by model — ${scope}, ${samples.length} responses`,
    "",
    header,
    ...lines,
    "",
    `med/sustained/best = decode tok/s over ${MIN_TOKENS_FOR_STATS}+ token responses, ttft excluded.`,
    "prefill = prompt tok/s during ttft (cached prompts inflate it).",
    `log: ${LOG_PATH}`,
  ].join("\n");
}
