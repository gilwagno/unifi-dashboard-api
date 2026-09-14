// SONDA SOMENTE LEITURA — confere se a configuração `AD_*` do `.env` aponta
// para objetos que existem de verdade, ANTES de alguém confiar nela.
//
// COMO RODAR (da raiz do projeto):
//     npx tsx tools/ad-config-check.mts
//
// Nenhuma escrita. Existe porque um DN errado numa dessas variáveis não
// falha no boot — falha na hora de conceder ou revogar acesso, que é o pior
// momento possível.
import 'dotenv/config';
import { searchGroups, searchUsers } from '../src/services/ad.service.js';

const grupoDn = process.env.AD_NETWORK_ACCESS_GROUP_DN;
const usersOu = process.env.AD_USERS_OU;

console.log(`AD_USERS_OU ................ ${usersOu}`);
console.log(`AD_NETWORK_ACCESS_GROUP_DN . ${grupoDn}\n`);

// 1. O grupo da ponte 802.1X existe? A busca é por CN em todo o AD_BASE_DN,
//    então comparamos o DN devolvido pelo diretório com o configurado.
const cn = grupoDn?.match(/^CN=([^,]+),/i)?.[1];
if (!cn) {
  console.log('AD_NETWORK_ACCESS_GROUP_DN ausente ou sem CN= no inicio.');
} else {
  const achados = await searchGroups(cn);
  const exato = achados.find((g) => g.dn.toLowerCase() === grupoDn!.toLowerCase());
  console.log(exato ? `grupo da ponte: OK (${exato.dn})` : `grupo da ponte: NAO CONFERE — diretorio devolveu ${achados.map((g) => g.dn).join(' | ') || 'nada'}`);
}

// 2. Quantos usuários a OU configurada alcança. `findUserEntry` busca DENTRO
//    de AD_USERS_OU — um usuário fora dela simplesmente não é encontrado, e
//    conceder/revogar acesso para ele devolve 404.
const usuarios = await searchUsers();
console.log(`\nusuarios alcancaveis em AD_USERS_OU: ${usuarios.length}`);
for (const u of usuarios.slice(0, 10)) console.log(`  ${u.sAMAccountName}  (${u.displayName ?? '-'})`);
if (usuarios.length > 10) console.log(`  ... e mais ${usuarios.length - 10}`);

if (usuarios.length === 0) {
  console.log('\nATENCAO: nenhum usuario alcancavel. Conceder/revogar acesso devolveria 404');
  console.log('para qualquer pessoa real, porque a busca acontece DENTRO de AD_USERS_OU.');
}
