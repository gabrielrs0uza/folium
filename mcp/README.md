# folium-mcp

Servidor [MCP](https://modelcontextprotocol.io) do [Folium](../README.md). Ele deixa a IA que
você já usa ler e editar o currículo guardado pelo aplicativo **neste computador**.

Nada vai para a internet: o servidor roda na sua máquina, por stdio, e mexe no mesmo arquivo que o
Folium usa — com a mesma validação e a mesma gravação atômica, preservando a cópia de recuperação.
A foto nunca é enviada ao modelo nem alterada.

## Conectar

Antes de publicar no npm, aponte para o arquivo local:

```sh
# Claude Code
claude mcp add folium -- node /caminho/para/folium/mcp/servidor.js
```

Depois de publicado, o mesmo comando fica assim:

```sh
claude mcp add folium -- npx -y folium-mcp
```

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "folium": { "command": "npx", "args": ["-y", "folium-mcp"] }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`, no mesmo formato. VS Code, Windsurf, Zed, Cline e os
demais clientes usam esse mesmo bloco, cada um no seu arquivo de configuração.

Não há autenticação, e isso é de propósito: o servidor não escuta rede nenhuma. Quem o inicia é o
seu próprio assistente, como um processo seu, com as suas permissões — a fronteira de segurança é a
sua conta no sistema. Autenticação em MCP existe para servidores remotos, acessados por HTTP.

## Ferramentas

| Ferramenta | O que faz |
| --- | --- |
| `ler_curriculo` | Devolve o currículo em texto e em JSON, sem a foto. Somente leitura. |
| `atualizar_dados_pessoais` | Altera nome, título profissional e contatos. Só os campos enviados mudam. |
| `definir_secao` | Cria uma seção ou substitui o conteúdo de uma existente, comparando pelo título. |
| `remover_secao` | Remove uma seção inteira. |

Também há o recurso `folium://curriculo`, com o currículo em JSON para os clientes que preferem ler
recursos a chamar ferramentas.

Exemplos do que dizer ao assistente:

- "Leia meu currículo e sugira o que enxugar para caber em uma página."
- "Adiciona na experiência: Estúdio Norte, analista, de janeiro de 2026 até hoje, com três atividades."
- "Reescreve meu perfil em três linhas, com foco em vagas de dados."

## Onde ele procura o currículo

| Sistema | Pasta |
| --- | --- |
| macOS | `~/Library/Application Support/com.folium.curriculum/` |
| Windows | `%APPDATA%\com.folium.curriculum\` |
| Linux | `~/.local/share/com.folium.curriculum/` |

Quando existir mais de um currículo, `estado.json` aponta qual é o ativo, e o servidor segue esse
apontamento. `FOLIUM_DATA_DIR` sobrescreve a pasta — é o que os testes usam.

O Folium precisa ter sido aberto ao menos uma vez para o arquivo existir. Com o aplicativo aberto,
ele avisa quando o currículo muda por fora e oferece recarregar, em vez de sobrescrever o que você
estiver digitando.

## Desenvolvimento

```sh
npm install
npm test
```

Os testes sobem o servidor de verdade por stdio, com um cliente MCP real e uma pasta de dados
temporária.
