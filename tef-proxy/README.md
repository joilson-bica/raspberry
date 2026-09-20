# tef-proxy

Proxy reverso para o **AutoTEF Slim** (Stone) que roda no Raspberry Pi.

Arquivo único, **zero dependências** (só a stdlib do Node >= 18).

## Por que existe

O totem é servido por HTTPS e o AutoTEF só fala HTTP na rede local. O
navegador bloqueia essa chamada por **mixed content** — e isso acontece mesmo
com o CORS liberado (o Slim reflete o `Origin` corretamente).

```
Totem (HTTPS) ──► https://tef-<lavanderia>.promptpag.com  (tef-proxy, TLS)
                            │ http
                            ▼
                  http://127.0.0.1:8000  (AutoTEF Slim)
```

> **Importante:** o proxy só resolve o mixed content **se servir HTTPS com um
> certificado válido**. Um proxy em HTTP tem exatamente o mesmo problema do
> AutoTEF direto.

## Rodando

```bash
# desenvolvimento (HTTP, libera qualquer origem)
AUTOTEF_URL=http://raspberrypi.local:8000 PORT=8099 node index.js

# produção no Raspberry (HTTPS)
AUTOTEF_URL=http://127.0.0.1:8000 \
PORT=8443 \
TLS_KEY=/etc/letsencrypt/live/tef-piloto.promptpag.com/privkey.pem \
TLS_CERT=/etc/letsencrypt/live/tef-piloto.promptpag.com/fullchain.pem \
ALLOWED_ORIGINS=https://app-lavanderia.promptpag.com \
PROXY_TOKEN=<token> \
node index.js
```

## Variáveis de ambiente

| Variável | Default | Descrição |
|:--|:--|:--|
| `AUTOTEF_URL` | `http://127.0.0.1:8000` | Onde o Slim está ouvindo |
| `PORT` | `8443` | Porta do proxy |
| `HOST` | `0.0.0.0` | Interface de escuta |
| `TLS_KEY` / `TLS_CERT` | — | Chave e cadeia de certificados. Sem elas o proxy sobe em HTTP |
| `ALLOWED_ORIGINS` | `*` | Lista separada por vírgula. Origem fora da lista recebe 403 |
| `PROXY_TOKEN` | — | Se definido, exige o header `x-proxy-token` |
| `UPSTREAM_TIMEOUT_MS` | `700000` | Timeout para o Slim |

## Rotas

- `/api/*` → repassado para o AutoTEF (streaming, preserva método e corpo).
- `/_proxy/health` → saúde do **proxy** (não toca no Slim).
- Qualquer outra rota → 404.

## Detalhes de implementação

- **Não repassa o header `Origin`** e **remove os headers `Access-Control-*`
  da resposta do Slim**. Sem isso o navegador receberia
  `Access-Control-Allow-Origin` duplicado e recusaria a resposta.
- **Timeouts desligados no servidor** (`requestTimeout`/`timeout` em 0), porque
  `POST /api/Pay` espera o cliente inserir o cartão e digitar a senha, e
  `POST /api/Pix/Status` fica bloqueado até o pagamento ou a expiração do QR
  (~10 min).
- Erro de rede com o Slim volta como **502** no formato de erro do AutoTEF
  (`responseCode: "PRXY"`), então o cliente do totem trata igual aos demais.

## Obtendo o certificado

O Pi está em IP privado, então o desafio HTTP-01 do Let's Encrypt não
funciona. Duas saídas:

1. **DNS-01** — criar `tef-piloto.promptpag.com` apontando (registro A) para o
   IP local do Pi e emitir o certificado validando por DNS
   (`certbot certonly --manual --preferred-challenges dns`). Funciona porque a
   validação é no DNS, não no acesso à máquina. Requer IP fixo na LAN.
2. **Túnel** — `cloudflared` ou Tailscale expondo o Slim por um hostname
   HTTPS já certificado, dispensando este proxy.

Para a **homologação** nada disso é necessário: sirva o totem em
`http://localhost:3000` no próprio Pi e chame o AutoTEF direto.

## Rodar como serviço (systemd)

```ini
# /etc/systemd/system/tef-proxy.service
[Unit]
Description=Proxy HTTPS para o AutoTEF
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/tef-proxy/index.js
Environment=AUTOTEF_URL=http://127.0.0.1:8000
Environment=PORT=8443
Environment=TLS_KEY=/etc/letsencrypt/live/tef-piloto.promptpag.com/privkey.pem
Environment=TLS_CERT=/etc/letsencrypt/live/tef-piloto.promptpag.com/fullchain.pem
Environment=ALLOWED_ORIGINS=https://app-lavanderia.promptpag.com
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tef-proxy
```
