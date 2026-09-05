# Folium

Editor de currículo offline para Windows e macOS. Você preenche os campos à esquerda, a folha A4 se ajusta à direita e o PDF sai pronto para enviar. Sem conta, sem nuvem, sem telemetria: o currículo fica no seu computador.

*Folium* é “folha”, em latim.

## O que ele faz

- **Um modelo clássico, de uma coluna**, inspirado no formato de currículo de Harvard: datas junto de cada experiência e texto selecionável no PDF, o que sistemas de recrutamento leem sem tropeçar.
- **Prévia fiel em A4**, com indicador de quando o conteúdo passa de uma página e ajuste de espaçamento.
- **Tema claro, escuro ou acompanhando o sistema**, incluindo a janela nativa. A folha do currículo continua branca nos três — é ela que vai ser impressa.
- **Seções livres**: experiência, formação, cursos, idiomas, competências ou qualquer seção que você criar, com reordenação e desfazer.
- **Saídas**: PDF pela impressão do sistema, backup em JSON e uma cópia editável em HTML que abre com dois cliques em qualquer computador, sem instalar nada.
- **Offline de verdade**: nenhum conteúdo remoto, nenhuma requisição de rede, nenhuma conta.

## Usar

Baixe o instalador em [Releases](../../releases) ou compile a partir do código (abaixo).

- **macOS**: abra o DMG e arraste **Folium** para **Aplicativos**.
- **Windows**: execute `Folium_…_x64-setup.exe`. A instalação é por usuário; se o WebView2 estiver ausente, o instalador baixa o componente da Microsoft e, depois disso, o aplicativo funciona offline.
- **Sem instalar**: abra `curriculo.html` no navegador. O mesmo editor funciona a partir do arquivo, salvando o rascunho no navegador. Veja [LEIA-ME.md](LEIA-ME.md).

Para gerar o PDF: **Exportar PDF**, escolher **Salvar como PDF** (macOS) ou **Microsoft Print to PDF** (Windows), papel A4 e escala 100%.

## Onde ficam os dados

| Sistema | Pasta |
| --- | --- |
| macOS | `~/Library/Application Support/com.folium.curriculum/` |
| Windows | `%APPDATA%\com.folium.curriculum\` |

`curriculo.json` guarda a versão atual e `curriculo.anterior.json` a última versão válida. Cada gravação escreve em um arquivo temporário na mesma pasta e faz a substituição atômica; se a leitura falhar, o aplicativo tenta a cópia anterior e, se ambas falharem, bloqueia a edição e oferece a recuperação por backup — nada é redefinido em silêncio.

Os arquivos são locais e não são criptografados pelo Folium. Não há sincronização entre computadores: use **Guardar backup** para transferir. A janela tem acesso apenas aos comandos necessários, e caminhos de importação e exportação vêm sempre de diálogos nativos.

## Desenvolvimento

Requer Node.js 22+, Rust estável e as [dependências oficiais do Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run dev
```

`curriculo.html` é a fonte da interface e de todo o comportamento compartilhado entre o navegador e o aplicativo. `scripts/build.mjs` prepara `dist/` e injeta a integração Tauri (`src/desktop.js`), empacotada pelo esbuild. Ao exportar uma cópia HTML, essa integração é removida e o arquivo resultante continua independente.

```sh
npm test          # fila de salvamento (node:test)
npm run build     # gera dist/
cargo test --locked --manifest-path src-tauri/Cargo.toml
npx playwright install chromium
npm run test:ui   # editor no Chromium: persistência, backup, cópia portátil
```

Para usar um Chromium já instalado, configure `FOLIUM_BROWSER_PATH`.

Teste de integração no WebView real (usa identificação e pasta de dados próprias):

```sh
npm run desktop:build -- --debug --features smoke-test --config src-tauri/tauri.smoke.conf.json --no-bundle
node scripts/native-smoke.mjs
```

A feature `smoke-test` nunca deve ser ativada em um instalador de distribuição: o comando de relatório não existe no executável normal e sua permissão só está habilitada na configuração de teste.

### Currículo inicial embutido

O aplicativo publicado abre **em branco**. Para gerar uma versão pessoal já preenchida — um presente para alguém, por exemplo — exporte um backup pelo próprio editor e compile com ele:

```sh
npm run build -- --seed private/curriculo.json
npm run desktop:build -- --bundles dmg
```

O arquivo é embutido apenas na versão gerada. Mantenha-o fora do repositório (`private/` está no `.gitignore`) e não publique instaladores com dados pessoais de outra pessoa.

## Conectar sua IA (MCP)

O diretório [`mcp/`](mcp/README.md) traz um servidor MCP local: a IA que você já usa passa a ler e
editar o currículo guardado neste computador — sem rede, sem conta, mexendo no mesmo arquivo que o
aplicativo usa. É opcional e independente do Folium funcionar.

```sh
claude mcp add folium -- node ./mcp/servidor.js
```

## Gerar instaladores

```sh
# macOS Apple Silicon
npm run desktop:build -- --bundles app,dmg

# macOS universal (Apple Silicon + Intel)
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --target universal-apple-darwin --bundles dmg

# Windows
npm run desktop:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

O workflow **Instaladores do Folium** compila e testa os dois sistemas a cada push na `main`.

### Assinatura

Esta versão usa assinatura ad-hoc no macOS e não possui certificado de distribuição Windows: o binário roda localmente, mas o Gatekeeper pode pedir aprovação e o SmartScreen pode alertar sobre um aplicativo sem reputação. Para distribuir sem esse atrito, configure um certificado Developer ID com notarização Apple e um certificado de assinatura Windows — veja [macOS](https://tauri.app/distribute/sign/macos/) e [Windows](https://tauri.app/distribute/sign/windows/). Não desative as proteções do sistema.

## Licença

[MIT](LICENSE).

---

**In English** — Folium is an offline résumé editor for Windows and macOS, built with Tauri. It ships with a single-column, Harvard-style template, live A4 preview, PDF export through the system print dialog, JSON backups and a self-contained HTML copy. No account, no cloud, no telemetry: the document is stored on your computer. The interface is in Brazilian Portuguese.
