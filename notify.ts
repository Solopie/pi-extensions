import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;              // skip print/json/rpc
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;  // another run started

    await pi.exec("notify-send", [
      "-a", "pi",
      "-u", "normal",
      "Pi",
      "Awaiting your input",
    ], { timeout: 5000 });

    await pi.exec("espeak-ng", [
      "Your cache is gonna invalidate in 5 minutes.",
    ], { timeout: 10000 });
  });
}
