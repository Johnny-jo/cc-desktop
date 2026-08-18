export function activate(ctx) {
  ctx.hooks.on("room.chat.in", function (env) {
    var text = String(env.text || "").trim();
    if (!text) return { action: "drop", reason: "empty" };
    if (text !== env.text) {
      return { action: "replace", value: Object.assign({}, env, { text: text }) };
    }
    return { action: "continue", value: env };
  });
}
