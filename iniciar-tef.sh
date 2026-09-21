#!/usr/bin/env bash
set -u

fail() {
  printf 'ERRO: %s\n' "$*" >&2
  if [[ -t 0 ]]; then read -r -p 'Pressione Enter para fechar...' _; fi
  exit 1
}

if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' 'Uso: bash ~/Desktop/iniciar-tef.sh [--check]' \
    'Pastas: Desktop/tef, Desktop/rasp/tef-agent e Desktop/rasp/tef-proxy.' \
    '--check valida a instalacao sem iniciar os processos.' \
    'Ctrl+C encerra somente os processos iniciados por este lancador.'
  exit 0
fi
[[ $# -eq 0 || ( $# -eq 1 && "$1" == "--check" ) ]] || fail 'Argumento invalido. Use --help.'
[[ "$(uname -s)" == "Linux" ]] || fail 'Este lancador e para Raspberry Pi/Linux.'

base_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
tef_dir="$base_dir/tef"
agent_dir="$base_dir/rasp/tef-agent"
proxy_dir="$base_dir/rasp/tef-proxy"
autotef_port="${AUTOTEF_PORT:-8000}"
startup_timeout="${STARTUP_TIMEOUT_SECONDS:-60}"

for tool in node npm setsid flock ps readlink; do
  command -v "$tool" >/dev/null 2>&1 || fail "Comando ausente: $tool"
done
for dir in "$tef_dir" "$agent_dir" "$proxy_dir"; do
  [[ -d "$dir" ]] || fail "Pasta nao encontrada: $dir. Copie este script para o Desktop."
done
tef_dir="$(cd -- "$tef_dir" && pwd -P)"
agent_dir="$(cd -- "$agent_dir" && pwd -P)"
proxy_dir="$(cd -- "$proxy_dir" && pwd -P)"
[[ -x "$tef_dir/AutoTEF.Service" ]] || fail "Confirme o arquivo e permissao: chmod +x \"$tef_dir/AutoTEF.Service\""
for dir in "$agent_dir" "$proxy_dir"; do
  [[ -f "$dir/package.json" ]] || fail "package.json nao encontrado em $dir. Atualize o repositorio."
done
[[ "$autotef_port" =~ ^[0-9]+$ ]] && ((10#$autotef_port > 0 && 10#$autotef_port <= 65535)) || fail 'AUTOTEF_PORT invalida.'
[[ "$startup_timeout" =~ ^[0-9]+$ ]] && ((10#$startup_timeout > 0)) || fail 'STARTUP_TIMEOUT_SECONDS deve ser um inteiro positivo.'

node -e 'for (const [dir, modules] of [[process.argv[1], ["dotenv", "socket.io-client"]], [process.argv[2], ["dotenv"]]]) { for (const name of modules) require.resolve(name, { paths: [dir] }); }' "$agent_dir" "$proxy_dir" \
  || fail 'Instale as dependencias: npm ci --omit=dev em tef-agent e tef-proxy.'
node --input-type=module -e 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]).href);' "$agent_dir/src/config.js" \
  || fail 'Corrija o .env do tef-agent antes de iniciar.'
proxy_port="$(cd -- "$proxy_dir" && node -e 'require("dotenv").config({ quiet: true }); const port = Number(process.env.PORT || 8443); if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1); console.log(port);')" \
  || fail 'PORT invalida no ambiente do tef-proxy.'
proxy_host="$(cd -- "$proxy_dir" && node -e 'require("dotenv").config({ quiet: true }); console.log(process.env.HOST || "127.0.0.1");')" \
  || fail 'Nao foi possivel carregar HOST do proxy.'
((10#$autotef_port != 10#$proxy_port)) || fail 'AutoTEF e proxy precisam de portas diferentes.'

exec 9>"$base_dir/.iniciar-tef.lock" || fail 'Nao foi possivel criar o arquivo de controle no Desktop.'
flock -n 9 || fail 'Este lancador ja esta em execucao. Use a janela que ja esta aberta.'

if command -v systemctl >/dev/null 2>&1; then
  for unit in autotef.service tef-agent.service tef-proxy.service; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      fail "$unit ja esta ativo. Nao combine este lancador com systemd/PM2."
    fi
  done
fi
while read -r pid name; do
  case "$name" in
    AutoTEF.Service) fail "AutoTEF.Service ja esta em execucao (PID $pid)." ;;
    node|nodejs|npm*)
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      if [[ "$cwd" == "$agent_dir" || "$cwd" == "$agent_dir/"* || "$cwd" == "$proxy_dir" || "$cwd" == "$proxy_dir/"* ]]; then
        fail "Agente/proxy ja esta em execucao (PID $pid). Confira as instancias existentes."
      fi
      ;;
  esac
done < <(ps -eo pid=,comm=)

port_open() {
  node -e 'const socket = require("node:net").connect({ host: "127.0.0.1", port: Number(process.argv[1]) }); const done = code => { socket.destroy(); process.exit(code); }; socket.setTimeout(500); socket.once("connect", () => done(0)); socket.once("error", () => done(1)); socket.once("timeout", () => done(1));' "$1"
}
for port in "$autotef_port" "$proxy_port"; do
  if port_open "$port"; then
    fail "Porta $port ja esta em uso. Nenhum processo existente foi encerrado."
  fi
done

if [[ "${1:-}" == "--check" ]]; then
  printf '%s\n' 'Configuracao verificada. Nenhum processo foi iniciado.'
  exit 0
fi

cleanup() {
  trap - EXIT INT TERM HUP
  printf '\nEncerrando somente os processos iniciados nesta janela...\n'
  local pid
  for pid in $(jobs -pr); do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

start_service() {
  local name="$1" dir="$2"
  shift 2
  printf '\nIniciando %s em %s\n' "$name" "$dir"
  setsid /bin/bash -c 'cd -- "$1" || exit 1; shift; exec "$@"' _ "$dir" "$@" &
  last_pid=$!
}

start_service 'AutoTEF Slim' "$tef_dir" ./AutoTEF.Service
tef_pid=$last_pid
deadline=$((SECONDS + 10#$startup_timeout))
until port_open "$autotef_port"; do
  kill -0 "$tef_pid" 2>/dev/null || fail 'AutoTEF encerrou antes de abrir a porta. Confira o log acima.'
  ((SECONDS < deadline)) || fail "AutoTEF nao abriu a porta $autotef_port dentro do limite."
  sleep 1
done

start_service 'TEF Agent' "$agent_dir" npm run start
start_service 'TEF Proxy' "$proxy_dir" env "HOST=$proxy_host" npm run start
printf '\nTres processos iniciados. Os logs aparecem nesta janela.\n'
printf 'Mantenha a janela aberta. Use Ctrl+C somente sem pagamento em andamento.\n'
while [[ -n "$(jobs -pr)" ]]; do
  wait -n
  code=$?
  printf '\nUm processo encerrou (codigo %s). Confira o log. Os demais nao serao reiniciados automaticamente.\n' "$code"
done
