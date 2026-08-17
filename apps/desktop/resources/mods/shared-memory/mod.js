export function activate(ctx) {
  const ns = ctx.storage.namespace("memory");
  ctx.provide("memory", {
    get: function (key) {
      return ns.get(String(key));
    },
    set: function (key, value) {
      return ns.set(String(key), String(value));
    },
    list: function (prefix) {
      return ns.list(prefix);
    },
    search: function (query) {
      return ns.search(String(query));
    },
  });
}
