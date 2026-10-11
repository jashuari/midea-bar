/**
 * A pretend Midea air conditioner (LAN protocol V2) for tests and for trying
 * the app without a real unit:
 *
 *   npm run fake-ac            # listens on 127.0.0.1:6444
 *   MIDEABAR_CONFIG=/tmp/demo.json npm run cli -- scan 127.0.0.1
 *
 * It answers discovery plus the three requests the app sends: capabilities,
 * read state, set state. The byte layouts mirror the parser in midea-local, so this proves
 * the app's wiring — not that a given real unit speaks the same dialect.
 */
import dgram from "node:dgram";
import net from "node:net";
import { calculateCrc8, Frame, Packet, Security } from "midea-local";

const DEVICE_TYPE_AC = 0xac;
const FRAME_CONTROL = 0x02;
const FRAME_QUERY = 0x03;

export interface FakeState {
  power: boolean;
  target: number;
  mode: number;
  fan: number;
  swing: number;
  eco: boolean;
  turbo: boolean;
  sleep: boolean;
  indoor: number;
  outdoor: number;
  display: boolean;
  selfClean: boolean;
  filter: boolean;
}

export interface FakeAc {
  port: number;
  id: number;
  state: FakeState;
  /**
   * Misbehaviours real units have: ignoring half degrees, never answering the
   * energy request, or answering it without listing energy as a capability.
   */
  quirks: { wholeDegrees: boolean; energySilent: boolean; energyUnlisted: boolean };
  /** Raw set-state payloads received, newest last. */
  received: Buffer[];
  close(): Promise<void>;
}

function frame(type: number, payload: number[]): Buffer {
  const body = Uint8Array.from([...payload, 0]);
  body[body.length - 1] = calculateCrc8(body.subarray(0, body.length - 1));
  return Buffer.from(new Frame(DEVICE_TYPE_AC, type as never).toBytes(body));
}

function stateFrame(type: number, s: FakeState): Buffer {
  const whole = Math.trunc(s.indoor);
  const tenths = Math.round((s.indoor - whole) * 10);
  return frame(type, [
    0xc0,
    s.power ? 0x01 : 0x00,
    ((s.mode & 0x07) << 5) | (Number.isInteger(s.target) ? 0 : 0x10) | ((Math.trunc(s.target) - 16) & 0x0f),
    s.fan & 0x7f,
    0x7f, 0x7f, 0x00,
    0x30 | (s.swing & 0x0f),
    s.turbo ? 0x20 : 0x00,
    s.eco ? 0x10 : 0x00,
    s.sleep ? 0x01 : 0x00,
    whole * 2 + 50,
    Math.trunc(s.outdoor) * 2 + 50,
    s.filter ? 0x20 : 0x00,
    s.display ? 0x00 : 0x70,
    tenths & 0x0f,
    0x00, // error code
    0x00, 0x00,
    0x28, // target humidity
    0x00, 0x00,
  ]);
}

/** The reply a V2 unit gives to a discovery packet: its ID in the clear, the rest AES-encrypted. */
function discoveryReply(id: number, port: number): Buffer {
  const header = Buffer.alloc(40);
  header[0] = 0x5a;
  header[1] = 0x5a;
  header.writeUIntLE(id, 20, 6);

  const name = `net_ac_${id.toString(16).slice(-4).toUpperCase()}`;
  const info = Buffer.alloc(41 + name.length);
  info.set([1, 0, 0, 127], 0); // 127.0.0.1, little-endian
  info.writeUInt16LE(port, 4);
  info.write("000000P0000000Q1FAKE000000000000", 8, "ascii");
  info[40] = name.length;
  info.write(name, 41, "ascii");

  return Buffer.concat([header, Security.encryptAes(info), Buffer.alloc(16)]);
}

