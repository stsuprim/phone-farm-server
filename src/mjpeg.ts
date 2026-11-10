import http from 'node:http';

/** Incremental parser for a multipart MJPEG stream (WDA sends Content-Length per part). */
export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onFrame: (jpeg: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const he = this.buf.indexOf('\r\n\r\n');
      if (he < 0) break;
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, he).toString('latin1'));
      if (!m) {
        this.buf = this.buf.subarray(he + 4);
        continue;
      }
      const start = he + 4;
      const end = start + Number(m[1]);
      if (this.buf.length < end) break;
      this.onFrame(Buffer.from(this.buf.subarray(start, end)));
      this.buf = this.buf.subarray(end);
    }
    if (this.buf.length > 20_000_000) this.buf = Buffer.alloc(0); // runaway guard
  }
}

/** Shared upstream connection to a WDA MJPEG port; reconnects while anyone is subscribed. */
export class MjpegSource {
  private subs = new Set<(f: Buffer) => void>();
  private req?: http.ClientRequest;
  private retry?: NodeJS.Timeout;
  constructor(private port: () => number) {}

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
    const parser = new MjpegParser((f) => {
      for (const cb of this.subs) cb(f);
    });
    const req = http.get({ host: '127.0.0.1', port: this.port(), path: '/' }, (res) => {
      res.on('data', (c: Buffer) => parser.push(c));
      res.on('end', () => this.reconnect());
      res.on('error', () => this.reconnect());
    });
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
      }, 1000);
    }
  }

  private stop(): void {
    this.req?.destroy();
    this.req = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }
}
