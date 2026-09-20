import { io } from "socket.io-client";
import { config } from "./config.js";
import { log } from "./logger.js";
import * as autotef from "./autotef.js";

// Ponte entre o backend e o pinpad.
//
// O agente é CLIENTE do socket: abre a conexão para fora, o que permite o
// Raspberry Pi ficar atrás de NAT sem IP público nem porta liberada.
//
// Contrato de eventos (detalhes no README):
//   backend → agente:  tef.pay | tef.cancel | tef.pinpad.message | tef.healthcheck
//   agente → backend:  tef.status | tef.progress | tef.result
//
// Toda operação do backend responde pelo ACK do socket.io. O `tef.result` é
// uma rede de segurança: se a conexão cair entre o fim da transação e o ACK,
// o backend recebe o resultado no reconnect. Dedupe pelo requestId.

// O pinpad é um recurso único: nunca duas transações ao mesmo tempo.
let inFlight = null;

// Último healthcheck bem-sucedido. O heartbeat republica ISTO, em vez de
// consultar o Slim de novo — ver a nota sobre o pinpad no README.
let lastHealth = null;
let lastHealthAt = 0;
// Sobe para true depois de uma falha: o próximo momento ocioso reconsulta.
let healthDirty = true;

// Resultados recentes, para responder reenvios do mesmo requestId.
const results = new Map();

function remember(requestId, payload) {
  results.set(requestId, payload);
  while (results.size > config.resultCacheSize) {
    results.delete(results.keys().next().value);
  }
}

// Uma transação bem-sucedida prova que o pinpad responde — melhor sinal do
// que qualquer sondagem. Só marcamos para reconsultar quando o erro sugere
// que a comunicação com o device se perdeu.
function noteOutcome(result) {
  if (result?.ok) {
    lastHealthAt = Date.now();
    healthDirty = false;
    return;
  }
  const code = result?.error?.code;
  // G002 = Slim sem ativação; AGENT_UNREACHABLE = Slim fora do ar.
  if (code === "AGENT_UNREACHABLE" || code === "G002") healthDirty = true;
}

function describe(err) {
  if (err instanceof autotef.AutotefError) {
    return { code: err.code ?? "AUTOTEF_ERROR", message: err.message, reason: err.reason };
  }
  if (err instanceof autotef.AutotefUnreachableError) {
    return { code: "AGENT_UNREACHABLE", message: err.message };
  }
  return { code: "AGENT_ERROR", message: err?.message ?? String(err) };
}

// Envolve os handlers que usam o pinpad: idempotência + exclusão mútua.
async function exclusive(requestId, label, task) {
  if (!requestId) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "requestId é obrigatório" } };
  }

  const cached = results.get(requestId);
  if (cached) {
    log.info(`${label} ${requestId}: devolvendo resultado em cache`);
    return cached;
  }

  if (inFlight) {
    log.warn(`${label} ${requestId}: pinpad ocupado por ${inFlight}`);
    return {
      ok: false,
      error: { code: "AGENT_BUSY", message: "O pinpad já está processando outra transação" },
    };
  }

  inFlight = requestId;
  try {
    const payload = await task();
    remember(requestId, payload);
    return payload;
  } catch (err) {
    const payload = { ok: false, error: describe(err) };
    remember(requestId, payload);
    return payload;
  } finally {
    inFlight = null;
  }
}

