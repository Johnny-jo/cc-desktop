export function activate(ctx) {
  ctx.hooks.on("room.chat.in", function (env) {
    var mem = ctx.memory;
    if (!mem || typeof mem.list !== "function" || typeof mem.get !== "function") {
      return { action: "continue", value: env };
    }
    var text = String(env.text || "");
    var keys = mem.list();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = mem.get(k);
      if (!k || v == null || v === "") continue;
      text = text.split(k).join(String(v));
    }
    if (text !== env.text) {
      return { action: "replace", value: Object.assign({}, env, { text: text }) };
    }
    return { action: "continue", value: env };
  });
}
