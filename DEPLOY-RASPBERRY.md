# Raspberry Pi — configuração do totem Dona Chica

Este guia configura **somente o Raspberry Pi**, considerando backend e frontend já publicados. Os comandos são para o terminal Linux do Pi, não para o Windows.

No Pi rodam:

1. **AutoTEF Slim:** serviço da Stone que conversa com o pinpad USB/serial.
2. **tef-agent:** recebe solicitações do backend e chama o Slim localmente.
3. **Chromium:** abre o frontend publicado em modo quiosque.

Não instale backend, Postgres, Adminer, Mosquitto, `admin/` ou `tef-proxy` para este fluxo. Não é necessário Docker. O agente será gerenciado pelo **systemd**, inclusive no boot; não inicie outra cópia pelo PM2 ou pelo terminal.

## 1. Dados que você precisa ter

| Configuração | Valor para este totem |
|---|---|
| Lavanderia | Dona Chica Lavanderia |
| `LAUNDRY_ID` | `2f092271-3372-41ed-9626-4a5afc2ef99f` |
| `AGENT_ID` | `dona-chica-totem-01` — exclusivo deste Pi |
| Backend de produção | `https://api-lavanderia.promptpag.com` |
| Frontend de produção | `https://app-lavanderia.promptpag.com` |
| AutoTEF local | `http://127.0.0.1:8000` |
| Token do agente | O mesmo valor de `TEF_AGENT_TOKEN` no backend |
| StoneCode | Código do estabelecimento fornecido pela Stone |
| Parceiro / modo PDV | Devem corresponder à instalação do Slim |
| Porta do pinpad | Confirmar no Pi; normalmente `/dev/ttyACM0` |

Se estiver usando homologação, troque **as duas URLs públicas** pelas versões com `-hml` e use o token/credenciamento daquele ambiente. Não coloque `:4000` nem `/tef` em `BACKEND_URL`: a conexão usa HTTPS pelo proxy e o agente já define o caminho `/tef`.

O frontend publicado deve usar o mesmo UUID da lavanderia, backend habilitado e pagamento `auto`, não `autotef` direto. Essas configurações pertencem ao deploy do frontend; não são definidas no Chromium nem em um `.env` do frontend no Pi.

## 2. Sistema, rede e Node.js

Use **Raspberry Pi OS 64-bit com Desktop**, compatível com o pacote AutoTEF fornecido pela Stone. Prefira rede cabeada e uma fonte de alimentação adequada.

Confira arquitetura, usuário e relógio:

```bash
uname -m
whoami
timedatectl status
sudo timedatectl set-ntp true
```

Em uma imagem ARM64, `uname -m` normalmente mostra `aarch64`. O relógio correto é necessário para HTTPS e pagamentos.

