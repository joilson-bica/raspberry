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

function describe(err) {
  if (err?.code === "AGENT_RESULT_UNKNOWN") {
    return { code: "AGENT_RESULT_UNKNOWN", message: "Resultado do pagamento desconhecido" };
  }
  if (err instanceof autotef.AutotefError) {
    return { code: err.code ?? "AUTOTEF_ERROR", message: err.message, reason: err.reason };
  }
  if (err instanceof autotef.AutotefUnreachableError) {
    return { code: "AGENT_UNREACHABLE", message: err.message };
  }
  return { code: "AGENT_ERROR", message: err?.message ?? String(err) };
}

function correlate(payload, result) {
  return { ...result, requestId: payload?.requestId ?? null, paymentId: payload?.paymentId ?? null };
}

function acknowledge(ack, result) {
  if (typeof ack === "function") ack(result);
}

function diagnose(event, result) {
  log.info(JSON.stringify({ event, requestId: result.requestId, paymentId: result.paymentId,
    ok: result.ok, code: result.error?.code ?? null }));
}

function connectionCategory(value) {
  if (typeof value !== "string") return "unknown connection failure";
  const message = value.toLowerCase();
  const categories = [
    "websocket error", "xhr poll error", "xhr post error", "transport error",
    "transport close", "ping timeout", "io server disconnect", "io client disconnect",
    "forced close", "forced server close", "parse error", "timeout",
  ];
  const category = categories.find((candidate) => message.includes(candidate));
  if (category) return category;
  if (/unauthori[sz]ed|forbidden|authentication|invalid token|token inválido/.test(message)) {
    return "authentication error";
  }
  return "unknown connection failure";
}

