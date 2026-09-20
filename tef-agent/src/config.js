// Configuração do agente, toda por variável de ambiente.
//
// Em produção o systemd injeta as variáveis (ver deploy/tef-agent.service).
// Em desenvolvimento, `node --env-file=.env src/index.js` (Node >= 20.6)
// ou exporte na shell.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. Veja o .env.example.`
    );
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  // ---- Backend -------------------------------------------------------------
  // O agente é CLIENTE do socket: ele abre a conexão para fora. É o que
  // permite o Pi ficar atrás de NAT, sem IP público nem porta liberada.
  backendUrl: required("BACKEND_URL"),
  agentToken: required("AGENT_TOKEN"),
  agentId: required("AGENT_ID"),
  laundryId: required("LAUNDRY_ID"),

  // ---- AutoTEF Slim (mesma máquina) ---------------------------------------
  autotefUrl: process.env.AUTOTEF_URL ?? "http://127.0.0.1:8000",
  stoneCode: required("STONE_CODE"),
  partnerName: process.env.PARTNER_NAME ?? "PromptPag Lavanderia",
  connectionName: process.env.PINPAD_PORT ?? "/dev/ttyACM0",

  // Instalação como PDV (appsettings IsPdv=true). Só nesse caso o
  // cancelamento envia transactionType e panMask.
  isPdv: process.env.AUTOTEF_IS_PDV === "true",

  // Ativa o Slim ao subir. Deixe true: sem ativação o Pay responde G002.
  activateOnBoot: process.env.ACTIVATE_ON_BOOT !== "false",

  // ---- Timeouts (ms) -------------------------------------------------------
  timeouts: {
    quick: int("TIMEOUT_QUICK_MS", 15000), // healthcheck, mensagem no pinpad
    activate: int("TIMEOUT_ACTIVATE_MS", 120000), // carga de tabelas
    transaction: int("TIMEOUT_TRANSACTION_MS", 180000), // espera o cliente
    pixStatus: int("TIMEOUT_PIX_STATUS_MS", 660000), // expiração do QR + folga
  },

  // Batida de presença para o backend. NÃO toca no pinpad: manda o último
  // estado conhecido em cache.
  heartbeatMs: int("HEARTBEAT_MS", 30000),

  // Com que frequência é permitido consultar o Slim de verdade
  // (GET /api/Healthcheck). O Slim conversa com o pinpad pela serial, e
  // consultar de minuto em minuto acorda o device à toa — aquece e pode
  // disputar a porta. Ver a seção "Healthcheck" no README.
  //
  //   lazy     (padrão) só na inicialização e depois de uma falha
  //   interval a cada HEALTHCHECK_MIN_INTERVAL_MS, quando ocioso
  //   off      nunca sozinho; só se o backend pedir
  healthcheckMode: process.env.HEALTHCHECK_MODE ?? "lazy",
  healthcheckMinIntervalMs: int("HEALTHCHECK_MIN_INTERVAL_MS", 600000), // 10 min
  // Freio de rajada: intervalo mínimo entre duas sondagens, mesmo após uma
  // falha ou um pedido do backend.
  healthcheckMinGapMs: int("HEALTHCHECK_MIN_GAP_MS", 60000), // 1 min

  // Quantos resultados recentes manter em memória para responder a
  // reenvios do mesmo requestId (idempotência após reconexão).
  resultCacheSize: int("RESULT_CACHE_SIZE", 50),

  logLevel: process.env.LOG_LEVEL ?? "info",
};
