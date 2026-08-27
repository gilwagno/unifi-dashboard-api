import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { unifiEventsHub } from '../services/unifi-events.hub.js';

// Relay dos eventos em tempo real do controller para os clientes do
// dashboard, usando um único upstream compartilhado (unifi-events.hub.ts)
// em vez de uma conexão por aba aberta.
//
// Autenticação: em vez de token na query string (fica exposto em access
// logs de proxy/CDN), o cliente conecta sem token e manda a primeira
// mensagem como `{ "token": "<jwt>" }`. Se não vier em 5s, ou for
// inválido, a conexão é fechada.
export default fp(async function websocketPlugin(app: FastifyInstance) {
  await app.register(websocket);

  app.get('/ws/events', { websocket: true }, (connection) => {
    let authenticated = false;
    let unsubscribe: (() => void) | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) connection.socket.close(1008, 'Timeout de autenticação');
    }, 5000);

    connection.socket.on('message', (raw) => {
      if (authenticated) return; // canal é somente leitura pro cliente após autenticar

      try {
        const token = JSON.parse(raw.toString())?.token;
        app.jwt.verify(token ?? '');
      } catch {
        connection.socket.close(1008, 'Não autenticado');
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);

      unsubscribe = unifiEventsHub.subscribe((data) => {
        if (connection.socket.readyState === connection.socket.OPEN) {
          connection.socket.send(data);
        }
      });
    });

    connection.socket.on('close', () => {
      clearTimeout(authTimeout);
      unsubscribe?.();
    });
  });
});
