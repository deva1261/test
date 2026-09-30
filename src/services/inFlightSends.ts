/** Tracks message sends in flight so a disconnect can cancel them. */
export class InFlightSends {
  private readonly controllers = new Set<AbortController>();

  start(): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    this.controllers.add(controller);
    return { signal: controller.signal, done: () => this.controllers.delete(controller) };
  }

  abortAll(): number {
    const count = this.controllers.size;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    return count;
  }

  get size(): number {
    return this.controllers.size;
  }
}
