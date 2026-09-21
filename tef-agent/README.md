# tef-agent

Agente que roda no **Raspberry Pi do totem**. Recebe eventos do backend por
socket e executa a transação no **pinpad** através do AutoTEF Slim (Stone).

Node >= 18, dependências `socket.io-client` e `dotenv`, **sem build**.

## Por que existe

O navegador do totem não pode falar com o pinpad:

- Página em HTTPS **não chama** `http://<pi>:8000` (mixed content).
- Um servidor na nuvem (Vercel/VPS) **não alcança** a rede local do totem.

O agente inverte a direção: **ele** abre a conexão para o backend. Com isso o
Pi funciona atrás de NAT, sem IP público, sem porta liberada e sem TLS local
— e o totem volta a poder ser servido de qualquer lugar.

```
Totem (navegador)  ──HTTPS──►  Backend NestJS
                                   │  socket (o agente conecta para fora)
                                   ▼
                              tef-agent  (este projeto, no Pi)
                                   │  HTTP 127.0.0.1:8000
                                   ▼
                              AutoTEF Slim ──serial──► pinpad PPC 930
```

Na aprovação, o backend dispara o START por MQTT para os controladores das
máquinas. O agente **não** fala com as máquinas.

## Instalação no Pi

```bash
sudo mkdir -p /opt/tef-agent && sudo chown $USER /opt/tef-agent
git clone <url-deste-repo> /opt/tef-agent
cd /opt/tef-agent && npm ci --omit=dev

sudo cp deploy/tef-agent.service /etc/systemd/system/
sudo cp .env.example /etc/tef-agent.env   # preencher!
sudo chmod 600 /etc/tef-agent.env         # contém o token do backend

sudo systemctl daemon-reload
sudo systemctl enable --now tef-agent
journalctl -u tef-agent -f
```

Execução direta, sem systemd (não rode junto de outra instância):

```bash
npm ci --omit=dev
test -e .env || cp .env.example .env
chmod 600 .env
nano .env
npm start
```

`src/config.js` importa `dotenv` e carrega automaticamente o `.env` ao lado
do `package.json`, independentemente do diretório de onde o Node foi iniciado.
Variáveis já presentes no processo têm prioridade: com systemd, edite
`/etc/tef-agent.env`; ao usar PM2, confira também o ambiente salvo no processo.
Não é necessário `--env-file` nem copiar o arquivo para `src/`.
Espaços ao redor de `=` são aceitos pelo dotenv, mas prefira `CHAVE=valor`.

Para validar sem conectar ao backend/pinpad:

```bash
npm run check
npm test
```

Os testes usam somente arquivos temporários e HTTP/socket falsos, com dados
fictícios. Os testes de agente/cliente substituem os imports de configuração
antes de carregar o código: não leem o `.env` real nem acessam Slim, banco ou
backend. Cobrem carregamento de configuração, precedência do ambiente,
normalização do comprovante, timeout durante leitura do corpo, correlação
ACK/evento/cache e concorrência com respostas propositalmente adiadas.

## Variáveis de ambiente

| Variável | Default | Descrição |
|:--|:--|:--|
| `BACKEND_URL` | — | **Obrigatória.** Ex.: `https://api.promptpag.com` |
| `AGENT_TOKEN` | — | **Obrigatória.** Igual ao `TEF_AGENT_TOKEN` do backend |
| `AGENT_ID` | — | **Obrigatória.** Identifica o totem (ex.: `totem-01`) |
| `LAUNDRY_ID` | — | **Obrigatória.** Lavanderia a que este totem pertence |
| `AUTOTEF_URL` | `http://127.0.0.1:8000` | Onde o Slim ouve |
| `STONE_CODE` | — | **Obrigatória.** Usada na ativação |
| `PARTNER_NAME` | `PromptPag Lavanderia` | Ignorado pelo Slim se fixo no `appsettings.json` |
| `PINPAD_PORT` | `/dev/ttyACM0` | Sem isso o Slim varre as portas seriais |
| `AUTOTEF_IS_PDV` | `false` | `true` envia `transactionType`/`panMask` no cancelamento |
| `ACTIVATE_ON_BOOT` | `true` | Ativa o Slim ao subir |
| `HEALTHCHECK_MODE` | `lazy` | `lazy`, `interval` ou `off` — ver abaixo |
| `HEALTHCHECK_MIN_INTERVAL_MS` | `600000` | No modo `interval`, de quanto em quanto tempo |
| `HEALTHCHECK_MIN_GAP_MS` | `60000` | Freio de rajada entre duas sondagens |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

