import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const servidor = join(dirname(fileURLToPath(import.meta.url)), '..', 'servidor.js');

const exemplo = {
  versao: 3,
  densidade: '10.2',
  fonte: 'georgia',
  foto: '',
  nome: 'Ana Beatriz Martins',
  subtitulo: 'Analista de dados',
  contato: ['Recife/PE', '', 'ana@exemplo.com', ''],
  secoes: [
    { tipo: 'texto', titulo: 'Perfil', corpo: 'Analista com três anos de experiência.' },
    { tipo: 'entradas', titulo: 'Experiência Profissional', itens: [] },
  ],
};

async function comServidor(execucao) {
  const pasta = await mkdtemp(join(tmpdir(), 'folium-mcp-'));
  await writeFile(join(pasta, 'curriculo.json'), JSON.stringify(exemplo, null, 2));
  const cliente = new Client({ name: 'teste', version: '0' });
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [servidor],
    env: { ...process.env, FOLIUM_DATA_DIR: pasta },
  });
  await cliente.connect(transporte);
  const lerArquivo = async () => JSON.parse(await readFile(join(pasta, 'curriculo.json'), 'utf8'));
  try {
    await execucao({ cliente, pasta, lerArquivo });
  } finally {
    await cliente.close();
    await rm(pasta, { recursive: true, force: true });
  }
}

test('expõe as ferramentas e lê o currículo sem enviar a foto', async () => {
  await comServidor(async ({ cliente }) => {
    const { tools } = await cliente.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      ['atualizar_dados_pessoais', 'definir_secao', 'ler_curriculo', 'remover_secao'],
    );
    assert.equal(tools.find(t => t.name === 'ler_curriculo').annotations.readOnlyHint, true);

    const leitura = await cliente.callTool({ name: 'ler_curriculo', arguments: {} });
    const conteudo = leitura.content.map(c => c.text).join('\n');
    assert.match(conteudo, /Ana Beatriz Martins/);
    assert.match(conteudo, /"temFoto": false/);
    assert.doesNotMatch(conteudo, /"foto"/);
  });
});

test('atualiza dados pessoais preservando o que não foi enviado', async () => {
  await comServidor(async ({ cliente, lerArquivo }) => {
    await cliente.callTool({
      name: 'atualizar_dados_pessoais',
      arguments: { subtitulo: 'Cientista de dados' },
    });
    const salvo = await lerArquivo();
    assert.equal(salvo.subtitulo, 'Cientista de dados');
    assert.equal(salvo.nome, 'Ana Beatriz Martins');
    assert.equal(salvo.secoes.length, 2);
  });
});

test('cria e substitui seções, guardando a cópia de recuperação', async () => {
  await comServidor(async ({ cliente, pasta, lerArquivo }) => {
    await cliente.callTool({
      name: 'definir_secao',
      arguments: {
        titulo: 'Experiência Profissional',
        tipo: 'entradas',
        itens: [{ org: 'Estúdio Norte', cargo: 'Analista', periodo: '2025 – Atual', topicos: ['Construí painéis de acompanhamento.'] }],
      },
    });
    let salvo = await lerArquivo();
    const experiencia = salvo.secoes.find(s => s.titulo === 'Experiência Profissional');
    assert.equal(experiencia.itens.length, 1);
    assert.equal(experiencia.itens[0].org, 'Estúdio Norte');
    assert.equal(experiencia.itens[0].local, '', 'campos ausentes viram texto vazio, como o aplicativo espera');
    assert.equal(salvo.secoes.length, 2, 'substitui a seção existente em vez de duplicar');

    await cliente.callTool({ name: 'definir_secao', arguments: { titulo: 'Idiomas', tipo: 'texto', corpo: 'Inglês avançado.' } });
    salvo = await lerArquivo();
    assert.equal(salvo.secoes.length, 3);

    const recuperacao = JSON.parse(await readFile(join(pasta, 'curriculo.anterior.json'), 'utf8'));
    assert.equal(recuperacao.secoes.length, 2, 'a versão anterior fica guardada a cada gravação');
  });
});

test('remove seção e recusa remover o que não existe', async () => {
  await comServidor(async ({ cliente, lerArquivo }) => {
    await cliente.callTool({ name: 'remover_secao', arguments: { titulo: 'perfil' } });
    assert.equal((await lerArquivo()).secoes.length, 1, 'compara o título sem diferenciar maiúsculas');

    const erro = await cliente.callTool({ name: 'remover_secao', arguments: { titulo: 'Publicações' } });
    assert.equal(erro.isError, true);
    assert.match(erro.content[0].text, /Não existe seção/);
  });
});

test('recusa conteúdo que deixaria o currículo inválido', async () => {
  await comServidor(async ({ cliente, lerArquivo }) => {
    const erro = await cliente.callTool({
      name: 'atualizar_dados_pessoais',
      arguments: { contato: ['ok', 123] },
    });
    assert.equal(erro.isError, true);
    assert.equal((await lerArquivo()).contato[1], '', 'o arquivo permanece intacto');
  });
});

test('avisa quando ainda não existe currículo neste computador', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'folium-vazio-'));
  const cliente = new Client({ name: 'teste', version: '0' });
  await cliente.connect(new StdioClientTransport({
    command: process.execPath,
    args: [servidor],
    env: { ...process.env, FOLIUM_DATA_DIR: pasta },
  }));
  try {
    const erro = await cliente.callTool({ name: 'ler_curriculo', arguments: {} });
    assert.equal(erro.isError, true);
    assert.match(erro.content[0].text, /Abra o Folium ao menos uma vez/);
  } finally {
    await cliente.close();
    await rm(pasta, { recursive: true, force: true });
  }
});

test('segue o documento ativo apontado por estado.json', async () => {
  await comServidor(async ({ cliente, pasta }) => {
    await writeFile(join(pasta, 'marketing.json'), JSON.stringify({ ...exemplo, nome: 'Ana no marketing' }, null, 2));
    await writeFile(join(pasta, 'estado.json'), JSON.stringify({ ativo: 'marketing.json' }));
    const leitura = await cliente.callTool({ name: 'ler_curriculo', arguments: {} });
    assert.match(leitura.content[0].text, /Ana no marketing/);
  });
});
