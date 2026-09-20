/**
 * Single-consumer async queue. The consumer is the generator feeding query();
 * producers are the WebSocket handlers. A push that lands before the consumer
 * attaches must not be lost, so items buffer.
 */
export const END = Symbol("end");

export class MessageQueue<T> {
  private items: T[] = [];
  private waiting: ((value: T | typeof END) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(item);
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter(END);
    }
  }

  take(): Promise<T | typeof END> {
    const next = this.items.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.closed) return Promise.resolve(END);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