## Healthcheck: por que o agente quase não sonda o pinpad

O `GET /api/Healthcheck` **não é de graça**. O Slim fala com o PPC 930 por
uma serial exclusiva, e sondar de tempos em tempos tem três efeitos ruins
já observados em campo: o device é acordado à toa (aquece), a porta pode
ficar disputada, e uma sondagem que caia junto de uma transação atrapalha a
que importa.

Por isso o agente segue três regras:

- **Nunca sonda durante outra operação.** `probeHealth()` devolve o cache na
  hora se houver algo em andamento — inclusive quando o backend pede. A
  sondagem reserva a mesma serial que Pay, Cancel e mensagens antes do HTTP.
- **O heartbeat publica cache.** A cada 30s o agente publica `tef.status`
  com o **último estado conhecido** e a idade dele (`healthAgeMs`). Uma
  consulta real só ocorre quando a política lazy/interval/off permite,
  respeitando o intervalo mínimo e a exclusão mútua.
- **A transação é o melhor healthcheck.** Um `Pay` aprovado prova que o
  device responde. Falhas de comunicação marcam a saúde como desatualizada,
  mas resultado transacional incerto suspende sondagens, até as forçadas,
  e mensagens cosméticas nesta instância (ver contrato de incerteza abaixo).

No modo padrão (`lazy`), o Slim é consultado **na inicialização e depois de
uma falha** — mais nada. Use `interval` apenas se o dashboard precisar de
certeza periódica de que o totem está apto, e mesmo assim com
`HEALTHCHECK_MIN_INTERVAL_MS` alto.

> **Ativação é diferente de sondagem.** O `POST /api/Activate` faz carga de
> tabelas e leva até ~1 min; roda **uma vez** por inicialização do Slim, no
> boot do agente. Não o chame em laço.

## Contrato de eventos

Handshake (`auth` do socket): `{ agentId, laundryId, token, version }`.
Token inválido = conexão recusada no `connect_error`.

### Backend → agente

Todos respondem pelo **ACK** do socket.io. Quem define o timeout é o backend.

| Evento | Payload | Resposta |
|:--|:--|:--|
| `tef.pay` | `{ requestId, paymentId, amount, method, installments? }` | `{ ok, approved, receipt }` ou `{ ok: false, error }` |
| `tef.cancel` | `{ requestId, paymentId, acquirerTransactionKey, amount, transactionType?, panMask? }` | `{ ok, cancelled }` ou `{ ok: false, error }` |
| `tef.pinpad.message` | `{ requestId?, paymentId?, message, secondMessage?, formatMessage? }` | `{ ok }` ou `{ ok: false, error }` |
| `tef.healthcheck` | `{ requestId?, paymentId?, force? }` | `{ ok, health, busy, cached? }` |

