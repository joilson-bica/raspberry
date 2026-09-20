# tef-agent

Agente que roda no **Raspberry Pi do totem**. Recebe eventos do backend por
socket e executa a transação no **pinpad** através do AutoTEF Slim (Stone).

Node >= 18, uma única dependência (`socket.io-client`), **sem build**.

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

Desenvolvimento (Node >= 20.6):

```bash
cp .env.example .env
node --env-file=.env src/index.js
```

## Variáveis de ambiente

| Variável | Default | Descrição |
|:--|:--|:--|
| `BACKEND_URL` | — | **Obrigatória.** Ex.: `https://api-lavanderia.promptpag.com` |
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

- **Nunca sonda durante uma transação.** `probeHealth()` devolve o cache na
  hora se houver algo em andamento — inclusive quando o backend pede.
- **O heartbeat não toca no device.** A cada 30s o agente publica
  `tef.status` com o **último estado conhecido** e a idade dele
  (`healthAgeMs`). É presença no socket, não sondagem no pinpad.
- **A transação é o melhor healthcheck.** Um `Pay` aprovado prova que o
  device responde. O agente só marca "preciso reconsultar" quando o erro
  sugere perda de comunicação (`AGENT_UNREACHABLE`, `G002`).

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
| `tef.pinpad.message` | `{ message, secondMessage?, formatMessage? }` | `{ ok }` |
| `tef.healthcheck` | — | `{ ok, health, busy }` |

`method`: `debit` \| `credit`. `amount` em **reais** (float, ex.: `25.80`).
`installments > 1` usa parcelamento **lojista** (sem juros para o cliente).

### Agente → backend

| Evento | Quando | Payload |
|:--|:--|:--|
| `tef.status` | ao conectar e a cada 30s | `{ agentId, laundryId, activated, busy, stoneCode, hasPixKey, ... }` |
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

- **Uma transação por vez.** O pinpad é recurso único; um segundo `tef.pay`
  concorrente recebe `AGENT_BUSY` em vez de embaralhar o device.
- **Idempotência.** Os últimos 50 `requestId` ficam em memória: reenvio do
  mesmo `requestId` devolve o resultado guardado, sem cobrar de novo.
- **Ativação antes de conectar.** O agente só entra no socket com o Slim
  ativado — o backend nunca recebe um agente que responderia `G002`.

> A idempotência é **em memória**: reiniciar o agente esquece os `requestId`.
> Para cobrança duplicada ser impossível mesmo com restart, o backend deve
> checar se o `Payment` já saiu de `pending` antes de reemitir.

## Particularidades do AutoTEF (validadas em homologação)

- `POST /api/Pay` responde **envelopado** em `{ receipt, card }`; a doc mostra
  os campos na raiz.
- `cardReadingType` é **texto** (`EMVProximityReader` = NFC,
  `EMVContactReader` = chip), não número. O agente normaliza para
  `nfc`/`chip`.
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
