import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { searchComputers } from '../services/ad.service.js';
import { remoteAccessSyncService } from '../services/remote-access-sync.service.js';
import {
  RemoteAccessComputerNotFoundError,
  remoteAccessService,
} from '../services/remote-access.service.js';

// Rotas de Acesso Remoto (Onda 4, subtarefas 4 e 5).
//
// Mesmo padrão do resto do projeto: auth central, rate limit restrito em
// mutação, erros tipados do serviço mapeados pelo error handler central de
// src/app.ts (nenhum try/catch aqui).
export default async function remoteAccessRoutes(app: FastifyInstance): Promise<void> {
  // ⚠️ PRIMEIRA INSTRUÇÃO, e não por estilo. Neste projeto a autenticação é
  // opt-in POR ARQUIVO de rotas: um arquivo novo nasce SEM proteção e nem o
  // `tsc` nem o lint reclamam. Estava faltando na primeira versão deste
  // arquivo e as rotas responderam 200 sem token nenhum — ver a seção
  // "RISCO DE ARQUITETURA" no CLAUDE.md. Cada rota daqui tem um teste que
  // afirma 401 sem token; o hook sozinho não é a trava, o teste é.
  app.addHook('preHandler', app.authenticate);

  const mutationConfig = {
    config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } },
  };

  const objectGuidParam = z.object({
    objectGuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
      message: 'objectGuid deve ser um GUID canônico',
    }),
  });

  // Catálogo cru do Guacamole, com a âncora de cada conexão. Leitura pura —
  // útil para conferir o resultado de um sync sem abrir a UI do Guacamole.
  app.get('/remote-access/connections', async () => {
    const data = await remoteAccessService.listConnectionsWithAnchors();
    return { data };
  });

  // Computadores do AD cruzados com o catálogo do Guacamole: a lista que a
  // tela de Acesso Remoto (subtarefa 6) consome. `hasAccess` responde "dá
  // para abrir sessão neste PC agora?" sem o frontend precisar cruzar nada.
  app.get('/remote-access/computers', async () => {
    const [computers, connections] = await Promise.all([
      searchComputers(),
      remoteAccessService.listConnectionsWithAnchors(),
    ]);

    const porGuid = new Map(
      connections.filter((c) => c.adObjectGuid).map((c) => [c.adObjectGuid as string, c]),
    );

    const data = computers.map((computer) => {
      const connection = computer.objectGuid ? porGuid.get(computer.objectGuid) : undefined;
      return {
        name: computer.name,
        objectGuid: computer.objectGuid,
        dnsHostName: computer.dnsHostName,
        operatingSystem: computer.operatingSystem,
        enabled: computer.enabled,
        hasAccess: Boolean(connection),
        connectionIdentifier: connection?.identifier ?? null,
        // Sessões ativas nesta conexão, como o Guacamole reporta. É o que a
        // tela usa para o aviso visual de "sessão em andamento" — acesso à
        // tela de outra pessoa não pode ser silencioso.
        activeSessions: connection?.activeConnections ?? 0,
      };
    });

    return { data };
  });

  // Reconcilia o catálogo do Guacamole com a lista de computadores do AD.
  // Idempotente: rodar duas vezes não duplica e, sem mudança no AD, a segunda
  // execução não escreve nada. Conexões sem âncora (criadas à mão) nunca são
  // tocadas — voltam em `ignoradas`.
  app.post('/remote-access/sync', mutationConfig, async () => {
    const resultado = await remoteAccessSyncService.syncComputersToGuacamole();
    return {
      resumo: {
        criadas: resultado.criadas.length,
        atualizadas: resultado.atualizadas.length,
        inalteradas: resultado.inalteradas.length,
        removidas: resultado.removidas.length,
        puladas: resultado.puladas.length,
        ignoradas: resultado.ignoradas.length,
      },
      ...resultado,
    };
  });

  // Abre uma sessão de acesso remoto no computador indicado.
  //
  // AUDITORIA: esta é a ação mais sensível do projeto — ver a tela de uma
  // máquina de outra pessoa. O hook global `onResponse` de src/app.ts grava
  // ator (o `sub` do JWT), método, rota, params de path (o `objectGuid`, que
  // identifica o PC de forma estável) e status. Não há gravação manual aqui
  // de propósito: uma segunda escrita poderia divergir da do hook, e o hook
  // cobre inclusive as tentativas que FALHAM, que são as que mais importam
  // numa investigação. Há teste afirmando que a entrada é de fato registrada.
  //
  // SEM CREDENCIAL NO CORPO: a credencial de domínio não passa por este
  // backend. A conexão não carrega `username`/`password`, então o Guacamole
  // a pede no navegador e ela vai direto ao `guacd`.
  app.post('/remote-access/computers/:objectGuid/session', mutationConfig, async (request) => {
    const { objectGuid } = objectGuidParam.parse(request.params);

    const connections = await remoteAccessService.listConnectionsWithAnchors();
    const connection = connections.find(
      (c) => c.adObjectGuid?.toLowerCase() === objectGuid.toLowerCase(),
    );
    if (!connection) throw new RemoteAccessComputerNotFoundError(objectGuid);

    // O ator vem do JWT, NUNCA do corpo da requisição: quem abre a sessão
    // não escolhe em nome de quem ela é aberta.
    const actor = (request.user as { sub?: string } | undefined)?.sub ?? 'desconhecido';

    return remoteAccessService.openSession(actor, connection);
  });
}