Instale ferramentas básicas e Node.js 22 LTS. Exemplo com o repositório NodeSource para Debian/Raspberry Pi OS compatível:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo bash /tmp/nodesource_setup_22.sh
sudo apt install -y nodejs
node --version
npm --version
command -v node
```

Revise o script baixado antes de executá-lo como root. Se já existe Node.js 22 LTS instalado, não é necessário reinstalar. O agente aceita Node >= 18, mas este guia recomenda uma linha LTS ainda suportada. Guarde o caminho mostrado por `command -v node`: ele será usado no serviço systemd.

O Pi precisa de saída para HTTPS do frontend/backend e para os serviços exigidos pela Stone. **Não faça encaminhamento de portas no roteador.** Mantenha a API do Slim local e não exponha a porta 8000 na internet. SSH, se usado, deve ficar restrito ao acesso administrativo.

## 3. AutoTEF e pinpad

O executável, a licença e o instalador do AutoTEF **não estão neste repositório**. Se o Slim ainda não estiver instalado, obtenha da Stone o pacote compatível com a arquitetura do Pi e siga a instalação/credenciamento do fornecedor antes de prosseguir.

O serviço de exemplo assume o nome `autotef.service`. Confirme o nome real:

```bash
systemctl list-unit-files --type=service
systemctl status autotef.service --no-pager
systemctl show autotef.service -p User -p Group -p ExecStart
ls -l /dev/ttyACM* /dev/ttyUSB* /dev/serial/by-id/
```

Alguns dos caminhos seriais podem não existir; use o dispositivo que realmente corresponde ao pinpad. Se o serviço do Slim tiver outro nome, substitua `autotef.service` em todos os comandos e na unit do agente.

A conta que executa **o Slim** precisa de acesso à serial. Se necessário, adicione essa conta ao grupo proprietário do dispositivo, normalmente `dialout`:

```bash
sudo usermod -aG dialout USUARIO_QUE_EXECUTA_O_SLIM
```

Substitua `USUARIO_QUE_EXECUTA_O_SLIM` pelo usuário real. Reinicie o serviço do Slim, sem pagamentos em andamento, para aplicar o grupo. O `tef-agent` acessa o Slim por HTTP; não abre a serial diretamente. Evite `chmod 777` ou `chmod a+rw` no dispositivo.

Com o pinpad conectado e o Slim instalado:

```bash
sudo systemctl enable --now autotef.service
curl --max-time 20 -i http://127.0.0.1:8000/api/Healthcheck
```

Faça essa consulta pontual **sem transação em andamento**, não em um loop. Se o Slim responder que falta ativação (`G002`), preencha o agente corretamente: ele fará a ativação no startup. Falha de conexão indica que o Slim ainda não está acessível.

Confirme no ambiente do Slim:

- StoneCode correto para homologação ou produção; não reutilize automaticamente o código de sandbox do `.env.example`.
- `PARTNER_NAME` igual ao parceiro configurado no Slim; o exemplo do projeto usa `Joilson Leal Bica`, mas deve prevalecer o valor da instalação.
- `AUTOTEF_IS_PDV` igual ao `IsPdv` do `appsettings.json` do Slim.
- Ambiente de homologação/produção do Slim conforme o credenciamento da Stone.
- Somente o Slim acessando o pinpad. Não abra simultaneamente a tela antiga de ativação direta do frontend.

## 4. Instalar o repositório do Pi

O repositório desta pasta contém `tef-agent/` e `tef-proxy/`. Neste guia ele será clonado em `/opt/promptpag-pi`; somente o agente será instalado.

Para a primeira instalação, substitua `URL_DO_REPOSITORIO_RASPBERRY` pela URL real do seu Git. O diretório de destino deve estar vazio ou ainda não existir. Se já houver instalação, use a seção de atualização, sem sobrescrever arquivos locais.

```bash
sudo mkdir -p /opt/promptpag-pi
sudo chown "$(id -un):$(id -gn)" /opt/promptpag-pi
git clone URL_DO_REPOSITORIO_RASPBERRY /opt/promptpag-pi
cd /opt/promptpag-pi/tef-agent
npm install --omit=dev
npm run check
```

**Não há build do agente:** ele executa `src/index.js` diretamente. Este repositório ainda não contém `tef-agent/package-lock.json`; por isso a primeira instalação usa `npm install`, não `npm ci`. Guarde o lockfile gerado e versione-o após revisão para reproduzir as mesmas versões em outros Pis. Com um lockfile disponível e consistente, use `npm ci --omit=dev` nas instalações seguintes.

## 5. Configurar o ambiente do agente

Os segredos ficarão em **`/etc/tef-agent.env`**, fora do Git e legíveis somente por root. O systemd carrega o arquivo antes de iniciar o processo com o usuário configurado na unit.

Na primeira instalação:

```bash
cd /opt/promptpag-pi/tef-agent
if [ ! -e /etc/tef-agent.env ]; then
  sudo install -o root -g root -m 600 .env.example /etc/tef-agent.env
fi
sudoedit /etc/tef-agent.env
```

Preencha com os valores abaixo, substituindo os três placeholders e ajustando a serial/modo PDV se necessário:

```env
BACKEND_URL=https://api-lavanderia.promptpag.com
AGENT_TOKEN=SUBSTITUA_PELO_TEF_AGENT_TOKEN_DO_BACKEND
AGENT_ID=dona-chica-totem-01
LAUNDRY_ID=2f092271-3372-41ed-9626-4a5afc2ef99f

AUTOTEF_URL=http://127.0.0.1:8000
STONE_CODE=SUBSTITUA_PELO_STONE_CODE_DO_ESTABELECIMENTO
PARTNER_NAME="SUBSTITUA_PELO_PARCEIRO_CONFIGURADO_NO_SLIM"
PINPAD_PORT=/dev/ttyACM0
AUTOTEF_IS_PDV=true
ACTIVATE_ON_BOOT=true

HEALTHCHECK_MODE=lazy
HEALTHCHECK_MIN_INTERVAL_MS=600000
HEALTHCHECK_MIN_GAP_MS=60000
HEARTBEAT_MS=30000

