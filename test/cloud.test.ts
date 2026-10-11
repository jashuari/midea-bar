import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Security } from "midea-local";
import { lanKeys, NeedsAccountError } from "../src/core/cloud";

console.debug = () => {};
console.warn = () => {};
console.error = () => {};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const DEVICE_ID = 0x0000_0abc_def0;
const udpid = (order: "LE" | "BE") => {
  const b = Buffer.alloc(6);
  if (order === "LE") b.writeUIntLE(DEVICE_ID, 0, 6);
  else b.writeUIntBE(DEVICE_ID, 0, 6);
  return Security.udpid(b).toString("hex");
};

/** Stand in for Midea's SmartHome API. `tokenReply` decides what getToken answers. */
function fakeCloud(tokenReply: (body: Record<string, string>) => unknown) {
  const calls: { host: string; endpoint: string; body: Record<string, any> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.searchParams.get("alias") ?? url.pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ host: url.host, endpoint, body });
    const data =
      endpoint === "/v1/user/login/id/get"
        ? { code: 0, data: { loginId: "abc123" } }
        : endpoint === "/mj/user/login"
          ? { code: 0, data: { mdata: { accessToken: "session" } } }
          : tokenReply(body);
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("asks SmartHome for the key, naming the unit, in both byte orders", async () => {
  const calls = fakeCloud((body) => ({
    code: 0,
    data: { tokenlist: [{ udpId: body.udpid, token: `t-${body.udpid}`, key: `k-${body.udpid}` }] },
  }));

  const keys = [];
  for await (const k of lanKeys(DEVICE_ID, { account: "me@example.com", password: "hunter2" })) keys.push(k);

  assert.deepEqual(keys, [
    { token: `t-${udpid("LE")}`, key: `k-${udpid("LE")}` },
    { token: `t-${udpid("BE")}`, key: `k-${udpid("BE")}` },
  ]);

  // Only Midea's SmartHome host is contacted.
  assert.deepEqual([...new Set(calls.map((c) => c.host))], ["mp-prod.appsmb.com"]);

  const tokenCalls = calls.filter((c) => c.endpoint === "/v1/iot/secure/getToken");
  assert.equal(tokenCalls.length, 2);
  for (const c of tokenCalls) assert.equal(c.body.applianceCodes, String(DEVICE_ID));

  // The sign-in uses the account given, and the password never travels in the clear.
  assert.equal(calls[0]!.body.loginAccount, "me@example.com");
  assert.ok(!JSON.stringify(calls).includes("hunter2"));
});

test("explains when the account does not own the unit", async () => {
  fakeCloud(() => ({ code: 3201, msg: "You have no permissions" }));
  await assert.rejects(
    async () => {
      for await (const _ of lanKeys(DEVICE_ID, { account: "me@example.com", password: "x" })) void _;
    },
    (e: unknown) => e instanceof NeedsAccountError && /does not own this air conditioner/.test(e.message),
  );
});

test("explains a rejected sign-in", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 3102, msg: "this account does not exist" }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    async () => {
      for await (const _ of lanKeys(DEVICE_ID, { account: "nobody@example.com", password: "x" })) void _;
    },
    (e: unknown) => e instanceof NeedsAccountError && /no SmartHome account with that email/.test(e.message),
  );
});

test("explains when the cloud cannot be reached", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(
    async () => {
      for await (const _ of lanKeys(DEVICE_ID, { account: "me@example.com", password: "x" })) void _;
    },
    (e: unknown) => e instanceof Error && !(e instanceof NeedsAccountError) && /Could not reach Midea/.test(e.message),
  );
});
