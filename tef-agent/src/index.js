import { config } from "./config.js";
import { log } from "./logger.js";
import * as autotef from "./autotef.js";
import { createAgent } from "./agent.js";

// Bootstrap: garante o Slim ativado e só então abre o socket com o backend.
// Assim o backend nunca recebe um agente que aceitaria uma cobrança e
// responderia G002 (não ativado) na hora do cartão.

async function ensureActivated() {
  if (await autotef.isActivated()) {
    log.info("AutoTEF já ativado");
    return;
  }

  if (!config.activateOnBoot) {
    log.warn("AutoTEF não ativado e ACTIVATE_ON_BOOT=false — cobranças vão falhar");
    return;
  }

  log.info("Ativando o AutoTEF (carga de tabelas, pode levar ~1 min)...");
  const result = await autotef.activate();
  log.info(
    `Ativado: StoneCode ${result?.stoneCode}, parceiro "${result?.partnerName}", ` +
      `pinpad ${result?.connectionName}`
  );
  if (result?.hasPixKey !== undefined) {
    log.info(`PIX habilitado: banco=${result.hasBankStone} chave=${result.hasPixKey}`);
  }
}

async function main() {
  log.info(`Agente TEF ${config.agentId} (lavanderia ${config.laundryId})`);
  log.info(`AutoTEF: ${config.autotefUrl} | PDV: ${config.isPdv}`);

  try {
    await ensureActivated();
  } catch (err) {
    // Sem pinpad o agente não serve para nada: falhar alto e deixar o
    // systemd reiniciar (Restart=always + RestartSec).
    log.error(`Não foi possível ativar o AutoTEF: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const agent = createAgent();

  const shutdown = (signal) => {
    log.info(`Recebido ${signal}, encerrando...`);
    agent.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Falha fatal: ${err.message}`, err);
  process.exit(1);
});
