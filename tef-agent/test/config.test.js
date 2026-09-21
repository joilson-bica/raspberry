import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = fileURLToPath(new URL("../src/config.js", import.meta.url));
const envKeys = [
  "BACKEND_URL", "AGENT_TOKEN", "AGENT_ID", "LAUNDRY_ID", "AUTOTEF_URL", "STONE_CODE",
  "PARTNER_NAME", "PINPAD_PORT", "AUTOTEF_IS_PDV", "ACTIVATE_ON_BOOT", "TIMEOUT_QUICK_MS",
  "TIMEOUT_ACTIVATE_MS", "TIMEOUT_TRANSACTION_MS", "TIMEOUT_PIX_STATUS_MS", "HEARTBEAT_MS",
  "HEALTHCHECK_MODE", "HEALTHCHECK_MIN_INTERVAL_MS", "HEALTHCHECK_MIN_GAP_MS", "RESULT_CACHE_SIZE", "LOG_LEVEL",
];
const values = {
  BACKEND_URL: "https://api.promptpag.com",
  AGENT_TOKEN: "test-only-token",
  AGENT_ID: "test-agent",
  LAUNDRY_ID: "11111111-1111-4111-8111-111111111111",
  STONE_CODE: "test-stone-code",
};
const envContent = Object.entries(values).map(([key, value]) => `${key} = ${value}`).join("\n") + '\nPARTNER_NAME="Test Partner"\n';

function fixture(t, content = envContent) {
  const root = mkdtempSync(join(testDir, ".config-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const entry = join(root, "src", "config.mjs");
  copyFileSync(source, entry);
  if (content !== null) writeFileSync(join(root, ".env"), content);
  return (overrides = {}, cwd = root) => {
    const env = { ...process.env };
    for (const key of envKeys) delete env[key];
    Object.assign(env, overrides);
    return spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const { config } = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify(config));`,
    ], { cwd, env, encoding: "utf8" });
  };
}

test("loads the agent .env automatically including spaces around equals", (t) => {
  const result = fixture(t)();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.backendUrl, values.BACKEND_URL);
  assert.equal(config.agentToken, values.AGENT_TOKEN);
  assert.equal(config.agentId, values.AGENT_ID);
  assert.equal(config.laundryId, values.LAUNDRY_ID);
  assert.equal(config.stoneCode, values.STONE_CODE);
  assert.equal(config.partnerName, "Test Partner");
});

test("loads the .env next to package.json even when launched from another directory", (t) => {
  const result = fixture(t)({}, tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agentId, values.AGENT_ID);
});

test("preserves variables injected by systemd or the shell", (t) => {
  const result = fixture(t)({ AGENT_TOKEN: "injected-test-token", AGENT_ID: "injected-agent" });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.agentToken, "injected-test-token");
  assert.equal(config.agentId, "injected-agent");
  assert.equal(config.backendUrl, values.BACKEND_URL);
});

test("works without a local .env when systemd provides the required environment", (t) => {
  const result = fixture(t, null)(values);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agentId, values.AGENT_ID);
});

test("fails clearly when a required variable is missing without printing secrets", (t) => {
  const result = fixture(t, envContent.replace(/^STONE_CODE.*\n/m, ""))();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STONE_CODE/);
  assert.ok(!result.stderr.includes(values.AGENT_TOKEN));
});
