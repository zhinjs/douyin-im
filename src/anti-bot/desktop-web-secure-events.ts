/** Browser-safe dt semantics: snapshot delivery, no Node special treatment of error events. */
export class DesktopWebSecureEvents<Events extends Record<string, unknown> = Record<string, unknown>> {
  private readonly events: Record<string, Array<(event: unknown) => void>> = {};
  on<K extends keyof Events & string>(name: K, listener: (event: Events[K]) => void): void {
    (this.events[name] ||= []).push(listener as (event: unknown) => void);
  }
  off<K extends keyof Events & string>(name: K, listener?: (event: Events[K]) => void): void {
    const listeners = this.events[name];
    if (listeners) for (let i = listeners.length; i >= 0; i--) if (!listener || listeners[i] === listener) listeners.splice(i, 1);
  }
  emit<K extends keyof Events & string>(name: K, event: Events[K]): void { this.events[name]?.slice().forEach(listener => listener(event)); }
  has<K extends keyof Events & string>(name: K, listener?: (event: Events[K]) => void): boolean {
    return !!this.events[name] && (typeof listener !== 'function' || this.events[name]!.indexOf(listener as (event: unknown) => void) !== -1);
  }
}
