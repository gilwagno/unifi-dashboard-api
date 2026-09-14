// SONDA SOMENTE LEITURA contra o Active Directory real.
//
// COMO RODAR (da raiz do projeto):
//     npx tsx tools/ad-nesting-probe.mts
//
// Lê as credenciais do `.env` (as mesmas `AD_*` que o módulo já usa).
// Faz APENAS `search` — nenhum `add`, `modify` ou `delete`. Não altera nada
// no diretório e não escreve em disco.
//
// PARA QUE SERVE: responder, com número em vez de estimativa, quantas
// pessoas têm acesso à rede por HERANÇA (membership num grupo aninhado
// dentro do `wifi-colaboradores`) e por isso NÃO seriam revogadas pelo
// dashboard, que opera sobre membership DIRETA. É o dado que dimensiona a
// Decisão 2 (bloqueante do aninhamento de grupos, ver CLAUDE.md).
//
// O QUE ESTA SONDA **NÃO** RESPONDE: se a Network Policy de 802.1X do NPS
// usa o `wifi-colaboradores` como condição "Grupos de Windows". Isso NÃO
// fica no Active Directory — fica na configuração local do servidor NPS.
// Esse gate só fecha abrindo o `nps.msc` no EA-SRV-AD01.
import 'dotenv/config';
import { Client } from 'ldapts';
import { readFileSync } from 'node:fs';

const url = process.env.AD_URL;
const bindDn = process.env.AD_BIND_DN;
const bindPassword = process.env.AD_BIND_PASSWORD;
if (!url || !bindDn || !bindPassword) {
  console.error('Faltam AD_URL / AD_BIND_DN / AD_BIND_PASSWORD no .env');
  process.exit(1);
}

const ca = process.env.AD_TLS_CA_FILE ? [readFileSync(process.env.AD_TLS_CA_FILE)] : undefined;
const client = new Client({ url, tlsOptions: { ca } });

// Ajuste aqui se o grupo de acesso à rede for outro.
const GRUPO = 'CN=wifi-colaboradores,OU=TI,OU=EvokAudio,DC=evokaudio,DC=local';

await client.bind(bindDn, bindPassword);
try {
  const { searchEntries } = await client.search(GRUPO, {
    scope: 'base',
    attributes: ['member', 'whenChanged', 'description', 'groupType'],
  });
  const grupo = searchEntries[0] as unknown as Record<string, string | string[]> | undefined;
  if (!grupo) {
    console.log(`GRUPO NAO ENCONTRADO: ${GRUPO}`);
    process.exit(0);
  }

  const raw = grupo.member;
  const membros: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  console.log(`grupo .............. ${GRUPO}`);
  console.log(`whenChanged ........ ${grupo.whenChanged}`);
  console.log(`membros diretos .... ${membros.length}`);
  console.log(`atributos lidos .... ${Object.keys(grupo).join(', ')}`);

  // Se o AD tiver devolvido `member;range=`, a lista acima está TRUNCADA e
  // qualquer contagem abaixo seria mentira. Melhor gritar que estimar.
  const ranged = Object.keys(grupo).some((k) => k.toLowerCase().startsWith('member;range='));
  if (ranged) {
    console.log('\n!! RANGE RETRIEVAL detectado: a lista de membros veio TRUNCADA.');
    console.log('!! Os numeros abaixo NAO valem. Seria preciso paginar o atributo.');
  }

  let usuarios = 0;
  let outros = 0;
  const aninhados: Array<{ dn: string; n: number }> = [];

  for (const dn of membros) {
    const r = await client.search(dn, { scope: 'base', attributes: ['objectClass', 'member'] });
    const e = r.searchEntries[0] as unknown as Record<string, string | string[]> | undefined;
    const ocRaw = e?.objectClass;
    const oc: string[] = Array.isArray(ocRaw) ? ocRaw : ocRaw ? [ocRaw] : [];
    if (oc.includes('group')) {
      const mRaw = e?.member;
      const m: string[] = Array.isArray(mRaw) ? mRaw : mRaw ? [mRaw] : [];
      aninhados.push({ dn, n: m.length });
    } else if (oc.includes('user')) {
      usuarios++;
    } else {
      outros++;
    }
  }

  console.log(`\nDIRETOS: ${usuarios} usuarios nominais, ${aninhados.length} grupos aninhados, ${outros} outros`);

  if (aninhados.length > 0) {
    console.log('\nGRUPOS ANINHADOS (cada um traz seus membros por heranca):');
    let herdados = 0;
    for (const a of aninhados.sort((x, y) => y.n - x.n)) {
      console.log(`  ${String(a.n).padStart(3)} membros   ${a.dn}`);
      herdados += a.n;
    }
    console.log(`\nTOTAL com acesso por HERANCA (1 nivel de aninhamento): ${herdados}`);
    console.log(`=> ${herdados} pessoas que o dashboard NAO revogaria por membership direta.`);
    console.log('   (1 nivel apenas: se algum desses grupos tiver grupos DENTRO, o numero real e maior.)');
  } else {
    console.log('\nNenhum grupo aninhado. A revogacao por membership direta seria determinística.');
  }
} finally {
  await client.unbind();
}
