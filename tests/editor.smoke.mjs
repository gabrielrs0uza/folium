import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const html = await readFile('curriculo.html');
const server = createServer((_, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.FOLIUM_BROWSER_PATH || undefined });
const directory = await mkdtemp(join(tmpdir(), 'folium-ui-'));
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByLabel('Nome completo', { exact: true }).fill('Ana & <teste>');
  assert.equal(await page.locator('.cv-name').textContent(), 'Ana & <teste>');
  await page.reload();
  assert.equal(await page.getByLabel('Nome completo', { exact: true }).inputValue(), 'Ana & <teste>');
  await page.getByRole('button', { name: 'Mais opções', exact: true }).click();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Salvar cópia editável', exact: true }).click();
  const portable = join(directory, 'curriculo.html');
  await (await event).saveAs(portable);
  const offline = await browser.newContext({ offline: true });
  const copy = await offline.newPage();
  await copy.goto(pathToFileURL(portable).href);
  assert.equal(await copy.getByLabel('Nome completo', { exact: true }).inputValue(), 'Ana & <teste>');
  await offline.close();
  console.log('PASS: browser persistence and portable HTML offline');

  await page.getByRole('button', { name: 'Nova seção', exact: true }).click();
  await page.getByLabel('Título', { exact: true }).fill('Projetos');
  await page.getByRole('button', { name: 'Criar seção', exact: true }).click();
  await page.locator('#editorTitle').filter({ hasText: 'Projetos' }).waitFor();
  assert.equal(await page.locator('.nav-item', { hasText: 'Projetos' }).count(), 1, 'a new section joins the sidebar');
  assert.equal(await page.locator('.add-button').last().textContent(), 'Adicionar item');
  await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
  assert.equal(await page.locator('.nav-item', { hasText: 'Projetos' }).count(), 0, 'undo removes a section that was just created');

  await page.getByRole('button', { name: 'Nova seção', exact: true }).click();
  await page.getByLabel('Título', { exact: true }).fill('Voluntariado');
  await page.getByRole('button', { name: 'Texto corrido', exact: true }).click();
  await page.getByRole('button', { name: 'Criar seção', exact: true }).click();
  await page.getByRole('textbox', { name: 'Voluntariado', exact: true }).fill('Mutirão de currículos.');
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('cv-folium-v3')).secoes.at(-1)),
    { tipo: 'texto', titulo: 'Voluntariado', corpo: 'Mutirão de currículos.' },
    'each shape of section is stored the way its editor writes it');
  console.log('PASS: sections can be created in both shapes, and undone');

  await page.locator('.nav-item', { hasText: 'Informações pessoais' }).click();
  await page.locator('#cv .cv-section', { hasText: 'Mutirão de currículos.' }).click();
  assert.equal(await page.locator('#editorTitle').textContent(), 'Voluntariado', 'clicking a block on the sheet opens its section');
  await page.locator('#cv .cv-header').click();
  assert.equal(await page.locator('#editorTitle').textContent(), 'Informações pessoais');
  await page.getByRole('button', { name: 'Próxima seção', exact: true }).click();
  await page.getByRole('button', { name: 'Seção anterior', exact: true }).click();
  assert.equal(await page.locator('#editorTitle').textContent(), 'Informações pessoais');
  assert.ok(await page.getByRole('button', { name: 'Seção anterior', exact: true }).isHidden(), 'the first screen has nothing before it');
  console.log('PASS: the sheet and the editor footer navigate between sections');

  const olhar = () => page.evaluate(() => ({
    escala: +new DOMMatrix(getComputedStyle(document.getElementById('paper')).transform).a.toFixed(4),
    rotulo: document.getElementById('zoomLevel').textContent,
    largura: Math.round(document.getElementById('paperFrame').getBoundingClientRect().width),
    ampliado: document.getElementById('paperFrame').classList.contains('ampliado'),
  }));
  const ajustado = await olhar();
  assert.equal(ajustado.rotulo, Math.round(ajustado.escala * 100) + '%');
  assert.equal(ajustado.ampliado, false);
  await page.locator('#zoomIn').click();
  const aproximado = await olhar();
  assert.ok(aproximado.escala > ajustado.escala, 'the plus button enlarges the sheet');
  assert.equal(aproximado.largura, ajustado.largura, 'the frame keeps its size while the sheet grows inside it');
  assert.ok(await page.evaluate(() => {
    const f = document.getElementById('paperFrame');
    return f.scrollHeight > f.clientHeight + 4;
  }), 'the enlarged sheet scrolls inside the frame');
  await page.locator('#paperFrame').hover();
  const rolagem = await page.evaluate(() => window.scrollY);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  assert.ok((await olhar()).escala > aproximado.escala, 'a trackpad pinch enlarges the sheet further');
  assert.equal(await page.evaluate(() => window.scrollY), rolagem, 'the pinch zooms the sheet without scrolling the page');
  await page.locator('#zoomLevel').click();
  assert.deepEqual(await olhar(), ajustado, 'the percentage goes back to fitting the column');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('paper')).transform), 'none', 'print ignores the zoom');
  await page.emulateMedia({ media: 'screen' });
  console.log('PASS: preview zoom by buttons, percentage and trackpad pinch');

  const native = await browser.newContext();
  await native.addInitScript(() => {
    window.mock = { saved: null, exports: [], cancel: false, broken: false, printed: false };
    window.FoliumDesktop = {
      load: async () => ({ data: null, recovered: false }),
      save: async data => { window.mock.saved = structuredClone(data); },
      exportFile: async (...args) => { window.mock.exports.push(args); return !window.mock.cancel; },
      importBackup: async () => ({ ...structuredClone(window.mock.saved), nome: 'Backup importado' }),
      print: async () => { window.mock.printed = true; },
    };
  });
  const app = await native.newPage();
  app.on('pageerror', e => errors.push(e.message));
  await app.goto(url);
  await app.locator('#saveText').filter({ hasText: 'Salvo neste computador' }).waitFor();
  await app.getByLabel('Nome completo', { exact: true }).fill('Ana no desktop');
  await app.waitForFunction(() => window.mock.saved?.nome === 'Ana no desktop');
  await app.evaluate(() => window.mock.cancel = true);
  await app.getByRole('button', { name: 'Mais opções', exact: true }).click();
  await app.getByRole('button', { name: 'Abrir backup', exact: true }).click();
  await app.getByRole('button', { name: 'Guardar o atual e abrir backup', exact: true }).click();
  assert.equal(await app.getByLabel('Nome completo', { exact: true }).inputValue(), 'Ana no desktop');
  assert.equal(await app.locator('dialog[open]').count(), 1);
  await app.evaluate(() => window.mock.cancel = false);
  await app.getByRole('button', { name: 'Guardar o atual e abrir backup', exact: true }).click();
  await app.locator('dialog').waitFor({ state: 'hidden' });
  assert.equal(await app.getByLabel('Nome completo', { exact: true }).inputValue(), 'Backup importado');
  await app.getByRole('button', { name: 'Exportar PDF', exact: true }).click();
  await app.getByRole('button', { name: 'Continuar para salvar PDF', exact: true }).click();
  await app.waitForFunction(() => window.mock.printed);
  console.log('PASS: desktop adapter, cancel preserves original, restore and native print');

  const docs = await browser.newContext();
  await docs.addInitScript(() => {
    const registro = new Map([['curriculo.json', { nome: 'Currículo', data: null }]]);
    let ativo = 'curriculo.json';
    const listar = () => ({ ativo, documentos: [...registro].map(([arquivo, d]) => ({ arquivo, nome: d.nome })) });
    const montar = () => ({ documentos: listar(), carregado: { data: registro.get(ativo).data, recovered: false } });
    window.FoliumDesktop = {
      load: async () => ({ data: registro.get(ativo).data, recovered: false }),
      save: async data => { registro.get(ativo).data = structuredClone(data); },
      flush: async () => {},
      exportFile: async () => true,
      importBackup: async () => null,
      print: async () => {},
      listDocuments: async () => listar(),
      createDocument: async (nome, data) => {
        const arquivo = `doc-${registro.size}.json`;
        registro.set(arquivo, { nome, data: structuredClone(data) });
        ativo = arquivo;
        return montar();
      },
      renameDocument: async (arquivo, nome) => { registro.get(arquivo).nome = nome; return listar(); },
      deleteDocument: async arquivo => {
        registro.delete(arquivo);
        if (ativo === arquivo) ativo = [...registro.keys()][0];
        return montar();
      },
      switchDocument: async arquivo => { ativo = arquivo; return montar(); },
    };
  });
  const painel = await docs.newPage();
  painel.on('pageerror', e => errors.push(e.message));
  await painel.goto(url);
  await painel.getByLabel('Nome completo', { exact: true }).fill('Currículo jurídico de Ana');
  await painel.waitForFunction(() => document.getElementById('saveText').textContent === 'Salvo neste computador');
  assert.equal(await painel.locator('#docTitle').textContent(), 'Currículo');

  await painel.locator('#docSwitchButton').click();
  await painel.locator('#docSwitchMenu').getByRole('button', { name: 'Novo currículo', exact: true }).click();
  await painel.getByLabel('Nome do currículo', { exact: true }).fill('Currículo de marketing');
  await painel.getByRole('button', { name: 'Criar currículo', exact: true }).click();
  await painel.locator('dialog').waitFor({ state: 'hidden' });
  assert.equal(await painel.getByLabel('Nome completo', { exact: true }).inputValue(), '', 'a new document starts blank, not a copy of the current one');
  assert.equal(await painel.locator('#docTitle').textContent(), 'Currículo de marketing');

  await painel.locator('#docSwitchButton').click();
  await painel.locator('#docSwitchMenu').getByRole('button', { name: 'Currículo', exact: true }).click();
  assert.equal(await painel.getByLabel('Nome completo', { exact: true }).inputValue(), 'Currículo jurídico de Ana', 'switching back finds the first document exactly as it was');

  await painel.locator('#docSwitchButton').click();
  await painel.locator('#docSwitchMenu').getByRole('button', { name: 'Renomear currículo atual', exact: true }).click();
  await painel.getByLabel('Nome', { exact: true }).fill('Currículo jurídico');
  await painel.getByRole('button', { name: 'Salvar nome', exact: true }).click();
  await painel.locator('dialog').waitFor({ state: 'hidden' });
  assert.equal(await painel.locator('#docTitle').textContent(), 'Currículo jurídico', 'renaming the active document updates the switcher label immediately');

  await painel.locator('#docSwitchButton').click();
  await painel.locator('#docSwitchMenu').getByRole('button', { name: 'Excluir currículo atual', exact: true }).click();
  await painel.getByRole('button', { name: 'Excluir currículo', exact: true }).click();
  await painel.locator('dialog').waitFor({ state: 'hidden' });
  assert.equal(await painel.locator('#docTitle').textContent(), 'Currículo de marketing', 'deleting the active document falls back to another one');

  await painel.locator('#docSwitchButton').click();
  assert.equal(await painel.locator('#docSwitchMenu').getByRole('button', { name: 'Excluir currículo atual' }).count(), 0, 'the last remaining document cannot be deleted');
  console.log('PASS: document switcher creates, switches, renames and deletes documents');

  const broken = await browser.newContext();
  await broken.addInitScript(() => {
    window.FoliumDesktop = { load: async () => { throw Error('Arquivo danificado'); }, save: async () => { throw Error('Should not write'); } };
  });
  const recovery = await broken.newPage();
  recovery.on('pageerror', e => errors.push(e.message));
  await recovery.goto(url);
  await recovery.getByRole('heading', { name: 'Vamos recuperar seu currículo' }).waitFor();
  assert.equal(await recovery.locator('.app').getAttribute('inert'), '');
  await recovery.keyboard.press('Escape');
  assert.equal(await recovery.locator('dialog[open]').count(), 1);
  console.log('PASS: unreadable data blocks editing rather than overwriting');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
