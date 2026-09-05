// Runs only in builds with the explicit smoke-test Cargo feature.
(async () => {
  const waitFor = async predicate => {
    for(let i=0;i<200;i++) { if(await predicate())return; await new Promise(r=>setTimeout(r,100)); }
    throw new Error('Tempo limite aguardando o editor nativo');
  };
  const result = { ok: false, checks: [] };
  try {
    await waitFor(()=>document.querySelector('#editorBody input') && window.FoliumDesktop);
    result.checks.push('Interface carregada no WebView nativo');
    const input=document.querySelector('#editorBody input');
    input.value='Folium — teste de integração';input.dispatchEvent(new Event('input',{bubbles:true}));
    await waitFor(()=>document.getElementById('saveText').textContent==='Salvo neste computador');
    const saved=await window.FoliumDesktop.load();
    if(saved.data.nome!==input.value)throw new Error('A alteração não foi persistida');
    result.checks.push('Edição salva e reaberta pelo backend Rust');
    if(!document.querySelector('.cv-name').textContent.includes('teste de integração'))throw new Error('Prévia desatualizada');
    result.checks.push('Prévia atualizada');
    // O script que iniciou o aplicativo altera o arquivo por fora neste momento, como faria
    // o servidor MCP. A janela precisa recarregar sozinha, sem ninguém clicar em nada.
    await waitFor(()=>document.querySelector('.cv-name').textContent.includes('Alterado por fora'));
    result.checks.push('Alteração externa recarregada sozinha');
    // Currículos salvos: cria um segundo documento pelo mesmo caminho que o app usa, alterna
    // entre eles e confirma que cada arquivo guarda o seu próprio conteúdo no disco.
    const atual = await window.FoliumDesktop.load();
    const listaInicial = await window.FoliumDesktop.listDocuments();
    if (listaInicial.documentos.length !== 1) throw new Error('Deveria haver um único currículo antes deste teste');
    const primeiro = listaInicial.ativo;
    const criado = await window.FoliumDesktop.createDocument('Currículo de teste', { ...atual.data, nome: 'Segundo currículo' });
    if (criado.documentos.documentos.length !== 2) throw new Error('O novo currículo não entrou na lista');
    if (criado.carregado.data.nome !== 'Segundo currículo') throw new Error('O currículo criado não carregou o conteúdo enviado');
    result.checks.push('Novo currículo criado e ativado pelo backend Rust');
    const voltou = await window.FoliumDesktop.switchDocument(primeiro);
    if (voltou.carregado.data.nome !== atual.data.nome) throw new Error('Voltar ao primeiro currículo não recuperou o conteúdo original');
    result.checks.push('Troca de currículo preserva o conteúdo de cada um');
    const segundoArquivo = criado.documentos.documentos.find(d => d.arquivo !== primeiro).arquivo;
    const excluido = await window.FoliumDesktop.deleteDocument(segundoArquivo);
    if (excluido.documentos.documentos.length !== 1) throw new Error('A exclusão não removeu o currículo da lista');
    if (excluido.carregado.data.nome !== atual.data.nome) throw new Error('Excluir o currículo ativo devia voltar para o outro currículo');
    result.checks.push('Currículo excluído e o restante recuperado automaticamente');
    result.ok=true;
  } catch(error) { result.error=String(error); }
  const { invoke }=window.__TAURI_INTERNALS__;
  await invoke('smoke_result',{result});
})();
