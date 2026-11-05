import { connect as netConnect } from 'node:net';

/** Greeting each Docker test server sends once it is really serving (Docker's port proxy accepts TCP before that). */
const GREETINGS: Record<number, string> = { 2222: 'SSH-', 2121: '220', 2122: '220' };

const probe = (port: number, greeting: string | undefined) =>
  new Promise<boolean>((resolve) => {
    const s = netConnect(port, '127.0.0.1');
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(2000, () => done(false));
    s.once('error', () => done(false));
    s.once('connect', () => {
      if (!greeting) done(true);
    });
    s.once('data', (d) => done(!!greeting && d.toString('latin1').startsWith(greeting)));
    s.once('close', () => done(false));
  });

/** Resolves when the test server on `port` accepts connections and has sent its greeting. */
export const waitForServer = async (port: number, timeoutMs = 60_000): Promise<void> => {
  const start = Date.now();
  while (!(await probe(port, GREETINGS[port]))) {
    if (Date.now() - start > timeoutMs) throw new Error(`server on port ${port} not ready`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
