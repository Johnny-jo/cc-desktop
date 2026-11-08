const segments = new Intl.Segmenter("zh", { granularity: "grapheme" });

function sessionLabel(title) {
  const text = String(title ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/^\s*AgentOS\s*[:：]\s*/i, "")
    .replace(/^\s*(?:(?:请|麻烦|帮我|帮忙|能不能|我想要|我想|我需要)\s*)+/, "")
    .split(/[，,。！？!?\n]/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  const summary = [...segments.segment(text)].slice(0, 10).map(part => part.segment).join("").trim();
  return `AgentOS：${summary || "浏览器会话"}`;
}

module.exports = { sessionLabel };
