import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ProviderQuota, windowLabel } from "../quota";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const RESETS_URL = "https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets";
const execFileAsync = promisify(execFile);

type GrokAuth = {
  key?: string;
  expires_at?: string;
  auth_mode?: string;
};

type Amount = number | string | { val?: number | string };

type BillingConfig = {
  creditUsagePercent?: number;
  currentPeriod?: { start?: string; end?: string };
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  monthlyLimit?: Amount;
  used?: Amount;
  onDemandCap?: Amount;
  onDemandUsed?: Amount;
  billingCycle?: { billingPeriodStart?: string; billingPeriodEnd?: string };
  usage?: { totalUsed?: Amount };
};

export async function fetchGrokQuota(): Promise<ProviderQuota> {
  let token = await readAccessToken();
  let result = await fetchGrokData(token);

  if (result.response.status === 401 || result.response.status === 403) {
    token = await refreshAccessToken();
    result = await fetchGrokData(token);
  }

  const { response, resetTokens } = result;

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw loginExpiredError();
    throw new Error(`Grok billing request failed (${response.status})`);
  }

  const body = (await response.json()) as { config?: BillingConfig } & BillingConfig;
  const config = body.config ?? body;
  const resetsAt = parseTimestamp(
    config.currentPeriod?.end ?? config.billingPeriodEnd ?? config.billingCycle?.billingPeriodEnd,
  );
  const startsAt = parseTimestamp(
    config.currentPeriod?.start ?? config.billingPeriodStart ?? config.billingCycle?.billingPeriodStart,
  );
  const usedPercent = billingUsedPercent(config);

  if (usedPercent === undefined) throw new Error("Grok returned no quota usage");
  const durationMinutes = startsAt && resetsAt ? Math.round((resetsAt - startsAt) / 60) : undefined;

  return {
    id: "grok",
    fetchedAt: Date.now(),
    windows: [{ label: windowLabel(durationMinutes), usedPercent, resetsAt }],
    bankedResets: resetTokens?.length,
    bankedResetExpiries: resetTokens?.map((reset) => reset.expiresAt),
  };
}

async function fetchGrokData(token: string) {
  const [response, resetTokens] = await Promise.all([
    fetch(BILLING_URL, {
      headers: authHeaders(token, { Accept: "application/json" }),
      signal: AbortSignal.timeout(8_000),
    }),
    fetchBankedResets(token).catch(() => undefined),
  ]);
  return { response, resetTokens };
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    ...extra,
  };
}

type ResetToken = { id: string; expiresAt: number | null };

async function fetchBankedResets(token: string): Promise<ResetToken[]> {
  const response = await fetch(RESETS_URL, {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/grpc-web+proto",
      "connect-protocol-version": "1",
      "x-grpc-web": "1",
      Origin: "https://grok.com",
      Referer: "https://grok.com/",
    }),
    body: new Uint8Array(5),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) throw new Error(`Grok reset request failed (${response.status})`);
  return parseResetTokens(new Uint8Array(await response.arrayBuffer()));
}

