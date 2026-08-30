import React, { useCallback, useEffect, useState } from "react";
import type { AppMemoryDiagnostics } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../../lib/desktop-api";
import { getEditorBufferCacheSize } from "../../lib/editor-buffer-cache";

type RendererHeap = {
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
};

function bytesToMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function kbToMb(kb: number | undefined): string {
  return kb === undefined ? "—" : (kb / 1024).toFixed(1);
}

function readRendererHeap(): RendererHeap | null {
  const memory = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    }
  ).memory;
  if (!memory) return null;
  return {
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
  };
}

export function MemoryDiagnostics() {
  const [snapshot, setSnapshot] = useState<AppMemoryDiagnostics | null>(null);
  const [rendererHeap, setRendererHeap] = useState<RendererHeap | null>(null);
  const [editorBuffers, setEditorBuffers] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRendererHeap(readRendererHeap());
    setEditorBuffers(getEditorBufferCacheSize());
    if (!hasDesktopApi("getMemoryDiagnostics")) {
      setError("当前 preload 版本不支持内存诊断，请重启应用后再试。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getDesktop().getMemoryDiagnostics());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalWorkingSetKb =
    snapshot?.processes.reduce((total, item) => total + item.workingSetKb, 0) ?? 0;
  const sessions = snapshot?.caches.sessions;
  const rooms = snapshot?.caches.rooms;

  return (
    <div className="memory-diagnostics">
      <div className="memory-diagnostics-actions">
        <p className="settings-hint">
          工作集来自操作系统，包含 Electron/Chromium 共享页；用于看趋势和定位大进程，不能与 JS 堆简单相加。
        </p>
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? "采样中…" : "重新采样"}
        </button>
      </div>

      {error ? <p className="settings-error">{error}</p> : null}

      {snapshot ? (
        <>
          <div className="memory-stat-grid">
            <div className="memory-stat-card">
              <span>Electron 工作集</span>
              <strong>{kbToMb(totalWorkingSetKb)} MB</strong>
              <small>{snapshot.processes.length} 个进程 / {snapshot.windows} 个窗口</small>
            </div>
            <div className="memory-stat-card">
              <span>主进程 RSS</span>
              <strong>{bytesToMb(snapshot.main.rssBytes)} MB</strong>
              <small>JS 堆 {bytesToMb(snapshot.main.heapUsedBytes)} / {bytesToMb(snapshot.main.heapTotalBytes)} MB</small>
            </div>
            <div className="memory-stat-card">
              <span>当前渲染进程</span>
              <strong>{kbToMb(snapshot.renderer?.residentSetKb)} MB</strong>
              <small>
                JS 堆 {rendererHeap ? `${bytesToMb(rendererHeap.usedBytes)} / ${bytesToMb(rendererHeap.totalBytes)} MB` : "不可用"}
              </small>
            </div>
          </div>

          <section className="memory-diagnostics-section">
            <h3>进程</h3>
            <div className="memory-process-table-wrap">
              <table className="memory-process-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>PID</th>
                    <th>工作集 MB</th>
                    <th>私有 MB</th>
                    <th>CPU</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.processes.map((item) => (
                    <tr key={`${item.pid}-${item.type}`}>
                      <td title={item.serviceName ?? item.name}>
                        {item.serviceName ?? item.name ?? item.type}
                        {item.serviceName || item.name ? <small>{item.type}</small> : null}
                      </td>
                      <td>{item.pid}</td>
                      <td>{kbToMb(item.workingSetKb)}</td>
                      <td>{kbToMb(item.privateKb)}</td>
                      <td>{item.cpuPercent.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="memory-diagnostics-section">
            <h3>内存缓存与活动对象</h3>
            <dl className="memory-cache-grid">
              <div><dt>已载入会话正文</dt><dd>{sessions?.hydratedTranscripts ?? 0} / {sessions?.hydratedItems ?? 0} 条消息</dd></div>
              <div><dt>已载入变更</dt><dd>{sessions?.hydratedChanges ?? 0} 个会话 / {sessions?.trackedChangeFiles ?? 0} 个文件</dd></div>
              <div><dt>运行中查询</dt><dd>{sessions?.liveQueries ?? 0}</dd></div>
              <div><dt>Room 时间线</dt><dd>{rooms ? `${rooms.rooms} 个房间 / ${rooms.timelineItems} 条` : "未启用"}</dd></div>
              <div><dt>Room 在线对象</dt><dd>{rooms ? `${rooms.connections} 个连接 / ${rooms.liveExecutions} 个执行` : "未启用"}</dd></div>
              <div><dt>Room 待落盘</dt><dd>{rooms?.pendingPersists ?? 0}</dd></div>
              <div><dt>终端 PTY</dt><dd>{snapshot.caches.terminals}</dd></div>
              <div><dt>文件索引</dt><dd>{snapshot.caches.fileIndex.projects} 个项目 / {snapshot.caches.fileIndex.indexedFiles} 个路径</dd></div>
              <div><dt>编辑器快照</dt><dd>{editorBuffers}</dd></div>
            </dl>
          </section>

          <p className="memory-diagnostics-sampled">
            采样时间：{new Date(snapshot.sampledAt).toLocaleTimeString()}
          </p>
        </>
      ) : loading ? (
        <p className="settings-hint">正在读取进程信息…</p>
      ) : null}
    </div>
  );
}
