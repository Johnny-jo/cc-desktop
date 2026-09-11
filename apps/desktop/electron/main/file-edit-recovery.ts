/** Guidance delivered only after a file mutation fails; never grants permission. */
export async function fileEditRecovery(input: {
  tool_name?: string;
  is_interrupt?: boolean;
}) {
  if (input.is_interrupt || !["Edit", "Write", "MultiEdit"].includes(input.tool_name ?? "")) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUseFailure" as const,
      additionalContext: [
        "文件编辑失败恢复规则：先根据工具返回的实际错误诊断，不要仅因文件存在未提交修改就推断为 Git 锁。",
        "向用户说明失败的操作、具体文件地址及已知原因；不确定时明确说明尚未确认。",
        "若旧文本不匹配或文件自上次读取后已变化，先重新读取最新文件并比较，保留用户和其他任务已有修改。仅在能保留已有修改且没有重叠冲突时，基于最新内容修正后重试一次。",
        "若有重叠冲突或再次失败，停止写入该文件，展示具体冲突片段和拟议修改，通过 AskUserQuestion 请用户选择保留现有内容、合并修改或明确放弃哪一部分；等待答复后再操作。不要把笼统的编辑授权当成丢弃已有修改的授权。",
        "若是权限拒绝、只读、文件占用或锁错误，按实际原因说明所需处理并请求必要授权；不要重复盲试、擅自删除锁文件或放弃修改。",
        "不得为了绕过编辑失败、权限限制或冲突检查，改用 Python、Node、Shell 脚本或整文件覆盖强行写入。",
      ].join("\n"),
    },
  };
}
