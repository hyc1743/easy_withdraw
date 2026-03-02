import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function getTailScaleIpV4(): string | null {
  const result = spawnSync("tailscale", ["ip", "-4"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return null;
  const ip = result.stdout
    .split("\n")
    .map((x) => x.trim())
    .find((x) => x.length > 0);
  return ip ?? null;
}

async function pickHost(): Promise<string> {
  if (process.env.EW_HOST && process.env.EW_HOST.trim()) {
    return process.env.EW_HOST.trim();
  }

  const localhost = "127.0.0.1";
  const tailscaleIp = getTailScaleIpV4();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return localhost;
  }

  console.log("选择监听方式:");
  console.log(`1) localhost (${localhost})`);
  if (tailscaleIp) {
    console.log(`2) tailscale ip (${tailscaleIp})`);
  } else {
    console.log("2) tailscale ip (未检测到，回退 localhost)");
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("请输入选项 [1/2]，默认 1: ")).trim();
    if (answer === "2" && tailscaleIp) {
      return tailscaleIp;
    }
    return localhost;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const host = await pickHost();
  process.env.EW_HOST = host;
  console.log(`EW_HOST=${host}`);
  await import("./index.js");
}

void main();
