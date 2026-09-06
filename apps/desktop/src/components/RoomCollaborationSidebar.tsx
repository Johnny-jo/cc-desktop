import React from "react";

export type RoomCollaborationTab = "tasks" | "members" | "activity";

type Props = {
  id: string;
  open: boolean;
  activeTab: RoomCollaborationTab;
  taskCount: number;
  seatCount: number;
  tasks: React.ReactNode;
  members: React.ReactNode;
  activity: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: RoomCollaborationTab) => void;
};

const tabs = [
  { id: "tasks", label: "任务" },
  { id: "members", label: "成员" },
  { id: "activity", label: "活动" },
] as const;

/** Keep each pane mounted so hiding a tab never resets an in-flight Mod action. */
export function RoomCollaborationSidebar(props: Props) {
  const { id, open, activeTab, onOpenChange, onTabChange } = props;
  return (
    <aside id={id} className="room-collaboration" aria-label="协作侧栏" hidden={!open}
      onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onOpenChange(false);
        }
      }}>
      <div className="room-collaboration-heading">
        <span>协作</span>
        <button type="button" className="room-head-icon-btn" aria-label="收起协作侧栏"
          title="收起协作侧栏" aria-controls={id} aria-expanded={open} onClick={() => onOpenChange(false)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="room-collaboration-tabs" role="tablist" aria-label="协作分类">
        {tabs.map((tab, index) => (
          <button key={tab.id} id={`${id}-tab-${tab.id}`} type="button" role="tab" data-room-tab={tab.id}
            className="room-collaboration-tab" aria-label={tab.label} aria-selected={activeTab === tab.id}
            aria-controls={`${id}-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={event => {
              let next: number;
              switch (event.key) {
                case "ArrowRight": next = (index + 1) % tabs.length; break;
                case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
                case "Home": next = 0; break;
                case "End": next = tabs.length - 1; break;
                default: return;
              }
              event.preventDefault();
              onTabChange(tabs[next].id);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-room-tab="${tabs[next].id}"]`)?.focus();
            }}>
            {tab.label}
            {tab.id !== "activity" ? <span className="room-collaboration-count">
              {tab.id === "tasks" ? props.taskCount : props.seatCount}
            </span> : null}
          </button>
        ))}
      </div>
      {tabs.map(tab => (
        <section key={tab.id} id={`${id}-panel-${tab.id}`} role="tabpanel" tabIndex={0}
          className={`room-collaboration-pane is-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`}
          hidden={activeTab !== tab.id}>
          {props[tab.id]}
        </section>
      ))}
    </aside>
  );
}
