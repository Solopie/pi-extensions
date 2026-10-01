/**
 * usage-limits
 *
 * Shows Anthropic (Claude subscription) usage limits in the Pi status line:
 *
 *     5h 71% ·2h13m · 7d 24% ·1d18h
 *
 * i.e. per-window utilization percentage and the time until that window
 * resets. Data comes from the same endpoint Claude Code's /usage uses,
 * authenticated with the OAuth access token Pi already stores in auth.json.
 *
 * Install: ~/.pi/agent/extensions/usage-limits.ts   (then /reload)
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_ID = "limits";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const AUTH_PATH = join(getAgentDir(), "auth.json");

/** Background refresh cadence. The 5h window moves slowly, so this is plenty. */
const POLL_MS = 120_000;
/** Don't hammer the endpoint when turns finish back to back. */
const MIN_REFRESH_MS = 20_000;
const FETCH_TIMEOUT_MS = 8000;

interface Window {
  utilization: number | null;
  resets_at: string | null;
}

interface UsageResponse {
  five_hour?: Window | null;
  seven_day?: Window | null;
  seven_day_opus?: Window | null;
  extra_usage?: { is_enabled?: boolean; utilization?: number | null } | null;
}

interface Snapshot {
  fetchedAt: number;
  data: UsageResponse;
}

export default function (pi: ExtensionAPI) {
  let snapshot: Snapshot | undefined;
  let lastFetchAttempt = 0;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let ctxRef: ExtensionContext | undefined;

  const render = () => {
    const ctx = ctxRef;
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(STATUS_ID, snapshot ? formatStatus(snapshot.data) : undefined);
  };

  const refresh = (force = false): Promise<void> => {
    if (inFlight) return inFlight;
    const now = Date.now();
    if (!force && now - lastFetchAttempt < MIN_REFRESH_MS) return Promise.resolve();
    lastFetchAttempt = now;

    inFlight = fetchUsage()
      .then((data) => {
        if (data) snapshot = { fetchedAt: Date.now(), data };
        render();
      })
      .catch(() => {
        // Usage display is cosmetic: never surface network/auth noise.
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    if (!ctx.hasUI) return;
    void refresh(true);
    if (!timer) {
      timer = setInterval(() => void refresh(true), POLL_MS);
      timer.unref?.();
    }
    // Keep the "resets in" countdown honest between polls.
    if (!ticker) {
      ticker = setInterval(render, 30_000);
      ticker.unref?.();
    }
  });

  // A finished turn is exactly when the numbers have just changed.
  pi.on("agent_settled", (_event, ctx) => {
    ctxRef = ctx;
    void refresh();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    if (ticker) clearInterval(ticker);
    timer = undefined;
    ticker = undefined;
  });

  pi.registerCommand("limits", {
    description: "Show Anthropic usage limits (percentage used and reset time)",
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      await refresh(true);
      const report = snapshot
        ? formatReport(snapshot.data)
        : "Usage limits unavailable (not logged in with an Anthropic OAuth account, or the API is unreachable).";
      if (ctx.hasUI) ctx.ui.notify(report, "info");
      else console.log(report);
    },
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Pi keeps the OAuth credentials in auth.json and refreshes them on use. */
function readAccessToken(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const creds = auth?.anthropic;
    if (!creds || creds.type !== "oauth" || typeof creds.access !== "string") return undefined;
    // Expired tokens would just 401. Pi rewrites the file after its next
    // provider request, so skip and let the following poll pick it up.
    if (typeof creds.expires === "number" && creds.expires <= Date.now()) return undefined;
    return creds.access;
  } catch {
    return undefined;
  }
}

async function fetchUsage(): Promise<UsageResponse | undefined> {
  const token = readAccessToken();
  if (!token) return undefined;

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;
  return (await res.json()) as UsageResponse;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatStatus(data: UsageResponse): string | undefined {
  const parts: string[] = [];
  const push = (label: string, w: Window | null | undefined) => {
    if (!w || typeof w.utilization !== "number") return;
    const reset = formatDelta(w.resets_at);
    parts.push(`${label} ${Math.round(w.utilization)}%${reset ? ` ·${reset}` : ""}`);
  };

  push("5h", data.five_hour);
  push("7d", data.seven_day);
  if (data.extra_usage?.is_enabled && typeof data.extra_usage.utilization === "number") {
    parts.push(`extra ${Math.round(data.extra_usage.utilization)}%`);
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatReport(data: UsageResponse): string {
  const lines = ["Anthropic usage limits:"];
  const row = (label: string, w: Window | null | undefined) => {
    if (!w || typeof w.utilization !== "number") return;
    const delta = formatDelta(w.resets_at);
    const at = w.resets_at ? new Date(w.resets_at).toLocaleString() : "unknown";
    lines.push(`  ${label.padEnd(12)} ${String(Math.round(w.utilization)).padStart(3)}% used · resets ${delta ? `in ${delta}` : ""} (${at})`);
  };

  row("Session (5h)", data.five_hour);
  row("Weekly (7d)", data.seven_day);
  row("Weekly Opus", data.seven_day_opus);

  if (lines.length === 1) lines.push("  (no active limit windows reported)");
  if (data.extra_usage?.is_enabled && typeof data.extra_usage.utilization === "number") {
    lines.push(`  Extra usage  ${String(Math.round(data.extra_usage.utilization)).padStart(3)}% of monthly credit limit`);
  }
  return lines.join("\n");
}

/** "2h13m", "18m", "3d4h" — compact time until the reset timestamp. */
function formatDelta(resetsAt: string | null | undefined): string | undefined {
  if (!resetsAt) return undefined;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return "now";

  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
