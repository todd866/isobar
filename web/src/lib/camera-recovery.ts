/** Local interaction intent only: travel settles north, deliberate looking stays put. */
export class CameraRecovery {
  private start = Infinity;
  private bearing = 0;
  cancel(): void { this.start = Infinity; }
  travel(now: number, bearing: number): void {
    this.bearing = Math.atan2(Math.sin(bearing), Math.cos(bearing));
    this.start = Math.abs(this.bearing) > .001 ? now + 450 : Infinity;
  }
  sample(now: number, busy: boolean, reducedMotion = false): number | null {
    if (!Number.isFinite(this.start)) return null;
    if (busy) { this.start = now + 450; return null; }
    if (now < this.start) return null;
    const t = reducedMotion ? 1 : Math.min(1, (now-this.start)/600);
    const bearing = this.bearing * (1-t*t*(3-2*t));
    if (t === 1) this.cancel();
    return t === 1 ? 0 : bearing;
  }
}
