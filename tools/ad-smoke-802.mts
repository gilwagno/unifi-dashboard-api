// TESTE DE FUMAÇA SUPERVISIONADO da ponte 802.1X contra o AD REAL.
//
//     npx tsx tools/ad-smoke-802.mts <passo>
//     passos: criar | ler | grant | revoke | apagar
//
// UM passo por execução, de propósito: cada um é confirmado por RELEITURA
// INDEPENDENTE antes do seguinte. Nunca rodar tudo de uma vez.
//
// A releitura NÃO usa a função que fez a escrita — abre uma conexão LDAP
// própria e lê o atributo `member` do grupo direto do diretório. É a
// diferença entre "o comando foi aceito" (resultCode 0) e "o estado
// mudou": o teste de fumaça de 2026-09-11 achou um bug de produção
// justamente porque conferiu o segundo.
//
// Só opera sobre a CONTA DESCARTÁVEL abaixo. Qualquer passo que fosse
// tocar outro objeto deve ser abortado.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client } from 'ldapts';
import { createUser, deleteUser, getUser, grantNetworkAccess, revokeNetworkAccess } from '../src/services/ad.service.js';

const CONTA = 'teste-wifi-dash';
const NOME = 'Teste Wifi Dashboard';

const grupoDn = process.env.AD_NETWORK_ACCESS_GROUP_DN!;

/**
 * RELEITURA INDEPENDENTE: conexão própria, lê `member` do grupo direto do
 * diretório. Não passa por `ad.service.ts` — se o serviço tivesse um bug de
 * leitura, esta função não o herdaria.
 */
async function lerMembrosDoGrupo(): Promise<string[]> {
  const ca = process.env.AD_TLS_CA_FILE ? [readFileSync(process.env.AD_TLS_CA_FILE)] : undefined;
  const client = new Client({ url: process.env.AD_URL!, tlsOptions: { ca } });
  await client.bind(process.env.AD_BIND_DN!, process.env.AD_BIND_PASSWORD!);
  try {
    const { searchEntries } = await client.search(grupoDn, { scope: 'base', attributes: ['member'] });
    const raw = (searchEntries[0] as unknown as Record<string, unknown> | undefined)?.member;
    if (raw === undefined) return [];
    return (Array.isArray(raw) ? raw : [raw]).map((v) => String(v));
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

async function mostrarGrupo(rotulo: string) {
  const membros = await lerMembrosDoGrupo();
  console.log(`\n--- RELEITURA INDEPENDENTE (${rotulo}) ---`);
  console.log(`grupo: ${grupoDn}`);
  console.log(`membros: ${membros.length}`);
  for (const m of membros) console.log(`  ${m}`);
  // O CN do DN vem do `sAMAccountName` (CONTA), NÃO do `displayName`. Uma
  // versão anterior desta linha comparava contra o displayName e devolvia
  // "NAO" para uma membership que a lista acima mostrava existindo — ou
  // seja, leria um SUCESSO como falha. A lista crua de membros é a prova;
  // esta linha é só conveniência, e por isso tem que casar o mesmo valor
  // que o diretório de fato grava.
  const nossa = membros.some((m) => m.toLowerCase().startsWith(`cn=${CONTA.toLowerCase()},`));
  console.log(`\na conta de teste esta no grupo? ${nossa ? 'SIM' : 'NAO'}`);
  return { membros, nossa };
}

const passo = process.argv[2];

switch (passo) {
  case 'criar': {
    // Senha aleatória descartável: nunca impressa, nunca reutilizada. A
    // conta é apagada no último passo.
    const senha = `Tmp-${Math.abs(Date.now() % 1_000_000)}-${'Xq7'}!aZ`;
    const criado = await createUser({ sAMAccountName: CONTA, displayName: NOME, password: senha });
    console.log(`criado: ${criado.dn}`);
    console.log(`enabled: ${criado.enabled}`);
    await mostrarGrupo('deve estar VAZIO — a conta acabou de nascer');
    break;
  }
  case 'ler': {
    const u = await getUser(CONTA);
    console.log(`conta: ${u.dn}  enabled=${u.enabled}  lockedOut=${u.lockedOut}`);
    await mostrarGrupo('estado atual');
    break;
  }
  case 'grant': {
    await grantNetworkAccess(CONTA);
    console.log('grantNetworkAccess() retornou sem erro.');
    console.log('(o retorno NAO e a prova — a prova e a releitura abaixo)');
    await mostrarGrupo('deve conter a conta de teste');
    break;
  }
  case 'revoke': {
    await revokeNetworkAccess(CONTA);
    console.log('revokeNetworkAccess() retornou sem erro.');
    console.log('(o retorno NAO e a prova — a prova e a releitura abaixo)');
    await mostrarGrupo('NAO deve mais conter a conta de teste');
    break;
  }
  case 'apagar': {
    await deleteUser(CONTA);
    console.log(`conta ${CONTA} apagada.`);
    try {
      await getUser(CONTA);
      console.log('ERRO: a conta ainda existe.');
    } catch {
      console.log('releitura confirma: a conta NAO existe mais.');
    }
    await mostrarGrupo('estado final do grupo');
    break;
  }
  default:
    console.log('passo invalido. use: criar | ler | grant | revoke | apagar');
}
