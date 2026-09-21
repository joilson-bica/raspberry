import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fakeConfig, fakeLogger, FakeSocket, loadSource } from "./fakes.js";

const pay = { requestId: "req-pay", paymentId: "payment-1", amount: 10, method: "credit" };
const cancel = { requestId: "req-cancel", paymentId: "payment-1", amount: 10, acquirerTransactionKey: "secret-atk" };

async function fixture(t, overrides = {}) {
  const socket = new FakeSocket();
  const log = fakeLogger();
  const config = fakeConfig();
  const api = await loadSource("autotef.js", { config, log,
    fetch: async () => { throw new Error("Unexpected HTTP"); } });
  const calls = [];
  const autotef = { ...api, ...Object.fromEntries(
    ["pay", "cancel", "healthcheck", "pinpadMessage"].map((name) => [name, async (...args) => {
      calls.push(name);
      if (overrides[name]) return overrides[name](...args);
      return name === "pay" ? { acquirerTransactionKey: "secret-atk", panMask: "secret-pan" }
        : name === "healthcheck" ? { stoneCode: "fake-stone" } : { ok: true };
    }])
  ) };
  const { createAgent } = await loadSource("agent.js", { config, log, autotef, io: () => socket });
  const agent = createAgent();
  t.after(() => agent.stop());
  return { socket, calls, log, api };
}

function correlated(result, payload) {
  assert.equal(result.requestId, payload?.requestId ?? null);
  assert.equal(result.paymentId, payload?.paymentId ?? null);
}

for (const [owner, operation, payload] of [
  ["pay", "tef.pay", pay], ["cancel", "tef.cancel", cancel],
  ["healthcheck", "tef.healthcheck", { force: true }],
  ["pinpadMessage", "tef.pinpad.message", { message: "hello" }],
]) {
  test(`${owner} reserves serial before awaiting; every competing operation stays off Slim`, async (t) => {
    const pending = deferred();
    const f = await fixture(t, { [owner]: () => pending.promise });
    const first = f.socket.request(operation, payload);
    t.after(() => pending.resolve({ ok: true }));
    assert.deepEqual(f.calls, [owner]);
    assert.equal(f.socket.events.filter((e) => e.name === "tef.status").at(-1)?.payload.busy, true);
    const secondPay = { ...pay, requestId: "req-second", paymentId: "payment-second" };
    const secondCancel = { ...cancel, requestId: "cancel-second" };
    for (const [event, data] of [["tef.pay", secondPay], ["tef.cancel", secondCancel],
      ["tef.pinpad.message", { requestId: "message", paymentId: "payment-1", message: "Operacao cancelada" }]]) {
      const result = await f.socket.request(event, data);
      assert.equal(result.error?.code, "AGENT_BUSY");
      correlated(result, data);
    }
    const health = await f.socket.request("tef.healthcheck", { force: true });
    assert.equal(health.busy, true);
    assert.equal(health.cached, true);
    await f.socket.send("connect");
    assert.deepEqual(f.calls, [owner]);
    pending.resolve(owner === "pay" ? { acquirerTransactionKey: "fake-atk" } : { ok: true });
    await first;
    await Promise.resolve();
    assert.deepEqual(f.calls, [owner]);
    assert.equal(f.socket.events.filter((e) => e.name === "tef.status").at(-1).payload.busy, false);
    const next = await f.socket.request("tef.pay", { ...pay, requestId: "next" });
    assert.equal(next.ok, true);
  });
}

test("all transaction results correlate ACK and event, including invalid and cached requests", async (t) => {
  const f = await fixture(t);
  for (const [event, data] of [["tef.pay", undefined], ["tef.pay", { ...pay, amount: 0 }],
    ["tef.cancel", { requestId: "invalid-cancel", paymentId: "payment-2" }],
    ["tef.pay", { ...pay, requestId: "success" }],
    ["tef.pay", { ...pay, requestId: "success", paymentId: "resent-payment" }]]) {
    const result = await f.socket.request(event, data);
    correlated(result, data);
    assert.deepEqual(f.socket.events.filter((e) => e.name === "tef.result").at(-1).payload, result);
  }
  assert.equal(f.calls.filter((c) => c === "pay").length, 1);
});

