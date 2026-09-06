import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { ProviderQuota, QuotaWindow, windowLabel } from "../quota";

type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

type RateLimitResponse = {
  rateLimits: RateLimitSnapshot;
  rateLimitResetCredits: {
    availableCount: number | string;
    credits: Array<{ status: string; expiresAt: number | null }> | null;
  } | null;
};

export async function fetchCodexQuota(): Promise<ProviderQuota> {
  const response = await readRateLimitsWithAuthRetry();
  const windows = snapshotWindows(response.rateLimits);

  if (windows.length === 0) throw new Error("Codex returned no quota windows");
  return {
    id: "codex",
    fetchedAt: Date.now(),
    windows,
    bankedResets: parseCount(response.rateLimitResetCredits?.availableCount),
    bankedResetExpiries: resetExpiries(response.rateLimitResetCredits?.credits),
  };
}

async function readRateLimitsWithAuthRetry(): Promise<RateLimitResponse> {
  try {
    return await readRateLimits();
  } catch (error) {
    if (!isExpiredTokenError(error)) throw error;
    return readRateLimits();
  }
}

function isExpiredTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /token_expired|authentication token is expired/i.test(message);
}

function snapshotWindows(snapshot: RateLimitSnapshot): QuotaWindow[] {
  return [snapshot.primary, snapshot.secondary].flatMap((window) => {
    if (!window) return [];
    return [
      {
        label: windowLabel(window.windowDurationMins),
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? undefined,
      },
    ];
  });
}

function readRateLimits(): Promise<RateLimitResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(codexExecutable(), ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }

    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => finish(new Error("Codex quota request timed out")), 10_000);

    function send(message: unknown) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function finish(error?: Error, value?: RateLimitResponse) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(value as RateLimitResponse);
    }

    lines.on("line", (line) => {
      let message: { id?: number; result?: RateLimitResponse; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) return finish(new Error(message.error.message ?? "Could not start Codex"));
        send({ method: "initialized" });
        send({ method: "account/rateLimits/read", id: 2 });
      }

      if (message.id === 2) {
        if (message.error) return finish(new Error(message.error.message ?? "Could not read Codex limits"));
        if (!message.result) return finish(new Error("Codex returned an empty quota response"));
        finish(undefined, message.result);
      }
    });

    child.on("error", (error) => finish(new Error(`Could not run Codex: ${error.message}`)));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(code === 0 ? "Codex closed before responding" : "Codex CLI is not signed in"));
    });
    child.stdin.on("error", () => undefined);

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "raycast-llm-quota", title: "LLM Quota", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
  });
}

function codexExecutable(): string {
  const candidates = [process.env.CODEX_CLI_PATH, "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? "codex";
}

function parseCount(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function resetExpiries(
  credits: Array<{ status: string; expiresAt: number | null }> | null | undefined,
): Array<number | null> | undefined {
  if (!credits) return undefined;
  return credits
    .filter((credit) => credit.status === "available")
    .map((credit) => credit.expiresAt)
    .sort((left, right) => (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY));
}
