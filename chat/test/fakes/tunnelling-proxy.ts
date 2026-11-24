import { connect, createServer, type Server, type Socket } from 'node:net';

/** A forward proxy that records the host of each request it carries: a CONNECT's tunnel, or a plain request in absolute form. */
export class TunnellingProxy {
  readonly targets: string[] = [];
  private readonly server: Server = createServer((socket) => this.serve(socket));

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private readonly sockets = new Set<Socket>();

  private serve(client: Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    client.once('data', (head: Buffer) => {
      const [method = '', target = ''] = head.toString('latin1').split(' ');
      const tunnel = method === 'CONNECT';
      const host = tunnel ? target : new URL(target).host;
      this.targets.push(host);
      const [hostname = '', port = ''] = host.split(':');
      const upstream = connect(Number(port), hostname, () => {
        if (tunnel) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
    });
  }
}
