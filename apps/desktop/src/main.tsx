import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const query = new URLSearchParams(window.location.search);
const isDetached = query.get("detached") === "1";
const WindowApp = lazy(() => {
  if (isDetached && query.get("room")) {
    return import("./DetachedRoomApp");
  }
  if (isDetached && query.get("session")) {
    return import("./DetachedSessionApp");
  }
  return import("./App").then((module) => ({ default: module.App }));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="app-loading" aria-label="正在加载" />}>
      <WindowApp />
    </Suspense>
  </React.StrictMode>
);
