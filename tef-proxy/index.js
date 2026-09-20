#!/usr/bin/env node
"use strict";

// Proxy reverso para o AutoTEF Slim (Stone) rodando no Raspberry Pi.
//
// Por que existe: o totem é servido por HTTPS (Vercel) e o AutoTEF só fala
// HTTP na rede local. O navegador bloqueia essa chamada por mixed content.
// Este proxy fica na frente do Slim e, com um certificado válido, expõe as
// mesmas rotas por HTTPS — a página passa a chamar https://<host>/api/Pay.
//
// Sem dependências: só a stdlib do Node (>= 18).
//
// Uso:
//   node index.js
//   AUTOTEF_URL=http://127.0.0.1:8000 PORT=8443 \
//   TLS_KEY=/etc/letsencrypt/live/tef.../privkey.pem \
//   TLS_CERT=/etc/letsencrypt/live/tef.../fullchain.pem \
//   ALLOWED_ORIGINS=https://app-lavanderia.promptpag.com node index.js

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const { URL } = require("node:url");

const AUTOTEF_URL = process.env.AUTOTEF_URL || "http://127.0.0.1:8000";
const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || "0.0.0.0";
const TLS_KEY = process.env.TLS_KEY || "";
const TLS_CERT = process.env.TLS_CERT || "";

// Origens autorizadas. "*" libera qualquer uma (só para desenvolvimento).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Se definido, toda requisição precisa enviar o header x-proxy-token.
const PROXY_TOKEN = process.env.PROXY_TOKEN || "";

// Pix/Status é bloqueante: o Slim só responde quando o cliente paga ou o
// QR Code expira (600s por padrão). Por isso o timeout generoso.
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 700000);

const upstream = new URL(AUTOTEF_URL);
const upstreamClient = upstream.protocol === "https:" ? https : http;

function resolveOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes("*")) return origin;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function applyCors(req, res) {
  const origin = resolveOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type,x-proxy-token"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  return origin;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function log(req, status, startedAt, note) {
  const ms = Date.now() - startedAt;
  const suffix = note ? ` ${note}` : "";
  console.log(`${req.method} ${req.url} -> ${status} (${ms}ms)${suffix}`);
}

const server = (() => {
  const handler = (req, res) => {
    const startedAt = Date.now();
    const origin = applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return log(req, 204, startedAt, "preflight");
    }

    // Health do proxy (não toca no AutoTEF).
    if (req.url === "/_proxy/health") {
      sendJson(res, 200, { ok: true, upstream: AUTOTEF_URL, tls: !!TLS_CERT });
      return log(req, 200, startedAt);
    }

    if (req.headers.origin && !origin) {
      sendJson(res, 403, { error: "Origin não autorizada" });
      return log(req, 403, startedAt, req.headers.origin);
    }

    if (PROXY_TOKEN && req.headers["x-proxy-token"] !== PROXY_TOKEN) {
      sendJson(res, 401, { error: "Token do proxy inválido" });
      return log(req, 401, startedAt);
    }

    // Só as rotas da API do AutoTEF são repassadas.
    if (!req.url.startsWith("/api/")) {
      sendJson(res, 404, { error: "Rota não encontrada" });
      return log(req, 404, startedAt);
    }

    // Não repassa o Origin: o Slim responderia com os próprios headers de
    // CORS e o navegador recusaria a resposta por ter valores duplicados.
    const headers = { ...req.headers };
    delete headers.origin;
    delete headers.host;
    delete headers["x-proxy-token"];

    const proxied = upstreamClient.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamRes) => {
        const forwarded = { ...upstreamRes.headers };
        for (const key of Object.keys(forwarded)) {
          if (key.toLowerCase().startsWith("access-control-")) {
            delete forwarded[key];
          }
        }
        delete forwarded.vary;

        res.writeHead(upstreamRes.statusCode || 502, forwarded);
        upstreamRes.pipe(res);
        upstreamRes.on("end", () =>
          log(req, upstreamRes.statusCode || 502, startedAt)
        );
      }
    );

    proxied.on("timeout", () => {
      proxied.destroy(new Error(`Timeout de ${UPSTREAM_TIMEOUT_MS}ms no AutoTEF`));
    });

    proxied.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return log(req, 502, startedAt, err.message);
      }
      sendJson(res, 502, {
        responseCode: "PRXY",
        responseReason: `AutoTEF inacessível em ${AUTOTEF_URL}: ${err.message}`,
      });
      log(req, 502, startedAt, err.message);
    });

    req.pipe(proxied);
  };

  if (TLS_KEY && TLS_CERT) {
    return https.createServer(
      { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) },
      handler
    );
  }
  return http.createServer(handler);
})();

// Sem limite de resposta: as transações esperam a ação do cliente no pinpad.
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.timeout = 0;
server.keepAliveTimeout = 72000;

server.listen(PORT, HOST, () => {
  const scheme = TLS_CERT ? "https" : "http";
  console.log(`tef-proxy ouvindo em ${scheme}://${HOST}:${PORT}`);
  console.log(`  upstream: ${AUTOTEF_URL}`);
  console.log(`  origens:  ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`  token:    ${PROXY_TOKEN ? "exigido" : "desativado"}`);
  if (!TLS_CERT) {
    console.log(
      "  aviso:    sem TLS. Uma página HTTPS não vai conseguir chamar este proxy."
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} recebido, encerrando...`);
    server.close(() => process.exit(0));
  });
}
