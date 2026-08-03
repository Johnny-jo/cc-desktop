import { describe, expect, it } from "vitest";
import { MessageStream } from "./message-stream";

describe("MessageStream", () => {
  it("delivers pushed messages to async consumers", async () => {
    const stream = new MessageStream();
    const iter = stream[Symbol.asyncIterator]();

    const nextP = iter.next();
    stream.push("hello");
    const first = await nextP;
    expect(first.done).toBe(false);
    expect(first.value?.message.content).toBe("hello");

    stream.push("world");
    const second = await iter.next();
    expect(second.value?.message.content).toBe("world");

    stream.end();
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  it("queues messages before consumer reads", async () => {
    const stream = new MessageStream();
    stream.push("a");
    stream.push("b");
    const iter = stream[Symbol.asyncIterator]();
    expect((await iter.next()).value?.message.content).toBe("a");
    expect((await iter.next()).value?.message.content).toBe("b");
    stream.end();
    expect((await iter.next()).done).toBe(true);
  });
});
