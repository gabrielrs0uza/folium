#!/usr/bin/env node
// Servidor MCP do Folium: deixa a IA da própria pessoa ler e escrever o currículo
// que já está no computador dela. Não há rede, conta ou serviço no meio — apenas o
// mesmo arquivo que o aplicativo usa, com a mesma validação e a mesma gravação atômica.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const IDENTIFICADOR = 'com.folium.curriculum';
const LIMITE_ARQUIVO = 8_000_000;

function pastaDeDados() {
  if (process.env.FOLIUM_DATA_DIR) return process.env.FOLIUM_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', IDENTIFICADOR);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), IDENTIFICADOR);
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), IDENTIFICADOR);
}

// O documento ativo é apontado por estado.json quando existir mais de um currículo.
// Enquanto houver só um, é o curriculo.json de sempre.
async function arquivoAtivo() {
  const pasta = pastaDeDados();
  try {
    const estado = JSON.parse(await readFile(join(pasta, 'estado.json'), 'utf8'));
    const alvo = estado?.ativo;
    if (typeof alvo === 'string' && /^[\w-]+(\/[\w-]+)?\.json$/.test(alvo) && !alvo.includes('..')) {
      return join(pasta, alvo);
    }
  } catch {}
  return join(pasta, 'curriculo.json');
}

const texto = v => typeof v === 'string' && v.length <= 50_000;
const textos = (v, max) => Array.isArray(v) && v.length <= max && v.every(texto);

// Espelha a validação do aplicativo. O Folium valida de novo ao ler, então um erro aqui
// nunca chega a deixar o currículo em estado inválido.
function validar(d) {
  const secoesOk = Array.isArray(d?.secoes) && d.secoes.length <= 40 && d.secoes.every(s =>
    texto(s?.titulo) && (
      (s.tipo === 'texto' && texto(s.corpo)) ||
      (s.tipo === 'entradas' && Array.isArray(s.itens) && s.itens.length <= 100 && s.itens.every(i =>
        ['org', 'cargo', 'local', 'periodo'].every(k => texto(i?.[k])) && textos(i?.topicos, 100)))
    ));
  return texto(d?.nome) && texto(d?.subtitulo) && textos(d?.contato, 30) && typeof d?.foto === 'string' && secoesOk;
}

async function ler() {
  const caminho = await arquivoAtivo();
  let bruto;
  try {
    bruto = await readFile(caminho, 'utf8');
  } catch {
    throw new Error(`Nenhum currículo encontrado em ${caminho}. Abra o Folium ao menos uma vez para criá-lo.`);
  }
  const dados = JSON.parse(bruto);
  if (!validar(dados)) throw new Error('O arquivo do currículo não passou na validação. Abra o Folium e verifique.');
  return { caminho, dados };
}

// Mesmo padrão do aplicativo: cópia de recuperação, arquivo temporário e troca atômica.
async function gravar(caminho, dados) {
  if (!validar(dados)) throw new Error('A alteração deixaria o currículo inválido e por isso não foi gravada.');
  const conteudo = JSON.stringify(dados, null, 2);
  if (Buffer.byteLength(conteudo) > LIMITE_ARQUIVO) throw new Error('O currículo excedeu o limite de 8 MB.');
  try {
    const atual = await readFile(caminho, 'utf8');
    JSON.parse(atual);
    await writeFile(caminho.replace(/\.json$/, '.anterior.json'), atual);
  } catch {}
  const temporario = `${caminho}.mcp-${process.pid}`;
  await writeFile(temporario, conteudo);
  try {
    await rename(temporario, caminho);
  } catch (erro) {
    await unlink(temporario).catch(() => {});
    throw erro;
  }
}

// A foto é um data URI de centenas de milhares de caracteres: nunca vai para o modelo,
// e nenhuma ferramenta a altera.
function semFoto({ foto, ...resto }) {
  return { ...resto, temFoto: Boolean(foto) };
}

function resumo(dados) {
  const linhas = [
    `# ${dados.nome || '(sem nome)'}`,
    dados.subtitulo && `_${dados.subtitulo}_`,
    dados.contato.filter(c => c.trim()).join(' · '),
    '',
  ].filter(Boolean);
  for (const secao of dados.secoes) {
    linhas.push(`## ${secao.titulo}`);
    if (secao.tipo === 'texto') {
      linhas.push(secao.corpo || '_(vazia)_');
    } else if (!secao.itens.length) {
      linhas.push('_(vazia)_');
    } else {
      for (const item of secao.itens) {
        linhas.push(`- **${item.org || '(sem título)'}**${item.periodo ? ` · ${item.periodo}` : ''}`);
        if (item.cargo || item.local) linhas.push(`  ${[item.cargo, item.local].filter(Boolean).join(' · ')}`);
        for (const topico of item.topicos.filter(t => t.trim())) linhas.push(`  - ${topico}`);
      }
    }
    linhas.push('');
  }
  return linhas.join('\n');
}