export function createAgent() {
  // O pinpad é um recurso único: nunca duas operações no Slim ao mesmo tempo.
  let inFlight = null;
  let uncertain = false;

  // Último healthcheck bem-sucedido. O heartbeat republica ISTO, em vez de
  // consultar o Slim de novo — ver a nota sobre o pinpad no README.
  let lastHealth = null;
  let lastHealthAt = 0;
  // Sobe para true depois de uma falha: o próximo momento ocioso seguro reconsulta.
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
    // G002 = Slim sem ativação; AGENT_UNREACHABLE = falha de comunicação com Slim.
    if (code === "AGENT_UNREACHABLE" || code === "G002") healthDirty = true;
    if (["AGENT_UNREACHABLE", "AGENT_RESULT_UNKNOWN", "AGENT_ERROR"].includes(code)) uncertain = true;
  }

  function busyResult() {
    return { ok: false, error: { code: "AGENT_BUSY", message: "O pinpad está ocupado" } };
  }

  async function withSerial(label, task) {
    if (inFlight) return busyResult();
    inFlight = label;
    try {
      publishStatus();
      return await task();
    } finally {
      inFlight = null;
      publishStatus();
    }
  }

  // Envolve os handlers que usam o pinpad: idempotência + exclusão mútua.
  async function exclusive(payload, label, task) {
    const { requestId, paymentId } = payload ?? {};
    if ([requestId, paymentId].some((id) => typeof id !== "string" || !id.trim())) {
      return correlate(payload, { ok: false, error: { code: "BAD_REQUEST", message: "requestId e paymentId devem ser strings não vazias" } });
    }

    const cached = results.get(requestId);
    if (cached) {
      if (cached.label !== label || cached.result.paymentId !== paymentId) {
        return correlate(payload, { ok: false, error: { code: "BAD_REQUEST", message: "requestId já utilizado para outro pagamento ou operação" } });
      }
      return cached.result;
    }
    if (uncertain) {
      return correlate(payload, {
        ok: false, error: { code: "AGENT_RESULT_UNKNOWN", message: "Agente bloqueado após resultado incerto; requer verificação do operador" },
      });
    }

    const result = await withSerial(label, async () => {
      let outcome;
      try {
        outcome = await task();
      } catch (err) {
        outcome = { ok: false, error: describe(err) };
      }
      noteOutcome(outcome);
      remember(requestId, { label, result: correlate(payload, outcome) });
      return outcome;
    });
    return correlate(payload, result);
  }

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
    if (inFlight || uncertain) return lastHealth;

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

    await withSerial("healthcheck", async () => {
      try {
        lastHealth = await autotef.healthcheck();
        lastHealthAt = Date.now();
        healthDirty = false;
        log.debug("Healthcheck OK");
      } catch (err) {
        lastHealth = null;
        lastHealthAt = Date.now();
        healthDirty = true;
        log.warn(`Healthcheck falhou: ${JSON.stringify({ code: describe(err).code })}`);
      }
    });
    return lastHealth;
  };

  // Publica o estado em cache. Sem I/O com o pinpad: é só presença.
  const publishStatus = () => {
    socket.emit("tef.status", {
      agentId: config.agentId,
      laundryId: config.laundryId,
      activated: !uncertain && Boolean(lastHealth),
      busy: uncertain || Boolean(inFlight),
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
    log.info(`Conectado ao backend como ${config.agentId}`);
    void probeHealth().then(publishStatus);
  });

  socket.on("connect_error", (err) => {
    // Token inválido cai aqui: o backend recusa o handshake.
    log.error(`Falha ao conectar no backend: ${connectionCategory(err?.message)}`);
  });

  socket.on("disconnect", (reason) => {
    log.warn(`Desconectado do backend: ${connectionCategory(reason)}`);
  });

  // ---- Pagamento no cartão ---------------------------------------------------

  socket.on("tef.pay", async (payload, ack) => {
    const { requestId, paymentId, amount, method, installments } = payload ?? {};
    const result = await exclusive(payload, "tef.pay", async () => {
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: { code: "BAD_REQUEST", message: "amount inválido" } };
      }
      if (!["debit", "credit", "voucher"].includes(method)) {
        return { ok: false, error: { code: "BAD_REQUEST", message: "method inválido" } };
      }

      // Avisa o backend que o cliente já pode usar o cartão. O totem mostra
      // "insira ou aproxime o cartão" a partir daqui.
      socket.emit("tef.progress", { requestId, paymentId, stage: "waiting_card" });

      const receipt = await autotef.pay({ amount, method, installments });
      return { ok: true, approved: true, receipt };
    });

    // A transação é o melhor sinal de saúde que existe: aprovou, o pinpad
    // está vivo. Falhou sem incerteza, reconsulta no próximo momento ocioso.
    diagnose("tef.pay", result);

    // Rede de segurança: se o ACK não chegar, o backend recebe por aqui.
    socket.emit("tef.result", result);
    acknowledge(ack, result);
  });

  // ---- Cancelamento / estorno ------------------------------------------------

  socket.on("tef.cancel", async (payload, ack) => {
    const { acquirerTransactionKey, amount, transactionType, panMask } = payload ?? {};
    const result = await exclusive(payload, "tef.cancel", async () => {
      if (typeof acquirerTransactionKey !== "string" || !acquirerTransactionKey.trim()) {
        return {
          ok: false,
          error: { code: "BAD_REQUEST", message: "acquirerTransactionKey é obrigatório" },
        };
      }
      await autotef.cancel({ acquirerTransactionKey, amount, transactionType, panMask });
      return { ok: true, cancelled: true };
    });

    diagnose("tef.cancel", result);

    socket.emit("tef.result", result);
    acknowledge(ack, result);
  });

  // ---- Utilitários -----------------------------------------------------------

  socket.on("tef.pinpad.message", async (payload, ack) => {
    let outcome;
    if (inFlight) outcome = busyResult();
    else if (uncertain) outcome = {
      ok: false, error: { code: "AGENT_RESULT_UNKNOWN", message: "Mensagem ignorada após resultado incerto" },
    };
    else {
      outcome = await withSerial("pinpad.message", async () => {
        try {
          return await autotef.pinpadMessage(payload ?? {});
        } catch (err) {
          return { ok: false, error: describe(err) };
        }
      });
    }
    const result = correlate(payload, outcome);
    diagnose("tef.pinpad.message", result);
    acknowledge(ack, result);
  });

  // O backend pode pedir uma consulta real (`force: true`), mas o intervalo
  // mínimo continua valendo e uma operação em curso ou incerta impede a sondagem.
  socket.on("tef.healthcheck", async (payload, ack) => {
    if (inFlight || uncertain) {
      const result = correlate(payload, { ok: !uncertain && Boolean(lastHealth), busy: uncertain || Boolean(inFlight), cached: true, health: lastHealth });
      diagnose("tef.healthcheck", result);
      acknowledge(ack, result);
      return;
    }
    const health = await probeHealth({ force: payload?.force === true });
    const result = correlate(payload, {
      ok: !uncertain && Boolean(health),
      health,
      busy: uncertain || Boolean(inFlight),
      healthAgeMs: lastHealthAt ? Date.now() - lastHealthAt : null,
    });
    diagnose("tef.healthcheck", result);
    acknowledge(ack, result);
  });

  const heartbeat = setInterval(() => {
    if (!socket.connected) return;
    // Modo interval reconsulta quando ocioso e seguro; lazy só se algo falhou antes.
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
