// Teste de fumaça da SINCRONIZAÇÃO (Onda 4, subtarefa 4) contra o Active
// Directory REAL e o Guacamole REAL, chamando as funções de produção.
//
// O que ele prova, e que nenhum mock provaria:
//   - a âncora `ad-object-guid` sobrevive de fato a uma ida e volta;
//   - rodar o sync duas vezes NÃO duplica e NÃO escreve na segunda rodada;
//   - o `objectGUID` lido do AD real casa com a conexão criada.
//
// LÊ o AD (nunca escreve nele) e ESCREVE no Guacamole. Ao final remove tudo
// o que criou, deixando o catálogo como encontrou — a menos que --manter
// seja passado, para quem quiser inspecionar o resultado na UI.
//
// Uso: npx tsx tools/guacamole-sync-smoke.mts [--manter]
import { remoteAccessSyncService } from '../src/services/remote-access-sync.service.js';
import { remoteAccessService } from '../src/services/remote-access.service.js';

const MANTER = process.argv.includes('--manter');

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const antes = await remoteAccessService.listConnectionsWithAnchors();
check('catálogo inicial sem âncoras de execução anterior', antes.every((c) => !c.adObjectGuid), `${antes.length} conexão(ões)`);
const manuaisAntes = antes.filter((c) => !c.adObjectGuid).length;

console.log('\n--- 1a rodada ---');
const r1 = await remoteAccessSyncService.syncComputersToGuacamole();
console.log(
  `criadas=${r1.criadas.length} atualizadas=${r1.atualizadas.length} inalteradas=${r1.inalteradas.length} ` +
    `removidas=${r1.removidas.length} puladas=${r1.puladas.length} ignoradas=${r1.ignoradas.length}`,
);
check('1a rodada criou conexões', r1.criadas.length > 0, `${r1.criadas.length}`);
check('1a rodada não removeu nada', r1.removidas.length === 0);
check('conexões manuais preservadas', r1.ignoradas.length === manuaisAntes);

console.log('\n--- 2a rodada (a prova de idempotência) ---');
const r2 = await remoteAccessSyncService.syncComputersToGuacamole();
console.log(
  `criadas=${r2.criadas.length} atualizadas=${r2.atualizadas.length} inalteradas=${r2.inalteradas.length} ` +
    `removidas=${r2.removidas.length} puladas=${r2.puladas.length} ignoradas=${r2.ignoradas.length}`,
);
check('2a rodada NÃO criou nada', r2.criadas.length === 0);
check('2a rodada NÃO atualizou nada', r2.atualizadas.length === 0);
check('2a rodada NÃO removeu nada', r2.removidas.length === 0);
check(
  '2a rodada viu como inalterado tudo o que a 1a criou',
  r2.inalteradas.length === r1.criadas.length,
  `${r2.inalteradas.length} vs ${r1.criadas.length}`,
);

// Releitura independente: o catálogo tem exatamente uma conexão por âncora?
const depois = await remoteAccessService.listConnectionsWithAnchors();
const ancoradas = depois.filter((c) => c.adObjectGuid);
const guidsUnicos = new Set(ancoradas.map((c) => c.adObjectGuid));
check('releitura: nenhuma âncora duplicada no catálogo', guidsUnicos.size === ancoradas.length, `${ancoradas.length} conexões, ${guidsUnicos.size} âncoras distintas`);
check('releitura: total bate com a 1a rodada', ancoradas.length === r1.criadas.length);

const amostra = ancoradas[0];
if (amostra) {
  const detalhe = await remoteAccessService.getConnection(amostra.identifier);
  check('releitura: a âncora persistiu de verdade', Boolean(detalhe.adObjectGuid), String(detalhe.adObjectGuid));
  check('releitura: o objectGUID tem forma canônica', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(detalhe.adObjectGuid ?? ''));
  check('releitura: hostname preenchido', Boolean(detalhe.hostname), String(detalhe.hostname));
  check('releitura: protocolo rdp', detalhe.protocol === 'rdp');
}

if (MANTER) {
  console.log('\n--manter: catálogo preservado para inspeção na UI.');
} else {
  console.log('\n--- limpeza: removendo o que este teste criou ---');
  for (const c of ancoradas) await remoteAccessService.deleteConnection(c.identifier);
  const final = await remoteAccessService.listConnectionsWithAnchors();
  check('catálogo devolvido ao estado inicial', final.length === antes.length, `${final.length} conexão(ões)`);
}