export function startFakeAc(
  port = 6444,
  id = 0x0000_1234_5678,
  discoveryPort?: number,
  /** Announce as a V3 unit (the kind that needs a cloud-issued key). The fake cannot complete a V3 handshake. */
  announceV3 = false,
): Promise<FakeAc> {
  const state: FakeState = {
    power: false, target: 24, mode: 2, fan: 102, swing: 0,
    eco: false, turbo: false, sleep: false, indoor: 26.4, outdoor: 31,
    display: true, selfClean: false, filter: false,
  };
  const quirks = { wholeDegrees: false, energySilent: false, energyUnlisted: false };
  const selfCleanProp = () => [0x39, 0x00, 0x00, 0x01, state.selfClean ? 1 : 0];
  const received: Buffer[] = [];

  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (data) => {
      let request: Buffer;
      try {
        request = Packet.decode(data);
      } catch {
        return;
      }
      const type = request[9]!;
      const p = request.subarray(10, request.length - 1);
      let reply: Buffer | null = null;

      if (type === FRAME_QUERY && p[0] === 0xb5) {
        // Heat pump with eco + turbo, four fan speeds, swing in both directions.
        const cap = (id: number, value: number) => [id & 0xff, id >> 8, 1, value];
        // …plus display light control, energy figures and self-clean.
        const caps = [
          cap(0x0214, 1), cap(0x0215, 1), cap(0x0210, 5), cap(0x0212, 1), cap(0x021a, 1),
          cap(0x0224, 1), ...(quirks.energyUnlisted ? [] : [cap(0x0216, 2)]), cap(0x0039, 1),
        ];
        reply = frame(FRAME_QUERY, [0xb5, caps.length, ...caps.flat()]);
      } else if (type === FRAME_QUERY && p[0] === 0x41 && p[1] === 0x21 && p[3] === 0x44) {
        // Energy: 1234.56 kWh in total, 432.1 W right now, binary-coded decimal.
        if (!quirks.energySilent) {
          reply = frame(FRAME_QUERY, [
            0xc1, 0x21, 0x01, 0x44,
            0x00, 0x12, 0x34, 0x56,
            0, 0, 0, 0,
            0x00, 0x00, 0x01, 0x50,
            0x00, 0x43, 0x21,
            0,
          ]);
        }
      } else if (type === FRAME_QUERY && p[0] === 0x41 && p[4] === 0x02) {
        if (state.power) state.display = !state.display;
        reply = stateFrame(FRAME_QUERY, state);
      } else if (type === FRAME_QUERY && p[0] === 0x41) {
        reply = stateFrame(FRAME_QUERY, state);
      } else if (type === FRAME_QUERY && p[0] === 0xb1) {
        reply = frame(FRAME_QUERY, [0xb1, 1, ...selfCleanProp()]);
      } else if (type === FRAME_CONTROL && p[0] === 0xb0) {
        for (let i = 2, n = 0; n < p[1]!; n++) {
          const id = p[i]! | (p[i + 1]! << 8);
          const size = p[i + 2]!;
          if (id === 0x0039) state.selfClean = Boolean(p[i + 3]);
          i += 3 + size;
        }
        reply = frame(FRAME_CONTROL, [0xb0, 1, ...selfCleanProp()]);
      } else if (type === FRAME_CONTROL && p[0] === 0x40) {
        received.push(Buffer.from(p));
        state.power = Boolean(p[1]! & 0x01);
        state.target = (p[2]! & 0x0f) + 16 + (p[2]! & 0x10 && !quirks.wholeDegrees ? 0.5 : 0);
        state.mode = (p[2]! >> 5) & 0x07;
        state.fan = p[3]!;
        state.swing = p[7]! & 0x0f;
        state.turbo = Boolean(p[8]! & 0x20);
        state.eco = Boolean(p[9]! & 0x80);
        state.sleep = Boolean(p[10]! & 0x01);
        reply = stateFrame(FRAME_CONTROL, state);
      }

      if (reply) socket.write(Packet.encode(id, reply));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as net.AddressInfo).port;

      let udp: dgram.Socket | null = null;
      if (discoveryPort) {
        udp = dgram.createSocket("udp4");
        udp.on("error", () => {});
        udp.on("message", (_msg, from) => {
          const v2 = discoveryReply(id, actual);
          const reply = announceV3
            ? Buffer.concat([Buffer.from([0x83, 0x70, 0, 0, 0, 0, 0, 0]), v2, Buffer.alloc(16)])
            : v2;
          udp?.send(reply, from.port, from.address);
        });
        udp.bind(discoveryPort, "127.0.0.1");
      }

      resolve({
        port: actual,
        id,
        state,
        quirks,
        received,
        close: () =>
          new Promise<void>((done) => {
            udp?.close();
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
}

if (process.argv[1]?.endsWith("fake-ac.ts")) {
  void startFakeAc(Number(process.env.PORT ?? 6444), undefined, 6445).then((ac) =>
    console.log(`Fake AC ${ac.id} listening on 127.0.0.1:${ac.port}`),
  );
}
