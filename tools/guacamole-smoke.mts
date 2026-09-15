// Teste de fumaça do remote-access.service.ts contra um Guacamole REAL.
//
// Chama as funções DE PRODUÇÃO (não uma reimplementação) contra a instância
// do docker-compose deste repo. Cria uma conexão descartável, confere por
// LEITURA INDEPENDENTE, e remove — no mesmo espírito do teste de fumaça da
// ponte 802.1X da Onda 3, onde cada passo foi confirmado relendo o estado
// em vez de confiar no retorno da função.
//
// Escreve, mas só no objeto descartável que ele mesmo cria.
// Uso: npx tsx tools/guacamole-smoke.mts
import {
  remoteAccessService,
  RemoteAccessConnectionNotFoundError,
} from '../src/services/remote-access.service.js';

const NAME = `smoke-descartavel-${process.pid}`;
const HOST = 'vm-de-teste.invalido';

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

console.log('configurado:', remoteAccessService.isConfigured());

const antes = await remoteAccessService.listConnections();
check('listar conexões antes', true, `${antes.length} conexão(ões)`);
check(
  'nenhuma sobra de execução anterior com este nome',
  !antes.some((c) => c.name === NAME),
);

const criada = await remoteAccessService.createRdpConnection({ name: NAME, hostname: HOST });
check('criar conexão RDP', Boolean(criada.identifier), `identifier=${criada.identifier}`);

// Releitura independente: não confia no retorno do create.
const depois = await remoteAccessService.listConnections();
check(
  'releitura: a conexão aparece na listagem',
  depois.some((c) => c.identifier === criada.identifier && c.name === NAME),
);

const detalhe = await remoteAccessService.getConnection(criada.identifier);
check('releitura: protocolo é rdp', detalhe.protocol === 'rdp', detalhe.protocol);
check('releitura: hostname persistido', detalhe.hostname === HOST, String(detalhe.hostname));

// Regra 2: o catálogo NÃO pode guardar credencial. Confere no material cru
// que o Guacamole devolve, não no shape já filtrado pelo serviço.
const raw = await (async () => {
  const base = process.env.GUACAMOLE_URL!.replace(/\/+$/, '');
  const ds = process.env.GUACAMOLE_DATA_SOURCE ?? 'postgresql';
  const loginRes = await fetch(`${base}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.GUACAMOLE_USERNAME!,
      password: process.env.GUACAMOLE_PASSWORD!,
    }),
  });
  const { authToken: token } = (await loginRes.json()) as { authToken: string };
  const res = await fetch(
    `${base}/api/session/data/${ds}/connections/${criada.identifier}/parameters?token=${token}`,
  );
  return (await res.json()) as Record<string, string>;
})();
check(
  'regra 2: nenhuma credencial persistida nos parâmetros',
  !('username' in raw) && !('password' in raw) && !('domain' in raw),
  Object.keys(raw).join(','),
);
check('regra 2 (cont.): NLA exigido', raw.security === 'nla', raw.security);

const rm1 = await remoteAccessService.deleteConnection(criada.identifier);
check('remover', rm1.removed === true);

const rm2 = await remoteAccessService.deleteConnection(criada.identifier);
check('remover DE NOVO é sucesso silencioso (idempotência)', rm2.removed === false);

const final = await remoteAccessService.listConnections();
check(
  'releitura final: a conexão sumiu',
  !final.some((c) => c.identifier === criada.identifier),
  `${final.length} conexão(ões)`,
);

const naoExiste = await remoteAccessService
  .getConnection(criada.identifier)
  .then(() => null)
  .catch((e) => e);
check(
  'ler conexão removida vira RemoteAccessConnectionNotFoundError',
  naoExiste instanceof RemoteAccessConnectionNotFoundError,
  naoExiste?.constructor?.name,
);
