import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

// `--seed arquivo.json` embute um currículo inicial na versão gerada (uso pessoal).
// Sem a opção, o aplicativo abre em branco — é assim que o repositório é publicado.
const seedFlag = process.argv.indexOf('--seed');
let seed = 'null';
if (seedFlag > -1) {
  const path = process.argv[seedFlag + 1];
  if (!path) throw new Error('Informe o caminho do arquivo depois de --seed.');
  seed = JSON.stringify(JSON.parse(await readFile(path, 'utf8'))).replace(/</g, '\\u003c');
  console.log('Folium desktop: currículo inicial embutido de ' + path + '.');
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/desktop.js'], outfile: 'dist/desktop.js', bundle: true, format: 'iife', platform: 'browser', target: ['safari14', 'chrome105'], minify: true });
const html = await readFile('curriculo.html', 'utf8');
const insertion = '<script id="embedded-data" type="application/json">null</script>';
if (!html.includes(insertion)) throw new Error('Ponto de entrada do editor não encontrado.');
const withSeed = html.replace(insertion, '<script data-desktop src="desktop.js"></script>\n<script id="embedded-data" type="application/json">' + seed + '</script>');
await writeFile('dist/index.html', withSeed);
console.log('Folium desktop: interface e recursos preparados em dist/.');
