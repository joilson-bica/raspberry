import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeConfig, fakeLogger, loadSource } from "./fakes.js";

const receipt = { acquirerTransactionKey: "fake-atk", amount: 10, transactionType: 2 };
const payment = { amount: 10, method: "credit" };

async function client(fetch, config = fakeConfig()) {
  return loadSource("autotef.js", { config, log: fakeLogger(), fetch });
}

for (const enveloped of [false, true]) {
  for (const reading of [undefined, 8, "EMVProximityReader", "EMVContactReader", "Contactless", "MagneticStripe"]) {
    test(`valid ${enveloped ? "enveloped" : "flat"} receipt with reading ${reading}`, async () => {
      const raw = { ...receipt, cardReadingType: reading, totalNumberOfPayments: 0 };
      const api = await client(async () => new Response(JSON.stringify(enveloped
        ? { receipt: raw, card: { maskedPrimaryAccountNumber: "fake-card-mask" } } : raw)));
      const normalized = await api.pay(payment);
      assert.equal(normalized.acquirerTransactionKey, "fake-atk");
      assert.equal(normalized.installments, 1);
      assert.equal(normalized.cardReadingType, typeof reading !== "string" ? null
        : reading.includes("Proximity") || reading === "Contactless" ? "nfc"
          : reading === "EMVContactReader" ? "chip" : "magnetic");
      assert.equal(normalized.cardPanMask, enveloped ? "fake-card-mask" : null);
    });
  }
}

for (const body of ["", "not-json", "null", "{}", "[]", '{"responseCode":"G004"}',
  '{"receipt":{}}', '{"receipt":{"acquirerTransactionKey":" "}}',
  '{"acquirerTransactionKey":123}', '{"receipt":"invalid"}']) {
  test(`2xx without valid receipt is uncertain: ${body}`, async () => {
    const api = await client(async () => new Response(body));
    await assert.rejects(api.pay(payment), { code: "AGENT_RESULT_UNKNOWN" });
  });
}

test("missing installments defaults to one; valid installments and selective string reading are preserved", async () => {
  let raw = { ...receipt, cardReadingType: "OtherReader" };
  const api = await client(async () => new Response(JSON.stringify(raw)));
  assert.equal((await api.pay(payment)).installments, 1);
  raw.totalNumberOfPayments = 3;
  const result = await api.pay(payment);
  assert.equal(result.installments, 3);
  assert.equal(result.cardReadingType, "OtherReader");
});

test("body transport failure is AGENT_UNREACHABLE", async () => {
  const api = await client(async () => ({ ok: true, status: 200,
    text: async () => { throw new Error("connection reset while reading"); } }));
  await assert.rejects(api.pay(payment), { code: "AGENT_UNREACHABLE" });
});

test("the request timeout covers deferred body reading", async () => {
  const api = await client(async (_url, { signal }) => ({ ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) }));
  const keepAlive = setTimeout(() => {}, 200);
  try { await assert.rejects(api.pay(payment), { code: "AGENT_UNREACHABLE" }); }
  finally { clearTimeout(keepAlive); }
});

test("network timeout is uncertain; HTTP rejection retains Slim code", async () => {
  const offline = await client(async () => { throw new Error("offline"); });
  await assert.rejects(offline.pay(payment), { code: "AGENT_UNREACHABLE" });
  const declined = await client(async () => new Response('{"responseCode":"G004","responseReason":"cancelled"}', { status: 400 }));
  await assert.rejects(declined.pay(payment), { code: "G004" });
});

test("self-service cancellation still accepts empty 200 without extra requests", async () => {
  const paths = [];
  const api = await client(async (url) => { paths.push(url); return new Response(""); });
  assert.deepEqual(await api.cancel({ acquirerTransactionKey: "fake-atk", amount: 10 }), { cancelled: true });
  assert.deepEqual(paths, ["http://slim.invalid/api/Cancel/"]);
});
