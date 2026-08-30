import React, { useMemo, useState } from "react";
import type { RoomRole, RoomSeat } from "@claude-desktop/shared";
import {
  actionFields,
  asModView,
  formatModBadge,
  normalizeActions,
  preferredPlaySeatId,
  type ActionField,
} from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";
import {
  endRoomMod,
  recoverRoomMod,
  resetRoomMod,
  sendRoomModIntent,
  startRoomMod,
  useRoomStore,
} from "../state/room-store";
import { ToggleSwitch } from "./ToggleSwitch";

function JsonCollapse({ value }: { value: unknown }) {
  return (
    <details className="room-mod-json">
      <summary>JSON</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function ViewBlock({
  heading,
  value,
}: {
  heading: string;
  value: unknown;
}) {
  const view = asModView(value);
  if (!view) {
    return (
      <section className="room-mod-view">
        <h4>{heading}</h4>
        <JsonCollapse value={value} />
      </section>
    );
  }
  return (
    <section className="room-mod-view">
      <h4>{heading}</h4>
      <div className="room-mod-view-head">
        <span className="room-mod-title">{view.title}</span>
        <span className="room-mod-phase">{view.phase}</span>
      </div>
      {view.badges?.length ? (
        <div className="room-mod-badges">
          {view.badges.map((b, i) => (
            <span
              key={`${b.label}-${i}`}
              className={`room-mod-chip tone-${b.tone || "default"}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      ) : null}
      {view.lines.length ? (
        <ul className="room-mod-lines">
          {view.lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function fieldDefault(field: ActionField): string | boolean {
  if (field.type === "boolean") return false;
  if (field.type === "enum") return field.enumValues?.[0] ?? "";
  return "";
}

function ActionForm({
  name,
  schema,
  disabled,
  submitLabel,
  onSubmit,
}: {
  name: string;
  schema: { params?: unknown; hint?: string };
  disabled: boolean;
  submitLabel: string;
  onSubmit: (name: string, payload: Record<string, unknown>) => void;
}) {
  const fields = useMemo(() => actionFields(schema.params), [schema.params]);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {};
    for (const f of actionFields(schema.params)) {
      init[f.name] = fieldDefault(f);
    }
    return init;
  });

  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.name];
      if (f.type === "boolean") {
        payload[f.name] = Boolean(raw);
      } else if (f.type === "number") {
        const n = Number(raw);
        payload[f.name] = Number.isFinite(n) ? n : raw;
      } else {
        payload[f.name] = raw;
      }
    }
    return payload;
  };

  const missing = fields.some(
    (f) =>
      f.required &&
      f.type !== "boolean" &&
      String(values[f.name] ?? "").trim() === "",
  );

  return (
    <form
      className="room-mod-action"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || missing) return;
        onSubmit(name, buildPayload());
      }}
    >
      <div className="room-mod-action-head">
        <span className="room-mod-action-name">{name}</span>
        {schema.hint ? (
          <span className="room-mod-action-hint">{schema.hint}</span>
        ) : null}
      </div>
      {fields.map((f) =>
        f.type === "boolean" ? (
          <div key={f.name} className="settings-toggle-row is-compact">
            <span>{f.name}</span>
            <ToggleSwitch
              checked={Boolean(values[f.name])}
              label={`${Boolean(values[f.name]) ? "停用" : "启用"}${f.name}`}
              disabled={disabled}
              onCheckedChange={(on) =>
                setValues((prev) => ({ ...prev, [f.name]: on }))
              }
            />
          </div>
        ) : (
          <label key={f.name} className="settings-field">
            {f.name}
            {f.type === "enum" ? (
            <select
              className="select"
              value={String(values[f.name] ?? "")}
              disabled={disabled}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [f.name]: e.target.value }))
              }
            >
              {(f.enumValues ?? []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === "number" ? "number" : "text"}
              value={String(values[f.name] ?? "")}
              disabled={disabled}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [f.name]: e.target.value }))
              }
            />
          )}
          </label>
        ),
      )}
      <button
        type="submit"
        className="btn btn-sm"
        disabled={disabled || missing}
      >
        {fields.length ? submitLabel : name}
      </button>
    </form>
  );
}

export function ModPlayPanel({
  role,
  seats,
  localUserId,
}: {
  role: RoomRole;
  seats: RoomSeat[];
  localUserId?: string;
}) {
  const { t } = useI18n();
  const mod = useRoomStore((s) => s.mod);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);

  if (!mod) return null;

  const offer = mod.offer;
  const badge = formatModBadge(offer, t.room.modBadge);
  const publicView = asModView(mod.publicView);
  const phase = publicView?.phase ?? "";
  const started = Boolean(phase) && phase !== "lobby" && phase !== "idle";
  const canHost = role === "host";
  const seatViews = mod.seatViews ?? {};
  const localIds = Object.keys(seatViews);
  const playSeatId = preferredPlaySeatId(seats, seatViews, localUserId);
  const actions = normalizeActions(mod.actions);
  const actionNames = Object.keys(actions);
  const showEnd = started || Boolean(mod.fail);

  const runHost = async (
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setBusy(true);
    setErr(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "操作失败");
  };

  const onIntent = async (name: string, payload: Record<string, unknown>) => {
    if (!playSeatId) {
      setErr("请先选一个席位");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await sendRoomModIntent(playSeatId, name, payload);
    setBusy(false);
    if (!res.ok) setErr(res.error ?? "操作失败");
  };

  return (
    <div className="room-mod-panel">
      <div className="room-mod-panel-head">
        {badge ? <span className="room-mod-badge">{badge}</span> : null}
        {canHost ? (
          <div className="room-mod-host">
            {!started ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void runHost(startRoomMod)}
              >
                {t.room.startPlay}
              </button>
            ) : null}
            {showEnd ? (
              confirmEnd ? (
                <span className="room-leave-confirm">
                  {t.room.endPlayConfirm}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmEnd(false);
                      void runHost(endRoomMod);
                    }}
                  >
                    {t.room.endPlayYes}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmEnd(false)}
                  >
                    {t.common.cancel}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmEnd(true)}
                >
                  {t.room.endPlay}
                </button>
              )
            ) : null}
            {started && !mod.fail ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void runHost(resetRoomMod)}
              >
                {t.room.resetPlay}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {mod.fail ? (
        <div className="room-mod-fail">
          <p>{mod.fail}</p>
          {canHost ? (
            <div className="room-mod-host">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void runHost(recoverRoomMod)}
              >
                {t.room.recoverPlay}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => setConfirmEnd(true)}
              >
                {t.room.endPlay}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {mod.publicView !== undefined ? (
        <ViewBlock heading={t.room.publicView} value={mod.publicView} />
      ) : null}

      {localIds.map((id) => {
        const seat = seats.find((s) => s.id === id);
        return (
          <ViewBlock
            key={id}
            heading={
              seat
                ? `${t.room.seatView} · ${seat.name}`
                : `${t.room.seatView} · ${id.slice(0, 8)}`
            }
            value={seatViews[id]}
          />
        );
      })}

      {actionNames.length > 0 && playSeatId ? (
        <div className="room-mod-actions">
          {actionNames.map((name) => (
            <ActionForm
              key={name}
              name={name}
              schema={actions[name] ?? {}}
              disabled={busy}
              submitLabel={t.room.submitAction}
              onSubmit={onIntent}
            />
          ))}
        </div>
      ) : null}

      {err ? <p className="room-err">{err}</p> : null}
    </div>
  );
}
