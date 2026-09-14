// SONDA SOMENTE LEITURA — confirma um grupo no Active Directory real.
//
// COMO RODAR (da raiz do projeto):
//     npx tsx tools/ad-group-probe.mts wifi-dashboard
//
// Chama as funções DE PRODUÇÃO (`searchGroups`/`getGroup`), não uma
// reimplementação. Só `search` — nenhuma escrita.
//
// Existe para confirmar, antes de apontar `AD_NETWORK_ACCESS_GROUP_DN` para
// um objeto de produção, que ele: (a) existe, (b) tem o DN que se espera, e
// (c) qual é a composição de membros — em particular se tem GRUPOS
// aninhados, que é o que quebraria a revogação determinística que a
// Decisão 2 existe para garantir.
import 'dotenv/config';
import { getGroup, searchGroups } from '../src/services/ad.service.js';

const nome = process.argv[2] ?? 'wifi-dashboard';

const achados = await searchGroups(nome);
console.log(`grupos que casam "${nome}": ${achados.length}`);
for (const g of achados) console.log(`  ${g.dn}`);

if (achados.length === 0) {
  console.log('\nNAO ENCONTRADO — o grupo ainda nao existe no dominio.');
  process.exit(0);
}

const g = await getGroup(nome);
console.log(`\ndn ............. ${g.dn}`);
console.log(`descricao ...... ${g.description ?? '-'}`);
console.log(`membros ........ ${g.members.length}`);

const detalhes = g.memberDetails ?? [];
const grupos = detalhes.filter((m) => m.type === 'group');
const usuarios = detalhes.filter((m) => m.type === 'user');
const desconhecidos = detalhes.filter((m) => m.type === 'unknown');

for (const m of detalhes) console.log(`  [${m.type.padEnd(7)}] ${m.name}`);

console.log(`\nusuarios diretos ..... ${usuarios.length}`);
console.log(`grupos aninhados ..... ${grupos.length}`);
console.log(`nao resolvidos ....... ${desconhecidos.length}`);

if (grupos.length === 0) {
  console.log('\nOK: sem aninhamento — a revogacao pelo dashboard e DETERMINISTICA.');
} else {
  console.log('\nATENCAO: ha grupo aninhado. A revogacao direta NAO alcanca quem herda daqui.');
}