TIMEOUT_QUICK_MS=15000
TIMEOUT_ACTIVATE_MS=120000
TIMEOUT_TRANSACTION_MS=180000
TIMEOUT_PIX_STATUS_MS=660000
RESULT_CACHE_SIZE=50
LOG_LEVEL=info
```

- **Não gere um token diferente:** `AGENT_TOKEN` deve ser exatamente o `TEF_AGENT_TOKEN` já configurado no backend.
- Um segundo Pi deve ter outro `AGENT_ID`. O UUID da lavanderia pode continuar igual quando os totens pertencem à mesma unidade.
- `AUTOTEF_IS_PDV=true` é apenas o exemplo compatível com o arquivo do projeto; se o Slim usa `IsPdv=false`, configure `false`.
- Os timeouts e intervalos são em **milissegundos**. Os valores acima correspondem aos padrões do código.
- Mantenha `HEALTHCHECK_MODE=lazy`: o heartbeat não precisa conversar com a serial a cada envio.
- `TIMEOUT_PIX_STATUS_MS` existe no cliente HTTP, mas **o contrato atual backend/agente não implementa pagamento PIX**. Valide inicialmente débito/crédito.
- Não coloque `DATABASE_URL`, `JWT_SECRET` ou variáveis `NEXT_PUBLIC_*` neste arquivo.

Confira apenas as permissões, sem imprimir o token:

```bash
sudo chown root:root /etc/tef-agent.env
sudo chmod 600 /etc/tef-agent.env
sudo stat -c '%U:%G %a %n' /etc/tef-agent.env
```

## 6. Iniciar automaticamente com systemd

A unit fornecida em `tef-agent/deploy/tef-agent.service` assume `/opt/tef-agent`. **Esse caminho precisa mudar**, pois aqui o clone contém a subpasta `tef-agent`.

Crie/edite a unit no Pi:

```bash
sudoedit /etc/systemd/system/tef-agent.service
```

Conteúdo para este layout:

```ini
[Unit]
Description=PromptPag - agente TEF Dona Chica
After=network-online.target autotef.service
Wants=network-online.target autotef.service

[Service]
Type=simple
User=pi
WorkingDirectory=/opt/promptpag-pi/tef-agent
ExecStart=/usr/bin/node /opt/promptpag-pi/tef-agent/src/index.js
EnvironmentFile=/etc/tef-agent.env
Environment=NODE_ENV=production
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Antes de salvar:

1. Troque `User=pi` pelo usuário real obtido com `whoami`, se não for `pi`.
2. Confira `ExecStart`: use o caminho absoluto do Node mostrado por `command -v node`. O systemd não carrega automaticamente o ambiente interativo do NVM.
3. Se o serviço do Slim tiver outro nome, altere-o em **`After` e `Wants`**.
4. O usuário do serviço precisa conseguir ler o código e acessar o diretório do agente.

