const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const bash = process.env.BASH_FOR_TESTS || '/bin/bash';

function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(tmpdir(), 'tef-launcher-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const desktop = path.join(temporary, 'Desktop with spaces');
  const bin = path.join(temporary, 'fake-bin');
  const marker = path.join(temporary, 'must-not-start');
  for (const dir of ['tef', 'rasp/tef-agent', ...(options.missingProxy ? [] : ['rasp/tef-proxy'])]) {
    fs.mkdirSync(path.join(desktop, dir), { recursive: true });
  }
  fs.mkdirSync(bin);
  const writeExecutable = (file, body) => { fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(file, 0o755); };
  fs.copyFileSync(path.join(root, 'iniciar-tef.sh'), path.join(desktop, 'iniciar-tef.sh'));
  writeExecutable(path.join(desktop, 'tef/AutoTEF.Service'), 'touch "$FAKE_MARKER"');
  fs.writeFileSync(path.join(desktop, 'rasp/tef-agent/package.json'), '{}');
  if (!options.missingProxy) fs.writeFileSync(path.join(desktop, 'rasp/tef-proxy/package.json'), '{}');
  writeExecutable(path.join(bin, 'uname'), 'printf "Linux\\n"');
  writeExecutable(path.join(bin, 'flock'), 'exit "${FAKE_LOCK_RESULT:-0}"');
  writeExecutable(path.join(bin, 'ps'), 'if [[ "${FAKE_RUNNING:-}" == "yes" ]]; then printf "4242 node\\n"; fi');
  writeExecutable(path.join(bin, 'readlink'), 'cd -- "$FAKE_AGENT_DIR" && pwd -P');
  writeExecutable(path.join(bin, 'systemctl'), '[[ -n "${FAKE_ACTIVE_UNIT:-}" && "${3:-}" == "$FAKE_ACTIVE_UNIT" ]] && exit 0; exit 3');
  for (const command of ['npm', 'setsid']) writeExecutable(path.join(bin, command), 'touch "$FAKE_MARKER"; exit 91');
  writeExecutable(path.join(bin, 'node'), `case "$*" in
  *'node:net'*) [[ "\${FAKE_PORT_BUSY:-}" == "yes" ]] && exit 0; exit 1 ;;
  *'const port = Number'*) printf '8443\\n' ;;
  *'console.log(process.env.HOST'*) printf '127.0.0.1\\n' ;;
  *'pathToFileURL'*) [[ "\${FAKE_CONFIG_FAIL:-}" == "yes" ]] && exit 1; exit 0 ;;
  *) exit 0 ;;
esac`);
  return {
    marker,
    run: (env = {}) => spawnSync(bash, ['-c', 'export PATH="$1:$PATH"; exec /bin/bash "$2" --check', '_', bin, path.join(desktop, 'iniciar-tef.sh')], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AUTOTEF_PORT: '8000', STARTUP_TIMEOUT_SECONDS: '60', FAKE_MARKER: marker,
        FAKE_AGENT_DIR: path.join(desktop, 'rasp/tef-agent').replaceAll('\\', '/'), ...env },
    }),
  };
}

test('launcher is valid Bash and --check accepts spaces without starting any process', (t) => {
  const syntax = spawnSync(bash, ['-n', path.join(root, 'iniciar-tef.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nenhum processo foi iniciado/);
  assert.equal(fs.existsSync(f.marker), false);
});

for (const [scenario, env, expected] of [
  ['invalid port', { AUTOTEF_PORT: '0' }, /AUTOTEF_PORT invalida/],
  ['invalid wait', { STARTUP_TIMEOUT_SECONDS: '0' }, /STARTUP_TIMEOUT_SECONDS/],
  ['missing configuration', { FAKE_CONFIG_FAIL: 'yes' }, /Corrija o .env/],
  ['another launcher', { FAKE_LOCK_RESULT: '1' }, /lancador ja esta em execucao/],
  ['active systemd service', { FAKE_ACTIVE_UNIT: 'tef-agent.service' }, /tef-agent.service ja esta ativo/],
  ['existing node process', { FAKE_RUNNING: 'yes' }, /ja esta em execucao \(PID 4242\)/],
  ['busy port', { FAKE_PORT_BUSY: 'yes' }, /Porta 8000 ja esta em uso/],
]) {
  test(`launcher refuses ${scenario} before starting services`, (t) => {
    const f = fixture(t);
    const result = f.run(env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.equal(fs.existsSync(f.marker), false);
  });
}

test('launcher reports a missing service directory', (t) => {
  const f = fixture(t, { missingProxy: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pasta nao encontrada/);
  assert.equal(fs.existsSync(f.marker), false);
});

test('proxy npm start loads its own dotenv without opening real sockets', (t) => {
  const proxy = path.join(root, 'tef-proxy');
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'tef-proxy-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '.env'), 'HOST=127.0.0.1\nPORT=9555\nAUTOTEF_URL=http://127.0.0.1:1\nPROXY_TOKEN=test-only-token\n');
  const dotenv = createRequire(path.join(proxy, 'index.js'))('dotenv');
  const env = {};
  let address;
  const logs = [];
  const server = { listen: (port, host, callback) => { address = { port, host }; callback(); } };
  const fakeHttp = { createServer: () => server };
  vm.runInNewContext(fs.readFileSync(path.join(proxy, 'index.js'), 'utf8'), {
    __dirname: directory,
    require: (name) => {
      if (name === 'node:http' || name === 'node:https') return fakeHttp;
      if (name === 'dotenv') return { config: (options) => dotenv.config({ ...options, processEnv: env }) };
      return require(name);
    },
    process: { env, on() {} },
    console: { log: (...args) => logs.push(args.join(' ')) },
  });
  assert.deepEqual(address, { port: 9555, host: '127.0.0.1' });
  assert.ok(logs.some((line) => line.includes('token:    exigido')));
  assert.ok(!logs.some((line) => line.includes('test-only-token')));
  const manifest = JSON.parse(fs.readFileSync(path.join(proxy, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.start, 'node index.js');
});
