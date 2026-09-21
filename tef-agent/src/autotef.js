import { config } from "./config.js";
import { log } from "./logger.js";

// Cliente do AutoTEF Slim 1.9 (Stone). Doc: https://autotef.readme.io
//
// Este agente roda na MESMA máquina do Slim, então fala HTTP em 127.0.0.1 —
// sem CORS, sem mixed content, sem proxy TLS.
//
// Divergências reais da documentação, validadas na homologação (14/09/2026):
//   - POST /api/Pay responde envelopado em { receipt, card }; a doc mostra os
//     campos do receipt na raiz.
//   - cardReadingType vem como texto ("EMVProximityReader" = NFC,
//     "EMVContactReader" = chip), não como número.
//   - No cancelamento em PDV, o panMask precisa ser o do objeto `card`
//     (com BIN, 490721*********2003). O do receipt (************2003) faz o
//     device recusar com G004 "use the same card" mesmo com o cartão correto.
//   - POST /api/Cancel/ responde 200 com corpo vazio em autosserviço.

export class AutotefError extends Error {
  constructor(httpStatus, body) {
    const code = body?.responseCode ?? body?.ResponseCode ?? null;
    const reason =
      body?.messageDisplay ??
      body?.responseReason ??
      body?.ResponseReason ??
      body?.Message ??
      body?.message ??
      `Falha no AutoTEF (HTTP ${httpStatus})`;
    super(code ? `${code} - ${reason}` : reason);
    this.name = "AutotefError";
    this.code = code;
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

export class AutotefUnreachableError extends Error {
  constructor(cause) {
    super(`AutoTEF inacessível em ${config.autotefUrl}: ${cause?.message ?? cause}`);
    this.name = "AutotefUnreachableError";
    this.code = "AGENT_UNREACHABLE";
    this.cause = cause;
  }
}

export class AutotefResultUnknownError extends Error {
  constructor() {
    super("Resultado do pagamento desconhecido: AutoTEF respondeu sem comprovante válido");
    this.name = "AutotefResultUnknownError";
    this.code = "AGENT_RESULT_UNKNOWN";
  }
}

async function call(path, { method = "GET", body, timeout }) {
  let res;
  let text;
  try {
    res = await fetch(`${config.autotefUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    text = await res.text();
  } catch (err) {
    throw new AutotefUnreachableError(err);
  }

  const payload = text ? safeParse(text) : undefined;

  if (!res.ok) throw new AutotefError(res.status, payload ?? null);

  // 204 (menu estático) e o 200 vazio do cancelamento em autosserviço.
  return payload;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function post(path, body, timeout) {
  return call(path, { method: "POST", body, timeout });
}

// ---- Ativação / saúde --------------------------------------------------------

export function healthcheck() {
  return call("/api/Healthcheck", { timeout: config.timeouts.quick });
}

// Deve ser chamada uma vez por inicialização do Slim: estabelece a
// comunicação com o pinpad, valida o credenciamento e faz a carga de tabelas.
//
// A resposta traz hasBankStone/hasPixKey quando a conta está apta a PIX.
export function activate() {
  return post(
    "/api/Activate",
    {
      stoneCode: config.stoneCode,
      partnerName: config.partnerName,
      connectionName: config.connectionName,
    },
    config.timeouts.activate
  );
}

export async function isActivated() {
  try {
    await healthcheck();
    return true;
  } catch {
    return false;
  }
}

// ---- Cartão ------------------------------------------------------------------

const ACCOUNT_TYPE = { debit: "debit", credit: "credit", voucher: "voucher" };

// installments > 1 usa type 2 = parcelado LOJISTA (sem juros para o cliente).
function installmentOf(installments) {
  if (!installments || installments <= 1) return undefined;
  return { type: 2, number: installments };
}

export async function pay({ amount, method, installments }) {
  const accountType = ACCOUNT_TYPE[method];
  if (!accountType) throw new Error(`Método não suportado no TEF: ${method}`);

  const response = await post(
    "/api/Pay",
    {
      amount,
      accountType,
      installment: installmentOf(installments),
    },
    config.timeouts.transaction
  );

  return normalizeReceipt(response);
}

// Achata { receipt, card } ou o comprovante na raiz no contrato que o backend persiste.
function normalizeReceipt(response) {
  const receipt = response?.receipt ?? response;
  const card = response?.card ?? null;
  if (
    !receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
    typeof receipt.acquirerTransactionKey !== "string" ||
    !receipt.acquirerTransactionKey.trim()
  ) {
    throw new AutotefResultUnknownError();
  }

  return {
    acquirerTransactionKey: receipt.acquirerTransactionKey,
    authorisationCode: receipt.authorisationCode ?? null,
    transactionDateTime: receipt.transactionDateTime,
    amount: receipt.amount,
    brandName: receipt.brandName ?? null,
    cardholderName: receipt.cardholderName ?? null,
    installments: receipt.totalNumberOfPayments > 0 ? receipt.totalNumberOfPayments : 1,
    installmentType: receipt.installmentType ?? 1,
    transactionType: transactionTypeOf(receipt.transactionType),
    // Máscara do receipt (sem BIN): exibição.
    panMask: receipt.maskedPrimaryAccountNumber ?? null,
    // Máscara do card (com BIN): é a que o cancelamento exige em PDV.
    cardPanMask: card?.maskedPrimaryAccountNumber ?? null,
    cardReadingType: readingTypeOf(receipt.cardReadingType),
    cardNeedsPassword: Boolean(receipt.cardNeedsPassword),
    clientVia: receipt.clientVia ?? null,
    merchantVia: receipt.merchantVia ?? null,
    stoneCode: receipt.stoneCode ?? null,
  };
}

// transactionType: 1 = débito, 2 = crédito, 7 = voucher.
function transactionTypeOf(value) {
  if (value === 1) return "debit";
  if (value === 2) return "credit";
  if (value === 7) return "voucher";
  return null;
}

// Texto do device → rótulo estável para o backend/dashboard.
function readingTypeOf(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.includes("Proximity")) return "nfc";
  if (value.includes("Contactless")) return "nfc";
  if (value.includes("Contact")) return "chip";
  if (value.toLowerCase().includes("magnetic")) return "magnetic";
  return value;
}

export async function cancel({ acquirerTransactionKey, amount, transactionType, panMask }) {
  await post(
    "/api/Cancel/",
    {
      acquirerTransactionKey,
      amount,
      // Obrigatórios só em PDV. O panMask precisa ter BIN (ver nota no topo).
      ...(config.isPdv && transactionType ? { transactionType } : {}),
      ...(config.isPdv && panMask ? { panMask } : {}),
    },
    config.timeouts.transaction
  );
  // Autosserviço responde 200 sem corpo; PDV pode devolver { receipt }.
  return { cancelled: true };
}

// ---- PIX ---------------------------------------------------------------------
//
// Indisponível no sandbox: a Stone só habilita conta + chave PIX no StoneCode
// após a homologação. Enquanto isso o Pix/Pay responde 400 G999.

export function pixPay({ amount, expiresIn }) {
  return post("/api/Pix/Pay", { amount, expiresIn }, config.timeouts.transaction);
}

// Bloqueia até o pagamento ser confirmado ou o QR expirar (~10 min).
export function pixStatus(transactionId) {
  return post("/api/Pix/Status", { transactionId }, config.timeouts.pixStatus);
}

// ---- Pinpad ------------------------------------------------------------------

export async function pinpadMessage({ message, secondMessage, formatMessage }) {
  try {
    await post(
      "/api/Pinpad/Message",
      { message, secondMessage, formatMessage },
      config.timeouts.quick
    );
    return { ok: true };
  } catch (err) {
    // Mensagem no display é cosmética: nunca deve derrubar uma transação.
    const code = err.code ?? "AUTOTEF_ERROR";
    log.warn(`Falha ao escrever no pinpad: ${JSON.stringify({ code })}`);
    return { ok: false, error: { code, message: "Falha ao escrever no pinpad" } };
  }
}