function parseResetTokens(response: Uint8Array): ResetToken[] {
  const tokens: ResetToken[] = [];

  for (const payload of grpcWebPayloads(response)) walkResetTokens(payload, tokens);

  const now = Date.now() / 1000;
  return [...new Map(tokens.map((token) => [token.id, token])).values()]
    .filter((token) => token.expiresAt === null || token.expiresAt > now)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

function grpcWebPayloads(response: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let offset = 0;

  while (offset + 5 <= response.length) {
    const flag = response[offset];
    const length = new DataView(response.buffer, response.byteOffset + offset + 1, 4).getUint32(0);
    const start = offset + 5;
    const end = start + length;
    if (end > response.length) break;
    if ((flag & 0x80) === 0) payloads.push(response.subarray(start, end));
    offset = end;
  }

  return payloads.length ? payloads : [response];
}

function walkResetTokens(message: Uint8Array, tokens: ResetToken[]): void {
  for (const field of protobufFields(message)) {
    if (field.wire !== 2 || (field.number !== 1 && field.number !== 10)) continue;
    const token = parseResetToken(field.bytes);
    if (token) tokens.push(token);
    else walkResetTokens(field.bytes, tokens);
  }
}

function parseResetToken(message: Uint8Array): ResetToken | undefined {
  let id: string | undefined;
  let fallbackExpiry: number | null = null;
  let preferredExpiry: number | null = null;

  for (const field of protobufFields(message)) {
    if (field.wire !== 2) continue;
    if (field.number === 1 || field.number === 10) {
      const value = new TextDecoder().decode(field.bytes);
      if (value.length >= 4 && value.length < 200) id = value;
    } else if ([2, 3, 20, 30].includes(field.number)) {
      const timestamp = parseProtobufTimestamp(field.bytes);
      if (field.number === 3 || field.number === 30) preferredExpiry = timestamp;
      else fallbackExpiry ??= timestamp;
    }
  }

  return id ? { id, expiresAt: preferredExpiry ?? fallbackExpiry } : undefined;
}

type ProtobufField = { number: number; wire: 0; value: number } | { number: number; wire: 2; bytes: Uint8Array };

function protobufFields(message: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;

  while (offset < message.length) {
    const tag = readVarint(message, offset);
    if (!tag) break;
    offset = tag.next;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (wire === 0) {
      const value = readVarint(message, offset);
      if (!value) break;
      fields.push({ number, wire: 0, value: value.value });
      offset = value.next;
    } else if (wire === 2) {
      const length = readVarint(message, offset);
      if (!length) break;
      offset = length.next;
      const end = offset + length.value;
      if (end > message.length) break;
      fields.push({ number, wire: 2, bytes: message.subarray(offset, end) });
      offset = end;
    } else {
      break;
    }
  }

  return fields;
}

function parseProtobufTimestamp(message: Uint8Array): number | null {
  const seconds = protobufFields(message).find((field) => field.number === 1 && field.wire === 0);
  return seconds?.wire === 0 ? seconds.value : null;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let multiplier = 1;

  while (offset < bytes.length && multiplier <= 2 ** 49) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: offset };
    multiplier *= 128;
  }

  return undefined;
}

async function readAccessToken(): Promise<string> {
  const entry = await readStoredCredential();
  if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) return refreshAccessToken();
  return entry.key;
}

async function refreshAccessToken(): Promise<string> {
  const grokHome = process.env.GROK_HOME ?? join(homedir(), ".grok");
  const binary = process.env.GROK_BINARY ?? join(grokHome, "bin", "grok");

  try {
    await execFileAsync(binary, ["models"], { timeout: 15_000 });
  } catch {
    throw loginExpiredError();
  }

  const entry = await readStoredCredential();
  if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) throw loginExpiredError();
  return entry.key;
}

async function readStoredCredential(): Promise<Required<Pick<GrokAuth, "key">> & GrokAuth> {
  const grokHome = process.env.GROK_HOME ?? join(homedir(), ".grok");
  let authFile: Record<string, GrokAuth>;

  try {
    authFile = JSON.parse(await readFile(join(grokHome, "auth.json"), "utf8")) as Record<string, GrokAuth>;
  } catch {
    throw new Error("Grok CLI is not signed in — run grok login");
  }

  const entries = Object.entries(authFile)
    .filter(([, entry]) => typeof entry.key === "string")
    .sort(
      ([issuerA], [issuerB]) =>
        Number(issuerB.startsWith("https://auth.x.ai")) - Number(issuerA.startsWith("https://auth.x.ai")),
    );
  const entry = entries[0]?.[1];

  if (!entry?.key) throw new Error("Grok CLI is not signed in — run grok login");
  return entry as Required<Pick<GrokAuth, "key">> & GrokAuth;
}

function loginExpiredError(): Error {
  return new Error("Grok login expired — run grok login");
}

function billingUsedPercent(config: BillingConfig): number | undefined {
  if (typeof config.creditUsagePercent === "number") return config.creditUsagePercent;

  const used = amount(config.usage?.totalUsed ?? config.used ?? config.onDemandUsed);
  const limit = amount(config.monthlyLimit ?? config.onDemandCap);
  if (used !== undefined && limit !== undefined && limit > 0) return (used / limit) * 100;

  // Grok omits zero-valued proto fields. A valid period with no usage field means 0% used.
  if (config.currentPeriod?.end || config.billingPeriodEnd || config.billingCycle?.billingPeriodEnd) return 0;
  return undefined;
}

function amount(value?: Amount): number | undefined {
  const raw = typeof value === "object" ? value.val : value;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp / 1000 : undefined;
}
