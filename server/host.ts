import { spawnSync } from "node:child_process";
import { isIPv4 } from "node:net";

export function getTailscaleIPv4(): string | null {
  const result = spawnSync("tailscale", ["ip", "-4"], {
    encoding: "utf-8",
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(line => line.trim()).find(isIPv4) ?? null;
}

export function resolveListenHost(
  configuredHost = process.env.EW_HOST,
  detectTailscale: () => string | null = getTailscaleIPv4,
): string {
  return configuredHost?.trim() || detectTailscale() || "127.0.0.1";
}
