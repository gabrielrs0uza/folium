import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';

// A pasta de dados da build de teste, onde o aplicativo guarda o currículo do teste.
function pastaDoTeste() {
  const identificador = 'com.folium.curriculum.smoketest';
  const base = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(base, identificador, 'integration-test');
}

// Escreve no arquivo por fora, como faria o servidor MCP com o aplicativo aberto.
async function alterarPorFora() {
  const documento = join(pastaDoTeste(), 'curriculo.json');
  for (let tentativa = 0; tentativa < 40; tentativa++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const dados = JSON.parse(await readFile(documento, 'utf8'));
      if (!dados.nome?.includes('teste de integração')) continue;
      // O aplicativo só recarrega sozinho quando ninguém está no meio de uma edição.
      // Esperar aqui é o que separa a alteração externa da edição feita pelo próprio teste.
      await new Promise(r => setTimeout(r, 6000));
      dados.nome = 'Alterado por fora';
      const temporario = documento + '.externo';
      await writeFile(temporario, JSON.stringify(dados, null, 2));
      await rename(temporario, documento);
      return true;
    } catch { /* o aplicativo ainda não gravou o arquivo */ }
  }
  throw Error('O aplicativo não gravou o currículo do teste a tempo');
}
const directory = await mkdtemp(join(tmpdir(), 'folium-native-'));
const report = join(directory, 'report.json');
const executable = resolve('src-tauri/target/debug/' + (process.platform === 'win32' ? 'folium.exe' : 'folium'));
const child = spawn(executable, [], { env: { ...process.env, FOLIUM_SMOKE_REPORT: report }, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 60000);
const externo = alterarPorFora().catch(erro => erro);
try {
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const result = JSON.parse(await readFile(report, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || !result.ok) throw Error('Falha no teste do aplicativo nativo');
} finally {
  clearTimeout(timer);
  const resultadoExterno = await externo;
  if (resultadoExterno instanceof Error) console.error(resultadoExterno.message);
  await rm(directory, { recursive: true, force: true });
}
