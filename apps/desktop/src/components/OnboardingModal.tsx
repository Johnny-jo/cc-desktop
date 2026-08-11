import React, { useMemo, useState } from "react";
import { completeOnboarding, useAppStore } from "../state/store";

type Step = "welcome" | "token" | "confirm" | "done";

function randomGatewayToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Multi-step first-run setup when no CPA gateway token is stored.
 * Nothing is written until the user confirms on the last step.
 */
export function OnboardingModal({ open }: { open: boolean }) {
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const settings = useAppStore((s) => s.settings);
  const [step, setStep] = useState<Step>("welcome");
  const [token, setToken] = useState(() => randomGatewayToken());
  const [startCpa, setStartCpa] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultNote, setResultNote] = useState<string | null>(null);

  const cpaHint = useMemo(() => {
    if (cpaStatus.state === "ready") {
      return `CPA already ready on port ${cpaStatus.port}`;
    }
    if (cpaStatus.state === "error") {
      return `CPA: ${cpaStatus.message}`;
    }
    if (cpaStatus.state === "starting") return "CPA starting…";
    return "CPA is not running yet";
  }, [cpaStatus]);

  if (!open) return null;

  const goNextFromWelcome = () => {
    setError(null);
    setStep("token");
  };

  const goNextFromToken = () => {
    setError(null);
    if (!token.trim()) {
      setError("请填写或生成网关 token");
      return;
    }
    setStep("confirm");
  };

  const onConfirm = async () => {
    setError(null);
    setResultNote(null);
    const t = token.trim();
    if (!t) {
      setError("Token 不能为空");
      setStep("token");
      return;
    }
    setBusy(true);
    try {
      const res = await completeOnboarding(t, startCpa);
      if (!res.ok) {
        setError(res.error ?? "配置失败");
        return;
      }
      if (res.cpaStatus.state === "ready") {
        setResultNote(
          `配置完成 — CPA 已在端口 ${res.cpaStatus.port} 就绪。打开项目即可开始对话。`,
        );
      } else if (res.cpaStatus.state === "error") {
        setResultNote(
          `Token 已保存，但 CPA 尚未就绪：${res.cpaStatus.message}。可稍后在侧栏启动 CPA 或检查 Settings。`,
        );
      } else {
        setResultNote("Token 已保存。可打开项目开始使用。");
      }
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stepIndex =
    step === "welcome" ? 1 : step === "token" ? 2 : step === "confirm" ? 3 : 4;

  return (
    <div className="modal-overlay onboarding-overlay">
      <div
        className="modal onboarding-modal"
        role="dialog"
        aria-labelledby="onboarding-title"
      >
        <div className="modal-header">
          <span className="modal-title" id="onboarding-title">
            首次配置 · {stepIndex}/3
          </span>
        </div>

        <div className="modal-body">
          <ol className="onboarding-steps" aria-hidden>
            <li className={stepIndex >= 1 ? "active" : ""}>欢迎</li>
            <li className={stepIndex >= 2 ? "active" : ""}>网关 Token</li>
            <li className={stepIndex >= 3 ? "active" : ""}>确认并启动</li>
          </ol>

          {step === "welcome" ? (
            <>
              <p className="onboarding-lead">
                本应用已内置 <strong>Claude Code</strong> 与本地{" "}
                <strong>CPA</strong> 网关，无需再单独安装 CLI 或 CPA。
              </p>
              <ul className="onboarding-list">
                <li>
                  只需配置一个<strong>网关 Token</strong>（本机加密保存，对应
                  CPA 的 api-keys）
                </li>
                <li>
                  上游模型账号（Kimi 等）仍使用{" "}
                  <code>~/.cli-proxy-api</code>；若本机以前登录过 CPA，可直接复用
                </li>
                <li>路径、模型、权限等可在配置完成后于 Settings 中修改</li>
              </ul>
              <p className="settings-hint">{cpaHint}</p>
            </>
          ) : null}

          {step === "token" ? (
            <>
              <p className="onboarding-lead">
                设置本地 CPA 网关口令。应用请求会带上该 Token；请勿与上游厂商
                API Key 混淆。
              </p>
              <label className="settings-field">
                网关 Token（CPA api-keys）
                <div className="onboarding-token-row">
                  <input
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setToken(randomGatewayToken())}
                  >
                    重新生成
                  </button>
                </div>
              </label>
              <p className="settings-hint">
                已预填随机 Token，也可粘贴你现有 CPA 配置中的 api-key。
              </p>
            </>
          ) : null}

          {step === "confirm" ? (
            <>
              <p className="onboarding-lead">
                确认后才会写入配置并（可选）启动 CPA。上一步仍可返回修改。
              </p>
              <dl className="onboarding-summary">
                <div>
                  <dt>网关 Token</dt>
                  <dd className="onboarding-mono">
                    {token.length > 12
                      ? `${token.slice(0, 6)}…${token.slice(-4)}`
                      : token}
                  </dd>
                </div>
                <div>
                  <dt>CPA 可执行文件</dt>
                  <dd className="onboarding-mono" title={settings?.cpaExePath}>
                    {settings?.cpaExePath
                      ? settings.cpaExePath.replace(/\\/g, "/").split("/").pop()
                      : "（启动时自动解析内嵌路径）"}
                  </dd>
                </div>
                <div>
                  <dt>配置文件</dt>
                  <dd>用户目录下 cpa/config.yaml（首次自动生成）</dd>
                </div>
                <div>
                  <dt>端口</dt>
                  <dd>{settings?.cpaPort ?? 8317}</dd>
                </div>
              </dl>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={startCpa}
                  disabled={busy}
                  onChange={(e) => setStartCpa(e.target.checked)}
                />
                完成后立即启动 CPA
              </label>
              <p className="settings-hint">{cpaHint}</p>
            </>
          ) : null}

          {step === "done" ? (
            <>
              <p className="settings-ok">
                {resultNote ?? "配置已保存。"}
              </p>
              <p className="settings-hint">
                若上游模型尚未登录，请先在 CPA / 官方流程中完成凭证，或检查{" "}
                <code>~/.cli-proxy-api</code>。之后可在侧栏打开项目开始对话。
              </p>
            </>
          ) : null}

          {error ? <p className="settings-error">{error}</p> : null}
        </div>

        <div className="modal-actions onboarding-actions">
          {step === "welcome" ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={goNextFromWelcome}
            >
              下一步
            </button>
          ) : null}

          {step === "token" ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep("welcome");
                }}
              >
                上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={goNextFromToken}
              >
                下一步
              </button>
            </>
          ) : null}

          {step === "confirm" ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep("token");
                }}
              >
                上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void onConfirm()}
              >
                {busy
                  ? "正在应用…"
                  : startCpa
                    ? "确认并启动 CPA"
                    : "确认并保存"}
              </button>
            </>
          ) : null}

          {step === "done" ? (
            <p className="settings-hint" style={{ margin: 0 }}>
              保存成功后此窗口会自动关闭；若仍显示，请检查 token 是否写入成功。
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
