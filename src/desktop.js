import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { createSaveQueue } from './save-queue.js';

if (window.__TAURI_INTERNALS__) {
  // No macOS a barra de título é sobreposta ao conteúdo: a interface reserva o espaço dos controles.
  document.documentElement.classList.add('app-nativo');
  if (navigator.userAgent.includes('Mac OS X')) document.documentElement.classList.add('mac-overlay');
  const queue = createSaveQueue(data => invoke('save_curriculum', { data }));
  let closing = false;
  window.FoliumDesktop = {
    load: () => invoke('load_curriculum'),
    save: data => queue.save(data),
    flush: () => queue.flush(),
    listDocuments: () => invoke('document_state'),
    createDocument: (nome, data) => invoke('create_document', { nome, data }),
    renameDocument: (arquivo, nome) => invoke('rename_document', { arquivo, nome }),
    deleteDocument: arquivo => invoke('delete_document', { arquivo }),
    switchDocument: arquivo => invoke('switch_document', { arquivo }),
    exportFile: (content, fileName, kind) => invoke('export_file', { content, fileName, kind }),
    importBackup: () => invoke('import_backup'),
    print: async () => { await queue.flush(); return invoke('print_curriculum'); },
    // A janela precisa saber o tema: dela dependem os semáforos, os menus nativos
    // e a cor de fundo que aparece antes do WebView pintar.
    setTheme: tema => invoke('definir_tema', { tema }),
  };
  // O menu nativo pede à interface o que ela já sabe fazer.
  listen('menu', evento => window.dispatchEvent(new CustomEvent('folium-menu', { detail: evento.payload })))
    .catch(error => console.error('Não foi possível ouvir o menu:', error));
  // O documento pode mudar por fora: pelo servidor MCP, por outra cópia do app ou por uma pasta sincronizada.
  listen('curriculo-mudou', () => window.dispatchEvent(new CustomEvent('folium-mudou-por-fora')))
    .catch(error => console.error('Não foi possível observar o currículo:', error));
  getCurrentWindow().onCloseRequested(async event => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    const app = document.querySelector('.app');
    if (app) app.inert = true;
    try {
      await queue.flush();
      await getCurrentWindow().destroy();
    } catch {
      closing = false;
      if (app) app.inert = false;
      window.dispatchEvent(new CustomEvent('folium-save-error', {
        detail: 'Não foi possível salvar. O Folium continuará aberto para você guardar um backup.',
      }));
    }
  }).catch(error => console.error('Não foi possível registrar o fechamento da janela:', error));
}
