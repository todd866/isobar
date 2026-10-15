export interface FeedbackEvent { at: string; type: string; data: unknown }

/** Bounded, ephemeral history; callers cannot mutate retained evidence. */
export class FeedbackBuffer {
  private events: FeedbackEvent[] = [];
  constructor(private readonly now = Date.now, private readonly limit = 500, private readonly age = 60_000) {}
  add(type: string, data: unknown = null) {
    const now = this.now();
    const json = JSON.stringify(data) ?? 'null';
    const bounded = json.length > 2000 ? { truncated: true, preview: json.slice(0, 1000) } : JSON.parse(json);
    this.events.push({ at: new Date(now).toISOString(), type, data: bounded });
    this.prune(now);
  }
  private prune(now: number) {
    this.events = this.events.filter(e => now - Date.parse(e.at) <= this.age).slice(-this.limit);
  }
  snapshot(): FeedbackEvent[] {
    this.prune(this.now());
    // Leave room for the JPEG and a full Unicode note under the API body cap.
    let bytes = 0;
    const kept: FeedbackEvent[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      bytes += new TextEncoder().encode(JSON.stringify(this.events[i])).length;
      if (bytes > 60_000) break;
      kept.push(this.events[i]);
    }
    return JSON.parse(JSON.stringify(kept.reverse()));
  }
  clear() { this.events = []; }
}
