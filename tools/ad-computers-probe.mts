// SONDA SOMENTE LEITURA — computadores do Active Directory real.
//
// COMO RODAR (da raiz do projeto):
//     npx tsx tools/ad-computers-probe.mts
//
// Chama as funções DE PRODUÇÃO (`searchComputers`/`getComputer` de
// src/services/ad.service.ts), não uma reimplementação — é isso que faz
// desta sonda uma validação de verdade e não um teste paralelo que prova
// outra coisa. Nenhuma escrita: não chama `setComputerEnabled` em lugar
// nenhum, então nenhuma conta de computador é habilitada ou desabilitada.
//
// O QUE ESTA SONDA EXISTE PARA CONFRONTAR (ver docs/fake-ldap-rfc-vs-real.md):
//
//  1. `isDomainController` — a primeira versão derivava "é DC" pela AUSÊNCIA
//     do bit de workstation, o que classificava um RODC errado. O
//     `EA-SRV-AD01` é um controlador de domínio DE VERDADE: se a derivação
//     nova estiver certa, ele sai `true` aqui. Nenhum fake prova isso.
//  2. O `$` do sAMAccountName e a conciliação com o `cn`, contra os nomes
//     reais do domínio.
//  3. `paged: true` contra o MaxPageSize real do DC.
import 'dotenv/config';
import { getComputer, searchComputers } from '../src/services/ad.service.js';

const computers = await searchComputers();

console.log(`total de computadores no dominio: ${computers.length}\n`);

const linha = (v: string | boolean | null, n: number) => String(v ?? '-').padEnd(n).slice(0, n);
console.log(`${linha('NOME', 20)} ${linha('DC?', 6)} ${linha('ATIVO', 6)} ${linha('SISTEMA', 32)} DNS`);
console.log('-'.repeat(100));
for (const c of computers) {
  console.log(
    `${linha(c.name, 20)} ${linha(c.isDomainController, 6)} ${linha(c.enabled, 6)} ${linha(c.operatingSystem, 32)} ${c.dnsHostName ?? '-'}`,
  );
}

const dcs = computers.filter((c) => c.isDomainController === true);
const semUac = computers.filter((c) => c.enabled === null);

console.log(`\ncontroladores de dominio detectados: ${dcs.length}`);
for (const d of dcs) console.log(`  ${d.name}  (sAMAccountName=${d.sAMAccountName})`);
console.log(`computadores com userAccountControl ILEGIVEL: ${semUac.length}`);

// A conciliação do `$`: busca o primeiro computador pelas DUAS formas e
// confirma que caem no mesmo objeto. É a peculiaridade que não existe em
// usuário nem em grupo, e que aqui é medida contra nomes reais.
const alvo = computers[0];
if (alvo) {
  const semCifrao = await getComputer(alvo.name);
  const comCifrao = await getComputer(alvo.sAMAccountName);
  console.log(`\nconciliacao do "$" em "${alvo.name}":`);
  console.log(`  cn            -> ${semCifrao.dn}`);
  console.log(`  sAMAccountName-> ${comCifrao.dn}`);
  console.log(`  MESMO OBJETO? ${semCifrao.dn === comCifrao.dn}`);
}
