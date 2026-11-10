import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type { ProviderRequestOutcome, ProviderType, ProviderUsageDashboard, ProviderUsageMetrics, ProviderUsageRange } from "@claude-desktop/shared";

export type ProviderUsageRecord = {
  at: number;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  outcome: ProviderRequestOutcome;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageReported: boolean;
};
const HOUR = 60 * 60 * 1000;
const WINDOWS = { "24h": { count: 24, bucketMs: HOUR }, "7d": { count: 7, bucketMs: 24 * HOUR }, "30d": { count: 30, bucketMs: 24 * HOUR } } as const;
export function emptyProviderUsageMetrics(): ProviderUsageMetrics {
  return { requests: 0, successes: 0, failures: 0, cancellations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, unreportedUsageRequests: 0, successRate: null };
}
function merge(target: ProviderUsageMetrics, source: ProviderUsageMetrics): void {
  for (const key of ["requests", "successes", "failures", "cancellations", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "totalTokens", "unreportedUsageRequests"] as const) target[key] += source[key];
  const attempts = target.successes + target.failures;
  target.successRate = attempts ? target.successes / attempts : null;
}
type Aggregate = { provider_id: string; provider_name: string; provider_type: ProviderType; bucket_index: number; requests: number; successes: number; failures: number; cancellations: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number; unreported: number };

/** Local inference observations only. No prompts, response content, keys or OAuth tokens are stored. */
export class ProviderUsageStore {
  static open(userDataDir: string, now: () => number = Date.now): ProviderUsageStore | null {
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      const requireFromApp = createRequire(path.join(userDataDir, "provider-usage-loader.cjs"));
      const sqlite = requireFromApp("node:sqlite") as { DatabaseSync: new (location: string) => DatabaseSync };
      return new ProviderUsageStore(new sqlite.DatabaseSync(path.join(userDataDir, "provider-usage.sqlite3")), now);
    } catch { return null; }
  }
  private closed = false;
  private prunedAt = 0;
  private readonly recordingSince: number;
  private constructor(private readonly db: DatabaseSync, private readonly now: () => number) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_requests (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'cancelled')),
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        usage_reported INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_requests_time ON provider_requests(at);
    `);
    const at = Math.floor(now());
    db.prepare("INSERT OR IGNORE INTO usage_meta(key, value) VALUES ('recording_since', ?)").run(at);
    this.recordingSince = Number((db.prepare("SELECT value FROM usage_meta WHERE key = 'recording_since'").get() as { value: number }).value);
    this.prune(at);
  }
  private assertOpen(): void { if (this.closed) throw new Error("Provider 统计数据库已关闭"); }
  private prune(at: number): void {
    if (at - this.prunedAt < 24 * HOUR) return;
    this.db.prepare("DELETE FROM provider_requests WHERE at < ?").run(at - 35 * 24 * HOUR);
    this.prunedAt = at;
  }
  record(record: ProviderUsageRecord): void {
    this.assertOpen();
    const numbers = [record.at, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens];
    if (numbers.some(n => !Number.isSafeInteger(n) || n < 0) || !record.providerId || typeof record.providerName !== "string" || !["success", "failure", "cancelled"].includes(record.outcome)) throw new Error("Provider 用量记录无效");
    this.db.prepare(`INSERT INTO provider_requests(at, provider_id, provider_name, provider_type, outcome, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, usage_reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.at, record.providerId, record.providerName, record.providerType, record.outcome, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens, record.usageReported ? 1 : 0);
    this.prune(Math.floor(this.now()));
  }
  dashboard(range: ProviderUsageRange, providerId?: string): ProviderUsageDashboard {
    this.assertOpen();
    if (!Object.hasOwn(WINDOWS, range)) throw new Error("统计时间范围无效");
    const { count, bucketMs } = WINDOWS[range];
    const endAt = Math.floor(this.now());
    const startAt = endAt - count * bucketMs;
    const rows = this.db.prepare(`SELECT provider_id, MAX(provider_name) AS provider_name, MAX(provider_type) AS provider_type,
      MIN(?, CAST((at - ?) / ? AS INTEGER)) AS bucket_index,
      COUNT(*) AS requests, SUM(outcome = 'success') AS successes, SUM(outcome = 'failure') AS failures, SUM(outcome = 'cancelled') AS cancellations,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(usage_reported = 0) AS unreported
      FROM provider_requests WHERE at >= ? AND at <= ? GROUP BY provider_id, bucket_index`)
      .all(count - 1, startAt, bucketMs, startAt, endAt) as Aggregate[];
    const metrics = emptyProviderUsageMetrics();
    const buckets = Array.from({ length: count }, (_, index) => ({ startAt: startAt + index * bucketMs, ...emptyProviderUsageMetrics() }));
    const providers = new Map<string, ProviderUsageDashboard["providers"][number]>();
    for (const row of rows) {
      const usage: ProviderUsageMetrics = {
        requests: row.requests, successes: row.successes, failures: row.failures, cancellations: row.cancellations,
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheCreationTokens: row.cache_creation_tokens,
        totalTokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens,
        unreportedUsageRequests: row.unreported, successRate: null,
      };
      let provider = providers.get(row.provider_id);
      if (!provider) { provider = { providerId: row.provider_id, providerName: row.provider_name, providerType: row.provider_type, metrics: emptyProviderUsageMetrics() }; providers.set(row.provider_id, provider); }
      merge(provider.metrics, usage);
      if (providerId && row.provider_id !== providerId) continue;
      merge(metrics, usage);
      if (buckets[row.bucket_index]) merge(buckets[row.bucket_index], usage);
    }
    return { range, startAt, endAt, bucketMs, recordingSince: this.recordingSince, metrics, buckets, providers: [...providers.values()].sort((a, b) => a.providerName.localeCompare(b.providerName)) };
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
