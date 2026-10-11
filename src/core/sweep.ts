import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { DISCOVERY_MSG } from "midea-local";

const DISCOVERY_PORT = 6445;

/** Every host address on the /24 around each of this machine's private IPv4 addresses. */
export function localHosts(): string[] {
  const hosts = new Set<string>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const p = a.address.split(".").map(Number);
      const isPrivate =
        p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31);
      if (!isPrivate) continue;
      for (let i = 1; i < 255; i++) {
        const host = `${p[0]}.${p[1]}.${p[2]}.${i}`;
        if (host !== a.address) hosts.add(host);
      }
    }
  }
  return [...hosts];
}

/**
 * Ask every host on the local /24 directly whether it is a Midea device.
 *
 * Broadcast discovery is the normal path. This is the fallback for networks
 * where broadcast never reaches the unit — a VPN that owns the default route,
 * or a router that drops broadcast between Wi-Fi bands.
 *
 * @returns IPs that answered.
 */
export function sweep(timeoutMs = 2500, hosts: string[] = localHosts()): Promise<string[]> {
  return new Promise((resolve) => {
    if (hosts.length === 0) return resolve([]);
    const found = new Set<string>();
    const socket = dgram.createSocket("udp4");
    const msg = Buffer.from(DISCOVERY_MSG);
    const finish = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found]);
    };
    socket.on("error", finish);
    socket.on("message", (_data, rinfo) => found.add(rinfo.address));
    socket.bind(0, "0.0.0.0", () => {
      // Errors on individual sends (host down, no route) are expected and ignored.
      for (const host of hosts) socket.send(msg, DISCOVERY_PORT, host, () => {});
      setTimeout(finish, timeoutMs);
    });
  });
}
