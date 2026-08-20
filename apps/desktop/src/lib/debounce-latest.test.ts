import { describe, expect, it } from "vitest";
import { createDebouncedLatest } from "./debounce-latest";

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createDebouncedLatest", () => {
  it("applies only the last scheduled result", async () => {
    const d = createDebouncedLatest<number>(20);
    const seen: number[] = [];
    d.schedule(async () => 1, (v) => seen.push(v));
    d.schedule(async () => 2, (v) => seen.push(v));
    await wait(50);
    expect(seen).toEqual([2]);
  });

  it("drops an in-flight result when a newer load is scheduled", async () => {
    const d = createDebouncedLatest<number>(5);
    const seen: number[] = [];
    d.schedule(
      () => wait(40).then(() => 1),
      (v) => seen.push(v),
    );
    await wait(15);
    d.schedule(async () => 2, (v) => seen.push(v));
    await wait(60);
    expect(seen).toEqual([2]);
  });

  it("delay 0 runs immediately and is still dropped if a later load wins", async () => {
    const d = createDebouncedLatest<number>(20);
    const seen: number[] = [];
    d.schedule(
      () => wait(30).then(() => 1),
      (v) => seen.push(v),
      undefined,
      0,
    );
    d.schedule(async () => 2, (v) => seen.push(v), undefined, 0);
    await wait(50);
    expect(seen).toEqual([2]);
  });

  it("cancel prevents a pending apply", async () => {
    const d = createDebouncedLatest<number>(15);
    const seen: number[] = [];
    d.schedule(async () => 1, (v) => seen.push(v));
    d.cancel();
    await wait(40);
    expect(seen).toEqual([]);
  });
});
