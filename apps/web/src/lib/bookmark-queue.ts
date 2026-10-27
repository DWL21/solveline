/** 같은 문제의 변경을 모으고, 전송 중 바뀐 값은 앞선 요청이 끝난 뒤 보낸다. */
type Entry = { desired: boolean; version: number; timer: ReturnType<typeof setTimeout> | null; ready: boolean; running: boolean; fail: () => void };
export class BookmarkQueue {
  private entries = new Map<string, Entry>();
  private send: (owner: string, id: string, value: boolean) => Promise<unknown>;
  private delay: number;
  constructor(send: (owner: string, id: string, value: boolean) => Promise<unknown>, delay = 500) {
    this.send = send;
    this.delay = delay;
  }

  set(owner: string, id: string, value: boolean, fail: () => void) {
    const key = JSON.stringify([owner, id]);
    const entry = this.entries.get(key) ?? { desired: value, version: 0, timer: null, ready: false, running: false, fail };
    entry.desired = value;
    entry.version++;
    entry.fail = fail;
    entry.ready = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.ready = true;
      void this.flush(owner, id, key, entry);
    }, this.delay);
    this.entries.set(key, entry);
  }

  private async flush(owner: string, id: string, key: string, entry: Entry) {
    if (entry.running || !entry.ready) return;
    entry.running = true;
    entry.ready = false;
    const version = entry.version;
    try {
      await this.send(owner, id, entry.desired);
    } catch {
      if (version === entry.version) {
        this.entries.delete(key);
        entry.fail();
        return;
      }
    } finally {
      entry.running = false;
    }
    if (version === entry.version) this.entries.delete(key);
    else if (entry.ready) void this.flush(owner, id, key, entry);
  }
}