test("uncertain pay retains IDs/cache, releases serial and suppresses late cosmetic messages", async (t) => {
  let failure;
  const f = await fixture(t, { pay: async () => { throw failure; } });
  failure = new f.api.AutotefUnreachableError(new Error("secret-pan secret-atk secret-token"));
  const result = await f.socket.request("tef.pay", pay);
  assert.equal(result.error.code, "AGENT_UNREACHABLE");
  correlated(result, pay);
  assert.deepEqual(f.socket.events.filter((e) => e.name === "tef.result").at(-1).payload, result);
  const replay = await f.socket.request("tef.pay", pay);
  assert.deepEqual(replay, result);
  assert.equal(f.calls.length, 1);
  const message = await f.socket.request("tef.pinpad.message", { message: "Operacao cancelada" });
  assert.equal(message.error?.code, "AGENT_RESULT_UNKNOWN");
  await f.socket.request("tef.healthcheck", { force: true });
  await f.socket.request("tef.pinpad.message", { message: "Operacao cancelada" });
  assert.ok(!f.calls.includes("pinpadMessage"));
  assert.equal(f.socket.events.filter((e) => e.name === "tef.status").at(-1).payload.busy, true);
  assert.match(f.log.lines.join("\n"), /requestId.*req-pay.*paymentId.*payment-1.*AGENT_UNREACHABLE/);
  assert.doesNotMatch(f.log.lines.join("\n"), /secret-pan|secret-atk|secret-token/);
});

test("2xx invalid payment blocks cosmetics with exact uncertain code", async (t) => {
  const f = await fixture(t, { pay: async () => {
    const api = await loadSource("autotef.js", { config: fakeConfig(), log: fakeLogger(),
      fetch: async () => new Response("invalid-json") });
    return api.pay(pay);
  } });
  const result = await f.socket.request("tef.pay", pay);
  assert.equal(result.error.code, "AGENT_RESULT_UNKNOWN");
  correlated(result, pay);
  const message = await f.socket.request("tef.pinpad.message", {});
  assert.equal(message.error?.code, "AGENT_RESULT_UNKNOWN");
  assert.deepEqual(f.calls, ["pay"]);
});

test("nonfunction ACKs never throw and cancel logs never expose ATK", async (t) => {
  const f = await fixture(t);
  await f.socket.send("tef.pay", pay, {});
  await f.socket.send("tef.cancel", cancel, "not-a-function");
  await f.socket.send("tef.pinpad.message", {}, 1);
  await f.socket.send("tef.healthcheck", {}, {});
  assert.doesNotMatch(f.log.lines.join("\n"), /secret-atk|secret-pan|fake-secret-token/);
});

for (const operation of ["healthcheck", "pinpadMessage"]) {
  test(`${operation} failure always frees the serial lock`, async (t) => {
    const f = await fixture(t, { [operation]: async () => { throw new Error("fake failure"); } });
    const result = await f.socket.request(operation === "healthcheck" ? "tef.healthcheck"
      : operation === "cancel" ? "tef.cancel" : "tef.pinpad.message", { ...cancel, force: true });
    correlated(result, cancel);
    assert.equal(result.ok, false);
    assert.equal((await f.socket.request("tef.pay", pay)).ok, true);
    assert.equal(f.socket.events.filter((e) => e.name === "tef.status").at(-1).payload.busy, false);
  });
}

test("a definitive Slim rejection is correlated and releases the lock without automatic reversal", async (t) => {
  let failure;
  const f = await fixture(t, { pay: async () => { throw failure; } });
  failure = new f.api.AutotefError(400, { responseCode: "G004", responseReason: "fake refusal" });
  const result = await f.socket.request("tef.pay", pay);
  correlated(result, pay);
  assert.equal(result.error.code, "G004");
  assert.deepEqual(f.socket.events.filter((e) => e.name === "tef.result").at(-1).payload, result);
  assert.deepEqual(await f.socket.request("tef.pay", pay), result);
  assert.deepEqual(f.calls, ["pay"]);
  assert.equal((await f.socket.request("tef.pinpad.message", {})).ok, true);
  assert.deepEqual(f.calls, ["pay", "pinpadMessage"]);
});