const resposta = (dados, aviso) => ({
  content: [
    { type: 'text', text: aviso ? `${aviso}\n\n${resumo(dados)}` : resumo(dados) },
    { type: 'text', text: '```json\n' + JSON.stringify(semFoto(dados), null, 2) + '\n```' },
  ],
});

const servidor = new McpServer(
  { name: 'folium', version: '0.1.0' },
  { instructions: 'Lê e edita o currículo guardado pelo aplicativo Folium neste computador. Sempre leia o currículo antes de alterar, e escreva em português do Brasil, com frases curtas começando por verbo.' },
);

servidor.registerTool(
  'ler_curriculo',
  {
    title: 'Ler o currículo',
    description: 'Devolve o currículo atual do Folium: dados pessoais, contatos e todas as seções. A foto não é incluída.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const { dados } = await ler();
    return resposta(dados);
  },
);

servidor.registerTool(
  'atualizar_dados_pessoais',
  {
    title: 'Atualizar dados pessoais',
    description: 'Altera nome, título profissional e contatos. Só os campos informados mudam; os demais permanecem.',
    inputSchema: {
      nome: z.string().max(200).optional().describe('Nome completo, como a pessoa assina'),
      subtitulo: z.string().max(400).optional().describe('Título profissional, ex.: "Estudante de Direito — Contencioso Cível"'),
      contato: z.array(z.string().max(200)).max(30).optional().describe('Cidade, telefone, e-mail e LinkedIn, nessa ordem'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ nome, subtitulo, contato }) => {
    const { caminho, dados } = await ler();
    if (nome !== undefined) dados.nome = nome;
    if (subtitulo !== undefined) dados.subtitulo = subtitulo;
    if (contato !== undefined) dados.contato = contato;
    await gravar(caminho, dados);
    return resposta(dados, 'Dados pessoais atualizados.');
  },
);

const itemSchema = z.object({
  org: z.string().max(300).default('').describe('Empresa, escritório ou instituição'),
  cargo: z.string().max(300).default('').describe('Cargo, curso ou função'),
  local: z.string().max(200).default('').describe('Cidade e estado'),
  periodo: z.string().max(120).default('').describe('Ex.: "Jan 2026 – Atual"'),
  topicos: z.array(z.string().max(2000)).max(100).default([]).describe('Atividades e resultados, começando por verbo'),
});

servidor.registerTool(
  'definir_secao',
  {
    title: 'Criar ou substituir uma seção',
    description: 'Cria uma seção nova ou substitui o conteúdo de uma existente (comparando pelo título). Use "texto" para Perfil, Idiomas e Competências, e "entradas" para Experiência, Formação e Cursos. O conteúdo enviado substitui o anterior por completo — leia o currículo antes.',
    inputSchema: {
      titulo: z.string().min(1).max(200).describe('Título da seção, ex.: "Experiência Profissional"'),
      tipo: z.enum(['texto', 'entradas']).describe('"texto" para um parágrafo, "entradas" para uma lista de experiências'),
      corpo: z.string().max(50_000).optional().describe('Conteúdo quando o tipo for "texto"'),
      itens: z.array(itemSchema).max(100).optional().describe('Itens quando o tipo for "entradas"'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ titulo, tipo, corpo, itens }) => {
    const { caminho, dados } = await ler();
    const nova = tipo === 'texto'
      ? { tipo, titulo, corpo: corpo ?? '' }
      : { tipo, titulo, itens: (itens ?? []).map(i => ({ ...i })) };
    const indice = dados.secoes.findIndex(s => s.titulo.toLocaleLowerCase('pt-BR') === titulo.toLocaleLowerCase('pt-BR'));
    if (indice >= 0) dados.secoes[indice] = nova;
    else dados.secoes.push(nova);
    await gravar(caminho, dados);
    return resposta(dados, indice >= 0 ? `Seção "${titulo}" atualizada.` : `Seção "${titulo}" criada.`);
  },
);

servidor.registerTool(
  'remover_secao',
  {
    title: 'Remover uma seção',
    description: 'Remove uma seção inteira do currículo. A versão anterior fica guardada na cópia de recuperação do Folium.',
    inputSchema: { titulo: z.string().min(1).max(200).describe('Título exato da seção a remover') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ titulo }) => {
    const { caminho, dados } = await ler();
    const antes = dados.secoes.length;
    dados.secoes = dados.secoes.filter(s => s.titulo.toLocaleLowerCase('pt-BR') !== titulo.toLocaleLowerCase('pt-BR'));
    if (dados.secoes.length === antes) throw new Error(`Não existe seção chamada "${titulo}".`);
    await gravar(caminho, dados);
    return resposta(dados, `Seção "${titulo}" removida.`);
  },
);

servidor.registerResource(
  'curriculo',
  'folium://curriculo',
  { title: 'Currículo do Folium', description: 'O currículo ativo, em JSON, sem a foto.', mimeType: 'application/json' },
  async uri => {
    const { dados } = await ler();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(semFoto(dados), null, 2) }] };
  },
);

await servidor.connect(new StdioServerTransport());
