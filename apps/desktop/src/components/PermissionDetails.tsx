import React from "react";
import type { PermissionRequest } from "@claude-desktop/shared";
import type { Messages } from "../i18n/en";

export function permissionAction(name: string, t: Messages["prompts"]): string {
  return ({ Edit: t.editFile, Write: t.writeFile, Read: t.readFile, Bash: t.runCommand } as Record<string, string>)[name] ?? name;
}

export function PermissionDetails({ request, t }: { request: PermissionRequest; t: Messages["prompts"] }) {
  const input = request.inputPreview && typeof request.inputPreview === "object"
    ? request.inputPreview as Record<string, unknown> : {};
  const fileTool = ["Edit", "Write", "Read"].includes(request.toolName);
  const path = typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "string" ? input.path : request.summary;
  const snippet = (label: string, content: string) => (
    <section className="permission-snippet">
      <h4>{label}</h4>
      <pre className="agent-prompt-preview">{content || t.emptyContent}</pre>
    </section>
  );
  return <>
    {fileTool ? <><div className="permission-field-label">{t.filePath}</div><p className="permission-file-path">{path}</p></>
      : <p className="agent-prompt-title">{request.summary}</p>}
    {request.toolName === "Edit" && <>
      <p>{input.replace_all === true ? t.replaceAll : t.replaceOne}</p>
      {typeof input.old_string === "string" && snippet(t.beforeEdit, input.old_string)}
      {typeof input.new_string === "string" && snippet(t.afterEdit, input.new_string)}
    </>}
    {request.toolName === "Write" && typeof input.content === "string" && snippet(t.writeContent, input.content)}
    {request.toolName === "Bash" && typeof input.command === "string" && <>
      {typeof input.description === "string" && <p>{input.description}</p>}
      <pre className="agent-prompt-preview">{input.command}</pre>
    </>}
    <details className="permission-raw-details">
      <summary>{t.technicalDetails}</summary>
      <pre className="agent-prompt-preview">{JSON.stringify(request.inputPreview, null, 2)}</pre>
    </details>
  </>;
}
