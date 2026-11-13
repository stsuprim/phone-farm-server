import http from 'node:http';
import { RateMeter } from './h264.js';

/**
 * Incremental parser for a multipart MJPEG stream (WDA sends Content-Length per part).
 * Chunks are only joined once a whole frame can be there, so big frames don't cost a copy per TCP chunk.
 */
export class MjpegParser {
  private chunks: Buffer[] = [];
  private len = 0;
  private need = 0; // bytes required before it's worth looking again
  constructor(private onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.len += chunk.length;
    if (this.len < this.need) return;
    this.need = 0;
    const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.len);
    let off = 0;
    for (;;) {
      const he = buf.indexOf('\r\n\r\n', off);
      if (he < 0) break;
      const m = /content-length:\s*(\d+)/i.exec(buf.toString('latin1', off, he));
      if (!m) {
        off = he + 4;
        continue;
      }
      const start = he + 4;
      const end = start + Number(m[1]);
      if (buf.length < end) {
        this.need = end - off;
        break;
      }
      this.onFrame(buf.subarray(start, end));
      off = end;
    }
    const rest = buf.subarray(off);
    this.chunks = rest.length ? [Buffer.from(rest)] : [];
    this.len = rest.length;
    if (this.len > 20_000_000) {
      // runaway guard
      this.chunks = [];
      this.len = 0;
      this.need = 0;
    }
  }
}

/** Shared upstream connection to a WDA MJPEG port; reconnects while anyone is subscribed. */
export class MjpegSource {
  private subs = new Set<(f: Buffer) => void>();
  private req?: http.ClientRequest;
  private retry?: NodeJS.Timeout;
  readonly meter = new RateMeter();
  constructor(private port: () => number) {}

  get viewers(): number {
    return this.subs.size;
  }

  add(cb: (f: Buffer) => void): () => void {
    this.subs.add(cb);
    if (this.subs.size === 1) this.connect();
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size) this.stop();
    };
  }

  private connect(): void {
    if (!this.subs.size) return;
    let port: number;
    try {
      port = this.port();
    } catch {
      return this.reconnect();
    }
    const parser = new MjpegParser((f) => {
      this.meter.tick();
      for (const cb of this.subs) cb(f);
    });
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.on('data', (c: Buffer) => parser.push(c));
      res.on('end', () => this.reconnect());
      res.on('error', () => this.reconnect());
    });
    req.on('socket', (s) => s.setNoDelay(true));
    req.on('error', () => this.reconnect());
    this.req = req;
  }

  private reconnect(): void {
    this.req?.destroy();
    this.req = undefined;
    if (this.subs.size && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.connect();
      }, 500);
    }
  }

  private stop(): void {
    this.req?.destroy();
    this.req = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }
}