Todas as respostas ACK carregam `requestId` e `paymentId` da requisição
(`null` se ausentes), inclusive `BAD_REQUEST`, `AGENT_BUSY`, exceções e
reenvios em cache. Pay/Cancel emitem exatamente o mesmo objeto em
`tef.result`. ACK ausente ou não-função é ignorado. Os logs de resultado
registram evento, IDs, `ok` e código, nunca ATK, PAN, token ou comprovante.
Pay/Cancel exigem ambos os IDs como strings não vazias. Reutilizar `requestId`
com outro `paymentId` ou outra operação devolve `BAD_REQUEST`, sem alterar o
resultado original nem associar uma aprovação antiga a outro pagamento.
Falhas de socket registram categorias seguras extraídas de `err.message` ou
`reason` (por exemplo, `websocket error`, `transport close`, `ping timeout`,
`authentication error`), nunca o objeto bruto ou texto arbitrário com token.

`method`: `debit` \| `credit`. `amount` em **reais** (float, ex.: `25.80`).
`installments > 1` usa parcelamento **lojista** (sem juros para o cliente).

### Agente → backend

| Evento | Quando | Payload |
|:--|:--|:--|
| `tef.status` | ao conectar, a cada 30s e imediatamente ao reservar/liberar a serial | `{ agentId, laundryId, activated, busy, stoneCode, hasPixKey, ... }` |
| `tef.progress` | o pinpad está esperando o cartão | `{ requestId, paymentId, stage: "waiting_card" }` |
| `tef.result` | ao fim de `tef.pay`/`tef.cancel` | o mesmo objeto do ACK |

> **`tef.result` é rede de segurança.** Se a conexão cair entre o fim da
> transação e o ACK, o resultado chega por aqui no reconnect. **O backend
> precisa deduplicar pelo `requestId`** — um pagamento pode ser confirmado
> pelas duas vias.

### Formato do `receipt`

```json
{
  "acquirerTransactionKey": "35761084218848",
  "authorisationCode": "218848",
  "transactionDateTime": "2026-09-14T20:36:25",
  "amount": 20.0,
  "brandName": "VISA CREDITO",
  "installments": 1,
  "transactionType": "credit",
  "panMask": "************2105",
  "cardPanMask": "433178*********2105",
  "cardReadingType": "chip",
  "cardNeedsPassword": true,
  "clientVia": "...cupom do cliente...",
  "merchantVia": "...cupom do estabelecimento..."
}
```

## Garantias

- **Uma operação no Slim por vez.** Pay, Cancel, healthcheck e mensagem
  cosmética compartilham a mesma reserva, liberada em `finally`. Pay/Cancel
  recebem `AGENT_BUSY` imediatamente se health/message já estiver usando a
  serial; não há espera ilimitada nem fila. Health concorrente responde cache.
  Mensagem concorrente recebe `AGENT_BUSY` e é descartada, nunca executada
  depois de uma aprovação. O backend não deve reenfileirar essas mensagens.
- **Idempotência.** Os últimos 50 `requestId` ficam em memória: reenvio com
  os mesmos IDs e operação devolve o resultado guardado, sem cobrar de novo,
  inclusive durante o bloqueio por incerteza. Conflitos recebem `BAD_REQUEST`.
- **Ativação antes de conectar.** O agente só entra no socket com o Slim
  ativado — o backend nunca recebe um agente que responderia `G002`.

> A idempotência é **em memória**: reiniciar o agente esquece os `requestId`.
> Para cobrança duplicada ser impossível mesmo com restart, o backend deve
> checar se o `Payment` já saiu de `pending` antes de reemitir.

## Resultado incerto e botão vermelho

- **`AGENT_RESULT_UNKNOWN`**: Pay recebeu HTTP 2xx, mas não há comprovante
  válido (JSON inválido, vazio, objeto de erro ou ATK ausente/inválido).
  Não significa recusa: pode haver cobrança. Não retorna `approved: true`.
- **`AGENT_UNREACHABLE`**: timeout ou falha de comunicação, inclusive na leitura
  do corpo após os headers. O mesmo prazo HTTP cobre headers e corpo. Em uma
  transação também é incerto, não prova que ela foi recusada/cancelada.
- **`AGENT_ERROR`**: uma exceção inesperada durante Pay/Cancel também é tratada
  conservadoramente como incerta; um erro de processamento pode ocorrer depois
  da cobrança. O código original é preservado no resultado/cache.
