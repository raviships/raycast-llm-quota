import { Cache, Color, Icon, MenuBarExtra, open } from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { fetchCodexQuota } from "./providers/codex";
import { fetchGrokQuota } from "./providers/grok";
import { clampPercent, ProviderId, ProviderQuota, remainingPercent } from "./quota";

const cache = new Cache({ namespace: "raycast-llm-quota" });
const CACHE_KEY = "provider-quotas-v1";

type Quotas = Partial<Record<ProviderId, ProviderQuota>>;
type Errors = Partial<Record<ProviderId, string>>;

const providers = [
  { id: "codex" as const, name: "Codex", fetch: fetchCodexQuota },
  { id: "grok" as const, name: "Grok", fetch: fetchGrokQuota },
];

export default function Command() {
  const [quotas, setQuotas] = useState<Quotas>(readCache);
  const [errors, setErrors] = useState<Errors>({});
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    const results = await Promise.allSettled(providers.map((provider) => provider.fetch()));
    const nextErrors: Errors = {};
    const freshQuotas: Quotas = {};

    results.forEach((result, index) => {
      const provider = providers[index];
      if (result.status === "fulfilled") {
        freshQuotas[provider.id] = result.value;
      } else {
        nextErrors[provider.id] = errorMessage(result.reason);
      }
    });

    setQuotas((current) => {
      const next = { ...current, ...freshQuotas };
      cache.set(CACHE_KEY, JSON.stringify(next));
      return next;
    });

    setErrors(nextErrors);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const codexRemaining = mainCodexRemaining(quotas);

  return (
    <MenuBarExtra
      icon={{ source: Icon.Gauge, tintColor: statusColor(codexRemaining) }}
      title={codexRemaining === undefined ? undefined : `${Math.round(codexRemaining)}%`}
      tooltip="Codex quota"
      isLoading={isLoading}
    >
      {providers.map((provider) => {
        const quota = quotas[provider.id];
        const error = errors[provider.id];

        return (
          <MenuBarExtra.Section key={provider.id} title={provider.name}>
            {quota?.windows.map((window) => {
              const remaining = remainingPercent(window.usedPercent);
              return (
                <MenuBarExtra.Item
                  key={`${provider.id}-${window.label}`}
                  icon={{ source: progressIcon(remaining), tintColor: statusColor(remaining) }}
                  title={window.label}
                  subtitle={`${formatPercent(remaining)} left${formatReset(window.resetsAt)}`}
                />
              );
            })}
            {quota && bankedResetItems(quota)}
            {!quota && <MenuBarExtra.Item icon={Icon.Warning} title="Unavailable" subtitle={error ?? "Loading…"} />}
            {quota && error && <MenuBarExtra.Item icon={Icon.Warning} title="Using last update" subtitle={error} />}
          </MenuBarExtra.Section>
        );
      })}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          title="Refresh"
          subtitle={latestUpdate(quotas)}
          onAction={refresh}
        />
        <MenuBarExtra.Item
          icon={Icon.Globe}
          title="Open Codex Usage"
          onAction={() => open("https://chatgpt.com/codex/settings/usage")}
        />
        <MenuBarExtra.Item
          icon={Icon.Globe}
          title="Open Grok Usage"
          onAction={() => open("https://grok.com/?_s=usage")}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

function readCache(): Quotas {
  try {
    return JSON.parse(cache.get(CACHE_KEY) ?? "{}") as Quotas;
  } catch {
    return {};
  }
}

function mainCodexRemaining(quotas: Quotas): number | undefined {
  const mainWindow = quotas.codex?.windows[0];
  return mainWindow ? remainingPercent(mainWindow.usedPercent) : undefined;
}

function statusColor(remaining: number | undefined): Color {
  if (remaining === undefined) return Color.SecondaryText;
  if (remaining < 20) return Color.Red;
  if (remaining < 50) return Color.Orange;
  return Color.Green;
}

function progressIcon(remaining: number): Icon {
  if (remaining >= 88) return Icon.CircleProgress100;
  if (remaining >= 63) return Icon.CircleProgress75;
  if (remaining >= 38) return Icon.CircleProgress50;
  if (remaining >= 13) return Icon.CircleProgress25;
  return Icon.CircleProgress;
}

function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

function formatReset(timestamp?: number): string {
  if (!timestamp) return "";
  return ` · resets ${timeUntil(timestamp)}`;
}

function timeUntil(timestamp: number): string {
  return `in ${timeRemaining(timestamp)}`;
}

function timeRemaining(timestamp: number): string {
  const seconds = Math.max(0, timestamp - Date.now() / 1000);
  if (seconds < 60) return "now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function bankedResetIcon(expiresAt?: number) {
  if (!expiresAt) return Icon.Coins;
  const remaining = expiresAt - Date.now() / 1000;
  if (remaining >= 7 * 86_400) return Icon.Coins;
  return { source: Icon.Warning, tintColor: remaining < 86_400 ? Color.Red : Color.Orange };
}

function expiryTooltip(expiresAt?: number): string | undefined {
  if (!expiresAt) return undefined;
  return `Expires ${new Date(expiresAt * 1000).toLocaleString()}`;
}

function bankedResetItems(quota: ProviderQuota) {
  const count = quota.bankedResets;
  if (count === undefined) return null;
  if (count === 0) return <MenuBarExtra.Item icon={Icon.Coins} title="No banked resets" />;

  const expiries = quota.bankedResetExpiries ?? [];
  const missing = Math.max(0, count - expiries.length);

  return (
    <>
      {expiries.map((expiresAt, index) => (
        <MenuBarExtra.Item
          key={`${quota.id}-banked-reset-${index}`}
          icon={bankedResetIcon(expiresAt ?? undefined)}
          title={count === 1 ? "Banked reset" : `Reset ${index + 1}`}
          subtitle={expiresAt ? `${timeRemaining(expiresAt)} left` : "No expiry"}
          tooltip={expiryTooltip(expiresAt ?? undefined)}
        />
      ))}
      {missing > 0 && (
        <MenuBarExtra.Item
          icon={Icon.Coins}
          title={missing === 1 ? "1 more reset" : `${missing} more resets`}
          subtitle="Expiry unavailable"
        />
      )}
    </>
  );
}

function latestUpdate(quotas: Quotas): string | undefined {
  const latest = Math.max(...Object.values(quotas).map((quota) => quota.fetchedAt), 0);
  if (!latest) return undefined;

  const minutes = Math.max(0, Math.floor((Date.now() - latest) / 60_000));
  if (minutes === 0) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