export function createAgent() {
  const socket = io(config.backendUrl, {
    path: "/tef",
    transports: ["websocket"],
    auth: {
      agentId: config.agentId,
      laundryId: config.laundryId,
      token: config.agentToken,
      version: "0.1.0",
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    // Sem timeout de ACK aqui: quem define o limite é o backend ao emitir.
  });

  // Consulta o Slim só quando vale a pena. NUNCA durante uma transação: a
  // comunicação com o pinpad é serial e exclusiva.
  const probeHealth = async ({ force = false } = {}) => {
    if (inFlight) return lastHealth;

    const age = Date.now() - lastHealthAt;

    // Vencido pelo relógio (só no modo interval) ou por um sinal de falha.
    const stale =
      config.healthcheckMode === "interval" && age >= config.healthcheckMinIntervalMs;
    const needed = force || healthDirty || !lastHealth || stale;
    if (!needed) return lastHealth;

    if (config.healthcheckMode === "off" && !force) return lastHealth;

    // Freio de rajada: mesmo "precisando", nunca duas sondagens coladas.
    // É o que impede um backend insistente (ou reconexões em série) de
    // martelar o device.
    if (lastHealthAt && age < config.healthcheckMinGapMs) return lastHealth;

    try {
      lastHealth = await autotef.healthcheck();
      lastHealthAt = Date.now();
      healthDirty = false;
      log.debug("Healthcheck OK");
    } catch (err) {
      lastHealth = null;
      lastHealthAt = Date.now();
      healthDirty = true;
      log.warn(`Healthcheck falhou: ${err.message}`);
    }
    return lastHealth;
  };

  // Publica o estado em cache. Sem I/O com o pinpad: é só presença.
  const publishStatus = () => {
    socket.emit("tef.status", {
      agentId: config.agentId,
      laundryId: config.laundryId,
      activated: Boolean(lastHealth),
      busy: Boolean(inFlight),
      stoneCode: lastHealth?.stoneCode ?? config.stoneCode,
      partnerName: lastHealth?.partnerName ?? config.partnerName,
      connectionName: lastHealth?.connectionName ?? config.connectionName,
      // Só vêm na ativação; quando true, a conta está apta a PIX.
      hasBankStone: lastHealth?.hasBankStone ?? null,
      hasPixKey: lastHealth?.hasPixKey ?? null,
      // Idade do dado, para o backend saber que é cache e não sondagem.
      healthAgeMs: lastHealthAt ? Date.now() - lastHealthAt : null,
      at: new Date().toISOString(),
    });
  };

  socket.on("connect", () => {
    log.info(`Conectado ao backend (${config.backendUrl}) como ${config.agentId}`);
    void probeHealth().then(publishStatus);
  });

  socket.on("connect_error", (err) => {
    // Token inválido cai aqui: o backend recusa o handshake.
    log.error(`Falha ao conectar no backend: ${err.message}`);
  });

  socket.on("disconnect", (reason) => {
    log.warn(`Desconectado do backend: ${reason}`);
  });

  // ---- Pagamento no cartão ---------------------------------------------------

  socket.on("tef.pay", async (payload, ack) => {
    const { requestId, paymentId, amount, method, installments } = payload ?? {};
    log.info(
      `tef.pay ${requestId}: ${method} R$ ${amount} (pagamento ${paymentId})` +
        (installments > 1 ? ` em ${installments}x` : "")
    );

    const result = await exclusive(requestId, "tef.pay", async () => {
      if (typeof amount !== "number" || amount <= 0) {
        return { ok: false, error: { code: "BAD_REQUEST", message: "amount inválido" } };
      }

      // Avisa o backend que o cliente já pode usar o cartão. O totem mostra
      // "insira ou aproxime o cartão" a partir daqui.
      socket.emit("tef.progress", { requestId, paymentId, stage: "waiting_card" });

      const receipt = await autotef.pay({ amount, method, installments });
      return { ok: true, requestId, paymentId, approved: true, receipt };
    });

    // A transação é o melhor sinal de saúde que existe: aprovou, o pinpad
    // está vivo. Falhou, reconsulta no próximo momento ocioso.
    noteOutcome(result);

    // Rede de segurança: se o ACK não chegar, o backend recebe por aqui.
    socket.emit("tef.result", { ...result, requestId, paymentId });
    ack?.(result);
  });

  // ---- Cancelamento / estorno ------------------------------------------------

  socket.on("tef.cancel", async (payload, ack) => {
    const { requestId, paymentId, acquirerTransactionKey, amount, transactionType, panMask } =
      payload ?? {};
    log.info(`tef.cancel ${requestId}: ATK ${acquirerTransactionKey} R$ ${amount}`);

    const result = await exclusive(requestId, "tef.cancel", async () => {
      if (!acquirerTransactionKey) {
        return {
          ok: false,
          error: { code: "BAD_REQUEST", message: "acquirerTransactionKey é obrigatório" },
        };
      }
      await autotef.cancel({ acquirerTransactionKey, amount, transactionType, panMask });
      return { ok: true, requestId, paymentId, cancelled: true };
    });

    noteOutcome(result);

    socket.emit("tef.result", { ...result, requestId, paymentId });
    ack?.(result);
  });

  // ---- Utilitários -----------------------------------------------------------

  socket.on("tef.pinpad.message", async (payload, ack) => {
    const result = await autotef.pinpadMessage(payload ?? {});
    ack?.(result);
  });

  // O backend pode pedir uma consulta real (`force: true`), mas o intervalo
  // mínimo continua valendo e uma transação em curso tem prioridade.
  socket.on("tef.healthcheck", async (payload, ack) => {
    if (inFlight) {
      ack?.({ ok: true, busy: true, cached: true, health: lastHealth });
      return;
    }
    const health = await probeHealth({ force: payload?.force === true });
    ack?.({
      ok: Boolean(health),
      health,
      busy: false,
      healthAgeMs: lastHealthAt ? Date.now() - lastHealthAt : null,
    });
  });

  const heartbeat = setInterval(() => {
    if (!socket.connected) return;
    // Modo interval reconsulta quando ocioso; lazy só se algo falhou antes.
    void probeHealth().then(publishStatus);
  }, config.heartbeatMs);

  return {
    socket,
    stop() {
      clearInterval(heartbeat);
      socket.close();
    },
  };
}