- O backend deve manter esses resultados como **pendentes de conciliação**,
  preservar os IDs e não cobrar novamente nem estornar automaticamente. O
  agente guarda o resultado no cache, inclusive o incerto; `AGENT_BUSY` e
  rejeições de novas operações durante o bloqueio não são cacheados.
- Após qualquer desses resultados transacionais, **novos Pay e Cancel são
  bloqueados com `AGENT_RESULT_UNKNOWN`**, sem chamar Slim, enfileirar, tentar
  novamente ou estornar. Reenvios válidos de operações em cache continuam
  consultáveis, incluindo sucessos anteriores, sem remover o bloqueio.
- Mensagens cosméticas também recebem `AGENT_RESULT_UNKNOWN`; healthcheck,
  inclusive forçado, retorna somente cache com `ok: false` e `busy: true`.
  O status publica **`activated: false`, `busy: true`**, imediatamente e nas
  próximas publicações, para impedir seleção como agente disponível.
- Não existe desbloqueio por relógio, healthcheck ou reconexão. **Um operador
  deve conferir o resultado na Stone e o estado do Slim antes de reiniciar o
  agente. Reinício NÃO concilia pagamentos e NÃO significa cancelamento**;
  apenas perde o bloqueio e o cache em memória. A conciliação deve acontecer
  separadamente antes de autorizar nova cobrança.
- `tef.cancel` continua sendo **estorno explícito por ATK**, não interrupção de
  um Pay em andamento. Botão vermelho não dispara endpoint adicional de
  Confirm/Finish/Cancel nem estorno automático. Nenhum endpoint adicional de
  confirmação foi estabelecido pelo contrato/documentação disponível.

No incidente relatado, abandono no backend em 120s ocorre antes do timeout
padrão de Pay (180s). Uma mensagem de abandono não deve disputar a serial nem
ser reenviada para o display após uma aprovação. A evidência disponível
(`AGENT_UNREACHABLE` e `abandonedAt` em 120s) não estabelece causa única de
hardware ou de software; faltam os logs completos da tentativa. Alinhar os
prazos e conciliar resultados no backend/frontend é uma alteração separada.

## Particularidades do AutoTEF (validadas em homologação)

- `POST /api/Pay` pode responder **envelopado** em `{ receipt, card }` (observado)
  ou com os campos na raiz (documentado). Ambos exigem
  `acquirerTransactionKey` string não vazia; a máscara de `card` é preservada.
- `cardReadingType` textual (`EMVProximityReader`, `Contactless`,
  `EMVContactReader`, `Magnetic...`) mantém a normalização existente para
  `nfc`/`chip`/`magnetic`. Ausente ou numérico, inclusive `8` do exemplo da
  documentação, vira `null`: não inferimos enum e não invalidamos o comprovante.
  Parcelas ausentes ou zero normalizam para `1`.
- No cancelamento em PDV, o `panMask` tem de ser o do objeto `card`
  (`490721*********2003`, **com BIN**). O do `receipt`
  (`************2003`) faz o device recusar com **G004 "use the same card"**
  mesmo com o cartão correto — por isso o `receipt` carrega as duas máscaras.
- `POST /api/Cancel/` responde **200 com corpo vazio** em autosserviço.
- **PIX**: a Stone só habilita conta + chave PIX após a homologação. Antes
  disso o `Pix/Pay` responde `400 G999`. As funções existem em
  `src/autotef.js`, mas não há evento de PIX no contrato ainda.

## Estrutura

```
src/index.js    bootstrap: ativa o Slim e sobe o socket
src/agent.js    socket, contrato de eventos, lock e idempotência
src/autotef.js  cliente HTTP do Slim (pay, cancel, pinpad, pix)
src/config.js   env
src/logger.js   log de uma linha
deploy/         unit do systemd
```
