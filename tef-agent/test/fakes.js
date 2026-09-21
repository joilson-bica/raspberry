import { readFile } from "node:fs/promises";

let sequence = 0;

export const fakeConfig = () => ({
  backendUrl: "http://backend.invalid", autotefUrl: "http://slim.invalid",
  agentId: "fake-agent", laundryId: "fake-laundry", agentToken: "fake-secret-token",
  stoneCode: "fake-stone", partnerName: "fake-partner", connectionName: "fake-port",
  isPdv: false, resultCacheSize: 50, heartbeatMs: 60000,
  healthcheckMode: "lazy", healthcheckMinGapMs: 60000, healthcheckMinIntervalMs: 600000,
  timeouts: { quick: 30, transaction: 30 },
});

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fakeLogger() {
  const lines = [];
  return { lines, ...Object.fromEntries(["debug", "info", "warn", "error"].map(
    (level) => [level, (...args) => lines.push(args.join(" "))]
  )) };
}

export async function loadSource(file, deps) {
  const key = `__tefTest${++sequence}`;
  globalThis[key] = deps;
  let source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
  const bindings = {
    'import { config } from "./config.js";': "config",
    'import { log } from "./logger.js";': "log",
    'import { io } from "socket.io-client";': "io",
    'import * as autotef from "./autotef.js";': "autotef",
  };
  for (const [statement, name] of Object.entries(bindings)) {
    source = source.replace(statement, `const ${name} = globalThis[${JSON.stringify(key)}].${name};`);
  }
  if (deps.fetch) source = `const fetch = globalThis[${JSON.stringify(key)}].fetch;\n${source}`;
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  } finally {
    delete globalThis[key];
  }
}

export class FakeSocket {
  handlers = new Map();
  events = [];
  connected = true;
  on(name, handler) { this.handlers.set(name, handler); }
  emit(name, payload) { this.events.push({ name, payload }); }
  close() { this.connected = false; }
  send(name, payload, ack) { return this.handlers.get(name)(payload, ack); }
  async request(name, payload) {
    let result;
    await this.send(name, payload, (value) => { result = value; });
    return result;
  }
}
