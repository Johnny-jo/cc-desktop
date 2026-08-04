import type { UserContentBlock } from "@claude-desktop/shared";

/**
 * Pushable async iterable for Agent SDK streaming input mode.
 * `query({ prompt: stream })` enables control requests (supportedCommands, interrupt, …).
 */
export type StreamUserMessage = {
  type: "user";
  message: { role: "user"; content: string | UserContentBlock[] };
  parent_tool_use_id: null;
  session_id?: string;
};

export class MessageStream implements AsyncIterable<StreamUserMessage> {
  private readonly queue: StreamUserMessage[] = [];
  private waiters: Array<{
    resolve: (v: IteratorResult<StreamUserMessage>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;

  push(content: string | UserContentBlock[], sessionId?: string): void {
    if (this.closed) {
      throw new Error("MessageStream is closed");
    }
    const msg: StreamUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(sessionId ? { session_id: sessionId } : {}),
    };
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      w?.resolve({ value: undefined as unknown as StreamUserMessage, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamUserMessage> {
    return {
      next: (): Promise<IteratorResult<StreamUserMessage>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as StreamUserMessage,
            done: true,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: (): Promise<IteratorResult<StreamUserMessage>> => {
        this.end();
        return Promise.resolve({
          value: undefined as unknown as StreamUserMessage,
          done: true,
        });
      },
    };
  }
}
