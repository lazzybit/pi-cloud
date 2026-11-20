import net, { type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import ipaddr from "ipaddr.js";
// Read exactly the handshake, leaving application payload queued for pipe().
async function read(s: Socket, n: number): Promise<Buffer> {
  while (!s.destroyed) {
    const b = s.read(n) as Buffer | null;
    if (b) return b;
    await new Promise<void>((ok, fail) => {
      const done = () => {
        s.off("readable", ready);
        s.off("close", close);
      };
      const ready = () => {
        done();
        ok();
      };
      const close = () => {
        done();
        fail(Error("closed"));
      };
      s.once("readable", ready);
      s.once("close", close);
    });
  }
  throw Error("closed");
}
export async function webProxy() {
  const dir = await mkdtemp(
    (process.env.PI_SOCKET_DIR ?? tmpdir()) + "/pi-egress-",
  );
  const path = dir + "/out.sock";
  let active = 0;
  const server = net.createServer(async (socket) => {
    if (active >= 16) {
      socket.destroy();
      return;
    }
    active++;
    let remote: Socket | undefined;
    const timer = setTimeout(() => socket.destroy(), 30000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      remote?.destroy();
      active--;
    });
    try {
      const [v, n] = await read(socket, 2);
      if (v !== 5 || !n || !(await read(socket, n)).includes(0)) throw Error();
      socket.write(Buffer.from([5, 0]));
      const [ver, cmd, rsv, kind] = await read(socket, 4);
      if (ver !== 5 || cmd !== 1 || rsv !== 0) throw Error();
      const host =
        kind === 1
          ? [...(await read(socket, 4))].join(".")
          : kind === 3
            ? (await read(socket, (await read(socket, 1))[0] || 1))
                .toString("latin1")
                .replace(/\.$/, "")
            : "";
      const port = (await read(socket, 2)).readUInt16BE();
      if (
        ![80, 443].includes(port) ||
        !host.includes(".") ||
        !/^[a-zA-Z0-9.-]+$/.test(host)
      )
        throw Error();
      const ips = await lookup(host + ".", { family: 4, all: true });
      if (
        !ips.length ||
        ips.some(({ address }) => ipaddr.parse(address).range() !== "unicast")
      )
        throw Error();
      if (socket.destroyed) return;
      remote = net.connect({ host: ips[0].address, family: 4, port });
      remote.on("error", () => socket.destroy());
      await once(remote, "connect");
      socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      remote.on("close", () => socket.destroy());
      remote.pipe(socket);
      socket.pipe(remote);
    } catch {
      remote?.destroy();
      socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
    }
  });
  server.listen(path);
  await once(server, "listening");
  return path;
}