Ative e confira:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tef-agent.service
systemctl is-enabled tef-agent.service
systemctl status tef-agent.service --no-pager
sudo journalctl -u tef-agent.service -n 100 --no-pager
```

O agente tenta ativar o Slim antes de conectar ao backend. `After` ordena os serviços, mas não garante que a API HTTP do Slim já esteja pronta; se a inicialização falhar, o systemd tentará novamente. Não execute `npm start` ou `pm2 start` em paralelo ao serviço.

## 7. Chromium em modo quiosque

Se o Pi também controla a tela do totem, instale o Chromium disponível na sua imagem:

```bash
sudo apt install -y chromium
command -v chromium
```

Se sua imagem disponibilizar somente o pacote/binário `chromium-browser`, use esse nome no lugar de `chromium` nos comandos desta seção. Execute o navegador com o usuário da sessão gráfica, **nunca como root**.

Teste no terminal da própria área de trabalho do Pi:

```bash
chromium --kiosk --incognito --noerrdialogs --autoplay-policy=no-user-gesture-required https://app-lavanderia.promptpag.com
```

O Chromium só abre a URL já publicada. Não é necessário clonar ou fazer build do frontend no Pi. O parâmetro de autoplay permite as narrações sem exigir um primeiro clique; não use flags para desabilitar TLS, a segurança web ou o sandbox.

Para voltar automaticamente após ligar o Pi, configure no `sudo raspi-config`:

- Inicialização na área de trabalho com login automático do usuário do totem.
- Desativação do apagamento automático da tela, se apropriado ao equipamento.

Escolha **uma** das opções abaixo conforme a sessão gráfica. Consulte `echo "$XDG_SESSION_TYPE"` no terminal da área de trabalho; em SSH o valor pode estar vazio.

### Sessão X11 com autostart XDG/LXDE

```bash
mkdir -p ~/.config/autostart
nano ~/.config/autostart/promptpag-totem.desktop
```

```ini
[Desktop Entry]
Type=Application
Name=Totem Dona Chica
Exec=chromium --kiosk --incognito --noerrdialogs --autoplay-policy=no-user-gesture-required https://app-lavanderia.promptpag.com
Terminal=false
X-GNOME-Autostart-enabled=true
```

### Sessão Wayland com labwc

Se sua imagem usa labwc, edite o arquivo de autostart do usuário e **acrescente** a linha, preservando o conteúdo que já existe:

```bash
mkdir -p ~/.config/labwc
nano ~/.config/labwc/autostart
```

```bash
chromium --kiosk --incognito --noerrdialogs --autoplay-policy=no-user-gesture-required https://app-lavanderia.promptpag.com &
```

Não configure as duas opções ao mesmo tempo. Se a sessão usar outro compositor, configure o autostart correspondente ao sistema instalado em vez de presumir que labwc/XDG será executado. Confirme o resultado com um reboot sem pagamento em andamento; se a rede ainda não estiver pronta quando a tela abrir, use o botão de recarregar do totem.

## 8. Validar a instalação no Pi

Faça as consultas abaixo a partir do Pi:

```bash
curl --max-time 15 -i https://api-lavanderia.promptpag.com/status
curl --max-time 15 -i https://api-lavanderia.promptpag.com/laundries/2f092271-3372-41ed-9626-4a5afc2ef99f
sudo journalctl -u tef-agent.service -f
```

Confira:

- A lavanderia retornada é **Dona Chica Lavanderia**.
- O log mostra a ativação ou que o AutoTEF já estava ativado, e a conexão do agente ao backend.
- Em `/status`, `services.tef.connectedAgents` fica maior que zero. Esse número confirma o socket, **não garante sozinho** que o pinpad esteja apto.
- O backend também precisa estar com banco/MQTT disponíveis. Um 503 por essas dependências não se resolve instalando serviços adicionais no Pi.
- A tela do totem usa a lavanderia correta e permite cadastrar/identificar um cliente real.

Por último, faça um teste acompanhado com cartão de homologação no ambiente de homologação. Em produção, um pagamento de teste pode gerar cobrança real: execute somente com autorização e com o pinpad presente. No fluxo atual, a máquina paga deve aparecer em uso pelo tempo definido no backend (padrão 30 minutos para lavagem e 45 para secagem).

O Pi não envia comandos às lavadoras/secadoras. **Máquina livre no sistema não significa hardware instalado:** o acionamento físico ainda depende dos ESP32, MQTT e vínculos de dispositivo/canal configurados fora do Pi.

Teste o boot somente quando não houver transação em andamento:

```bash
sudo reboot
```

Após voltar, confira o agente por SSH e o Chromium na tela. O agente deve iniciar independentemente do login gráfico; o navegador depende da sessão Desktop com autologin.

## 9. Operação e atualização

Logs e estado:

```bash
systemctl status tef-agent.service --no-pager
sudo journalctl -u tef-agent.service -f
```

Após editar somente o ambiente:

```bash
sudoedit /etc/tef-agent.env
sudo systemctl restart tef-agent.service
```

Para atualizar o código, sem pagamentos em andamento:

```bash
sudo systemctl stop tef-agent.service
cd /opt/promptpag-pi
git pull --ff-only
cd tef-agent
npm ci --omit=dev
npm run check
sudo systemctl start tef-agent.service
sudo journalctl -u tef-agent.service -n 100 --no-pager
```

Use `npm ci` nessa atualização apenas se o lockfile estiver disponível e consistente com o `package.json`; se ainda não estiver, use `npm install --omit=dev`. Se o Git informar conflito, preserve as alterações locais e resolva antes de continuar. Não reinicie o agente no meio de um pagamento: o pinpad é exclusivo e o cache de resultados do agente é apenas em memória.

## 10. Diagnóstico rápido

| Sintoma | Conferir no Pi |
|---|---|
| Serviço não inicia | Node e caminhos absolutos, usuário da unit e variáveis obrigatórias em `/etc/tef-agent.env` |
| `AutoTEF inacessível` | Serviço do Slim, porta 8000 local e `AUTOTEF_URL` |
| Pinpad não encontrado | Cabo/energia, porta serial e permissões do usuário que executa o Slim |
| `G002` / falha na ativação | Credenciamento, ambiente, StoneCode, parceiro e `ACTIVATE_ON_BOOT=true` |
| Socket desconecta ou não aparece no backend | `BACKEND_URL`, token igual ao backend, UUID correto, internet/relógio e proxy com suporte a WebSocket `/tef` |
| `Terminal indisponível` no totem | Agente conectado mas não apto, falha de healthcheck/ativação, `LAUNDRY_ID` divergente ou pinpad ocupado |
| Chromium não abre no boot | Desktop autologin, compositor, arquivo de autostart e nome real do executável |
| Pagamento aprovado, máquina não liga | Vínculo ESP32/canal e MQTT no backend; não é função do `tef-agent` |

Guarde o token apenas no arquivo protegido. Ao compartilhar logs para diagnóstico, remova informações sensíveis de clientes/transações. Este guia não executa o deploy: os comandos devem ser aplicados e validados no Raspberry Pi real.
