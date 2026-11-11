import React, { useEffect, useRef, useState } from "react";
import { IPC, type ProviderUsageDashboard, type ProviderUsageRange } from "@claude-desktop/shared";
import styles from "./ProviderDashboard.module.css";

const RANGES: Array<{ value: ProviderUsageRange; label: string }> = [
  { value: "24h", label: "24 小时" }, { value: "7d", label: "7 天" }, { value: "30d", label: "一个月" },
];
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude", openai: "OpenAI", deepseek: "DeepSeek", kimi: "Kimi", xai: "xAI", gemini: "Gemini",
  "openai-compatible": "兼容接口",
};
const number = (value: number) => value.toLocaleString("zh-CN");
const percent = (value: number | null) => value === null ? "—" : `${Number((value * 100).toFixed(1))}%`;
const dateTime = (value: number) => new Date(value).toLocaleString("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function compact(value: number) {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}K`;
  return String(value);
}
function tickTime(at: number, range: ProviderUsageRange) {
  return new Date(at).toLocaleString("zh-CN", range === "24h"
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" });
}

function UsageChart({ data, kind, width }: { data: ProviderUsageDashboard; kind: "tokens" | "success"; width: number }) {
  const isRate = kind === "success";
  const title = isRate ? "请求成功率趋势" : "Token 消耗趋势";
  const height = 224, left = 56, right = 16, top = 20, bottom = 38;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const duration = Math.max(1, data.endAt - data.startAt);
  const tokenMax = Math.max(2, ...data.buckets.map(bucket => bucket.totalTokens));
  const magnitude = 10 ** Math.floor(Math.log10(tokenMax));
  const max = isRate ? 1 : Math.ceil(tokenMax / magnitude) * magnitude;
  const x = (at: number) => left + Math.max(0, Math.min(1, (at - data.startAt) / duration)) * plotWidth;
  const y = (value: number) => top + plotHeight * (1 - value / max);
  const isRecorded = (bucket: ProviderUsageDashboard["buckets"][number]) => bucket.startAt + data.bucketMs > data.recordingSince;
  const valueFor = (bucket: ProviderUsageDashboard["buckets"][number]) => !isRecorded(bucket) ? null : isRate ? bucket.successRate : bucket.totalTokens;
  const centerAt = (bucket: ProviderUsageDashboard["buckets"][number]) => (bucket.startAt + Math.min(bucket.startAt + data.bucketMs, data.endAt)) / 2;
  let path = "", connected = false;
  for (const bucket of data.buckets) {
    const value = valueFor(bucket);
    if (value === null) { connected = false; continue; }
    path += `${connected ? "L" : "M"}${x(centerAt(bucket)).toFixed(2)},${y(value).toFixed(2)} `;
    connected = true;
  }
  const hasPoints = data.buckets.some(bucket => valueFor(bucket) !== null);

  return (
    <section className={styles.chartCard} aria-label={title}>
      <div className={styles.chartHead}>
        <h4>{isRate ? "请求成功率" : "Token 消耗量"}</h4>
        <span>{isRate ? "成功 ÷（成功 + 失败）" : "输入 + 输出 + 缓存"}</span>
      </div>
      <div className={styles.chartScroll}>
        <svg className={`${styles.chart} ${isRate ? styles.rateChart : ""}`} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title}>
          {[0, max / 2, max].map(value => (
            <g key={value} className={styles.axis}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} />
              <text x={left - 10} y={y(value) + 4} textAnchor="end">{isRate ? percent(value) : compact(value)}</text>
            </g>
          ))}
          {[0, 1, 2, 3, 4].map(index => {
            const at = data.startAt + duration * index / 4;
            return <text key={index} className={styles.timeTick} x={x(at)} y={height - 12} textAnchor={index === 0 ? "start" : index === 4 ? "end" : "middle"}>{tickTime(at, data.range)}</text>;
          })}
          {path && <path className={styles.chartLine} d={path.trim()} />}
          {!hasPoints && <text className={styles.noPoints} x={left + plotWidth / 2} y={top + plotHeight / 2} textAnchor="middle">{isRate ? "尚无可计算成功率的请求" : "此范围内尚未开始统计用量"}</text>}
          {data.buckets.map(bucket => {
            const value = valueFor(bucket);
            const pointX = x(centerAt(bucket));
            return value !== null && <circle key={bucket.startAt} className={styles.chartDot} cx={pointX} cy={y(value)} r="3" />;
          })}
          {data.buckets.map(bucket => {
            const value = valueFor(bucket);
            const pointX = x(centerAt(bucket));
            const time = `${dateTime(bucket.startAt)} – ${new Date(Math.min(bucket.startAt + data.bucketMs, data.endAt)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`;
            const recorded = isRecorded(bucket);
            const detail = !recorded ? ["尚未开始统计"] : isRate
              ? [`成功率 ${value === null ? "无已完成请求" : percent(value)}`, `成功 ${number(bucket.successes)} · 失败 ${number(bucket.failures)} · 取消 ${number(bucket.cancellations)}`]
              : [`总计 ${number(bucket.totalTokens)} tokens`, `输入 ${number(bucket.inputTokens)} · 输出 ${number(bucket.outputTokens)}`, `缓存读取 ${bucket.cacheReadReportedRequests ? number(bucket.cacheReadTokens) : "—"} · 创建 ${bucket.cacheCreationReportedRequests ? number(bucket.cacheCreationTokens) : "—"}`];
            const tooltipX = Math.min(width - 256, Math.max(4, pointX - 124));
            const requestDetail = recorded ? `${number(bucket.requests)} 次请求，` : "";
            return (
              <g key={bucket.startAt} className={styles.bucket} tabIndex={0} role="group" aria-label={`${time}，${requestDetail}${detail.join("，")}`}>
                <title>{`${time}\n${requestDetail}${detail.join("\n")}`}</title>
                <rect className={styles.bucketTarget} x={x(bucket.startAt)} y={top - 4} width={Math.max(1, x(Math.min(bucket.startAt + data.bucketMs, data.endAt)) - x(bucket.startAt))} height={plotHeight + 8} />
                <line className={styles.crosshair} x1={pointX} x2={pointX} y1={top} y2={top + plotHeight} />
                <g className={styles.tooltip} transform={`translate(${tooltipX},${top + 6})`} aria-hidden="true">
                  <rect width="252" height={41 + detail.length * 19} rx="7" />
                  <text x="10" y="19">{time}</text>
                  {detail.map((line, index) => <text key={index} x="10" y={39 + index * 19}>{line}</text>)}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
      <p className={styles.chartHint}>{isRate ? "无已完成请求的时段留空。" : "每个点表示该时段收到的用量。"}悬停或使用 Tab 查看明细。</p>
    </section>
  );
}

export function ProviderDashboard() {
  const [range, setRange] = useState<ProviderUsageRange>("24h");
  const [providerId, setProviderId] = useState("");
  const [data, setData] = useState<ProviderUsageDashboard | null>(null);
  const [providers, setProviders] = useState<ProviderUsageDashboard["providers"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(640);
  const chartContainer = useRef<HTMLDivElement | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const hasRequests = Boolean(data?.metrics.requests);

  useEffect(() => {
    const container = chartContainer.current;
    if (!container) return;
    const measure = () => setChartWidth(Math.max(280, container.clientWidth - 30));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [hasRequests]);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const load = async () => {
      const request = ++requestId;
      setLoading(true);
      try {
        const next = await window.desktop.getProviderUsage(range, providerId || undefined);
        if (!active || request !== requestId) return;
        setData(next);
        setProviders(next.providers);
        setError(null);
      } catch (err) {
        if (active && request === requestId) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active && request === requestId) setLoading(false);
      }
    };
    refresh.current = load;
    setData(null);
    setError(null);
    void load();
    const timer = setInterval(() => void load(), 60000);
    const unsubscribeUsage = window.desktop.on(IPC.providerUsageUpdated, () => void load());
    const unsubscribeProviders = window.desktop.on(IPC.providerUpdated, () => void load());
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribeUsage();
      unsubscribeProviders();
    };
  }, [range, providerId]);

  const metrics = data?.metrics;
  const selectedProvider = providers.find(provider => provider.providerId === providerId);
  const scope = providerId ? selectedProvider?.providerName || "所选 Provider" : "全部 Provider";
  return (
    <section className={styles.section} aria-label="Provider 用量统计" aria-busy={loading}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Provider 仪表盘</h3>
          <p>查看实际请求的 Token 消耗量与成功率。</p>
        </div>
        <button type="button" onClick={() => void refresh.current()} disabled={loading} className={styles.refreshBtn}>{loading && data ? "刷新中…" : "刷新"}</button>
      </div>
      <div className={styles.filters}>
        <div className={styles.ranges} role="group" aria-label="统计时间范围">
          {RANGES.map(option => <button type="button" key={option.value} aria-pressed={range === option.value} onClick={() => setRange(option.value)} title={option.value === "30d" ? "近 30 天" : undefined}>{option.label}</button>)}
        </div>
        <label className={styles.providerFilter}>
          <span>Provider</span>
          <select aria-label="筛选 Provider" value={providerId} onChange={event => setProviderId(event.target.value)}>
            <option value="">全部 Provider</option>
            {providers.map(provider => <option key={provider.providerId} value={provider.providerId}>{provider.providerName}</option>)}
            {providerId && !selectedProvider && <option value={providerId}>所选 Provider</option>}
          </select>
        </label>
      </div>

      {error && <div className={styles.error} role="alert"><span>加载用量统计失败：{error}</span><button type="button" onClick={() => void refresh.current()} disabled={loading}>重试</button></div>}
      {!data && loading && <p className={styles.hint} role="status">加载统计中…</p>}
      {data && metrics && <>
        <p className={styles.scope}>{scope}<span>{dateTime(data.startAt)} — {dateTime(data.endAt)}</span></p>
        <div className={styles.summary}>
          <div className={`${styles.stat} ${styles.tokenStat}`}><span className={styles.statLabel}>总 Token</span><strong className={styles.statValue}>{number(metrics.totalTokens)}</strong><span className={styles.statSub}>已报告的用量合计</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>请求数</span><strong className={styles.statValue}>{number(metrics.requests)}</strong><span className={styles.statSub}>{`已取消 ${number(metrics.cancellations)}`}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>成功率</span><strong className={styles.statValue}>{percent(metrics.successRate)}</strong><span className={styles.statSub}>{metrics.successRate === null ? "无已完成请求" : `${number(metrics.successes)} 次成功`}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>失败数</span><strong className={`${styles.statValue} ${metrics.failures ? styles.statValueWarn : ""}`}>{number(metrics.failures)}</strong><span className={styles.statSub}>取消的请求单独统计</span></div>
        </div>
        <dl className={styles.tokenBreakdown}>
          <div><dt>输入</dt><dd>{number(metrics.inputTokens)}</dd></div><div><dt>输出</dt><dd>{number(metrics.outputTokens)}</dd></div>
          <div><dt>缓存读取</dt><dd>{metrics.cacheReadReportedRequests ? number(metrics.cacheReadTokens) : "—"}</dd></div><div><dt>缓存创建</dt><dd>{metrics.cacheCreationReportedRequests ? number(metrics.cacheCreationTokens) : "—"}</dd></div>
        </dl>
        {metrics.requests === 0 ? <div className={styles.empty}><strong>此时间范围内还没有请求记录</strong><span>使用 Provider 发起请求后，这里会逐步显示真实用量和成功率。</span></div> : <div className={styles.charts} ref={chartContainer}>
          <UsageChart data={data} kind="tokens" width={chartWidth} /><UsageChart data={data} kind="success" width={chartWidth} />
        </div>}
        {providers.length > 0 && <section className={styles.providerCard} aria-label="各 Provider 表现">
          <div className={styles.chartHead}><h4>各 Provider 表现</h4><span>当前时间范围 · 点击名称筛选</span></div>
          <div className={styles.tableScroll}><table className={styles.providerTable}>
            <thead><tr><th scope="col">Provider</th><th scope="col">请求数</th><th scope="col">Token</th><th scope="col">成功率</th></tr></thead>
            <tbody>{providers.map(provider => <tr key={provider.providerId} className={provider.providerId === providerId ? styles.selectedRow : ""}>
              <th scope="row"><button type="button" className={styles.providerName} title={provider.providerName} onClick={() => setProviderId(provider.providerId)}>{provider.providerName}</button><span className={styles.providerType}>{PROVIDER_LABELS[provider.providerType] ?? provider.providerType}</span></th>
              <td>{number(provider.metrics.requests)}</td><td>{number(provider.metrics.totalTokens)}</td><td title={`${number(provider.metrics.successes)} 次成功，${number(provider.metrics.failures)} 次失败`}>{percent(provider.metrics.successRate)}</td>
            </tr>)}</tbody>
          </table></div>
        </section>}
        <div className={styles.notes}>
          <p>{`统计从 ${dateTime(data.recordingSince)} 开始积累，更早的历史不会补算。`}</p>
          <p>仅统计上游已报告用量，失败/取消请求可能不完整。成功率不包含取消的请求。</p>
          {metrics.requests > 0 && <p>{`缓存读取由 ${number(metrics.cacheReadReportedRequests)} 个请求报告，其中 ${number(metrics.cacheHitRequests)} 个请求命中。缓存创建由 ${number(metrics.cacheCreationReportedRequests)} 个请求报告。`}</p>}
          {metrics.unreportedUsageRequests > 0 && <p className={styles.usageWarning}>{`有 ${number(metrics.unreportedUsageRequests)} 个请求完全未上报用量。`}</p>}
        </div>
      </>}
    </section>
  );
}