for (const operation of ["pay", "cancel"]) {
  for (const code of ["AGENT_UNREACHABLE", "AGENT_RESULT_UNKNOWN", "AGENT_ERROR"]) {
    test(`${operation} ${code} quarantines new transactions, keeps cache and remains unavailable`, async (t) => {
      let failure;
      const f = await fixture(t, { [operation]: async () => { if (failure) throw failure; return { acquirerTransactionKey: "fake-atk" }; } });
      await f.socket.request("tef.healthcheck", {});
      const previousPayload = { ...pay, requestId: "previous-success" };
      const previous = await f.socket.request("tef.pay", previousPayload);
      assert.equal(previous.ok, true);
      failure = code === "AGENT_UNREACHABLE" ? new f.api.AutotefUnreachableError(new Error("fake failure"))
        : code === "AGENT_RESULT_UNKNOWN" ? new f.api.AutotefResultUnknownError() : new Error("unexpected parser error");
      const originalPayload = operation === "pay" ? pay : cancel;
      const original = await f.socket.request(`tef.${operation}`, originalPayload);
      assert.equal(original.error.code, code);
      correlated(original, originalPayload);
      const callsBefore = [...f.calls];
      const assertUnavailable = () => {
        const status = f.socket.events.filter((e) => e.name === "tef.status").at(-1).payload;
        assert.equal(status.activated, false);
        assert.equal(status.busy, true);
      };
      assertUnavailable();
      assert.deepEqual(await f.socket.request(`tef.${operation}`, originalPayload), original);
      assert.deepEqual(await f.socket.request("tef.pay", previousPayload), previous);
      assertUnavailable();
      for (const [event, data] of [["tef.pay", { ...pay, requestId: "new-pay", paymentId: "new-payment" }],
        ["tef.cancel", { ...cancel, requestId: "new-cancel", paymentId: "other-payment" }]]) {
        const result = await f.socket.request(event, data);
        assert.equal(result.error.code, "AGENT_RESULT_UNKNOWN");
        correlated(result, data);
        assert.deepEqual(f.socket.events.filter((e) => e.name === "tef.result").at(-1).payload, result);
      }
      const now = Date.now;
      Date.now = () => now() + 24 * 60 * 60 * 1000;
      try {
        await f.socket.send("connect");
        await Promise.resolve();
        const health = await f.socket.request("tef.healthcheck", { force: true });
        assert.equal(health.busy, true);
        assert.equal(health.ok, false);
        assert.equal(health.cached, true);
        assert.equal((await f.socket.request("tef.pinpad.message", {})).error.code, "AGENT_RESULT_UNKNOWN");
        assert.equal((await f.socket.request("tef.pay", { ...pay, requestId: "later" })).error.code, "AGENT_RESULT_UNKNOWN");
        assertUnavailable();
        assert.deepEqual(f.calls, callsBefore);
      } finally {
        Date.now = now;
      }
    });
  }
}

test("cached success cannot be reassigned to a different payment or transaction operation", async (t) => {
  const f = await fixture(t);
  const original = await f.socket.request("tef.pay", pay);
  for (const [event, data] of [["tef.pay", { ...pay, paymentId: "other-payment" }],
    ["tef.cancel", { ...cancel, requestId: pay.requestId }]]) {
    const result = await f.socket.request(event, data);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "BAD_REQUEST");
    correlated(result, data);
    assert.deepEqual(f.socket.events.filter((e) => e.name === "tef.result").at(-1).payload, result);
  }
  assert.deepEqual(await f.socket.request("tef.pay", pay), original);
  assert.deepEqual(f.calls, ["pay"]);
});

test("transaction IDs must both be nonempty strings before accessing Slim or cache", async (t) => {
  const f = await fixture(t);
  for (const [event, payload] of [["tef.pay", pay], ["tef.cancel", cancel]]) {
    for (const field of ["requestId", "paymentId"]) {
      for (const value of [undefined, null, "", "  ", 123, {}]) {
        const data = { ...payload, [field]: value };
        const result = await f.socket.request(event, data);
        assert.equal(result.error.code, "BAD_REQUEST");
        correlated(result, data);
      }
    }
  }
  assert.deepEqual(f.calls, []);
});

test("socket failures retain useful safe categories without logging raw errors or tokens", async (t) => {
  const f = await fixture(t);
  await f.socket.send("connect_error", { message: "websocket error token=fake-secret-token", data: "secret-object" });
  await f.socket.send("disconnect", "transport close token=fake-secret-token");
  await f.socket.send("connect_error", new Error("Unauthorized fake-secret-token"));
  await f.socket.send("disconnect", "ping timeout");
  await f.socket.send("connect_error", new Error("unknown fake-secret-token"));
  const lines = f.log.lines.join("\n");
  assert.match(lines, /websocket error/);
  assert.match(lines, /transport close/);
  assert.match(lines, /authentication error/);
  assert.match(lines, /ping timeout/);
  assert.doesNotMatch(lines, /fake-secret-token|secret-object|unknown fake/);
});

test("successful transaction and cached lazy health never eagerly reprobe", async (t) => {
  const f = await fixture(t);
  await f.socket.request("tef.healthcheck", {});
  await f.socket.request("tef.pay", pay);
  await f.socket.send("connect");
  await f.socket.request("tef.healthcheck", { force: true });
  assert.equal(f.calls.filter((c) => c === "healthcheck").length, 1);
});
