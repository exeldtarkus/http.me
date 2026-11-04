// server HTTP lokal untuk test (tanpa internet): port acak di 127.0.0.1
import { createServer, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Reply = { status?: number; headers?: OutgoingHttpHeaders; body?: string | Buffer };
export type Handler = (req: IncomingMessage, body: string) => Promise<Reply>;

export async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      const r = await handler(req, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(r.status ?? 200, r.headers).end(r.body);
    } catch (e) {
      // error di handler test: balas 500 dengan stack supaya terlihat di assertion
      res.writeHead(500).end(e instanceof Error ? e.stack : String(e));
    }
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok, fail) => { srv.closeAllConnections(); srv.close((e) => (e ? fail(e) : ok())); }),
  };
}
