export function activate(ctx) {
  ctx.schedule.every(60000, function () {
    return {};
  });
}
