import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { env } from '../config/env.js';

const HISTORY_LIMIT = 200;

export interface UniFiEventRecord {
  receivedAt: string;
  data: string;
}

// Mantém UMA conexão WebSocket com o controller, não importa quantas abas
// do dashboard estejam abertas. Conecta quando o primeiro assinante chega,
// desconecta (com um pequeno atraso, pra não ficar reconectando à toa em
// reloads rápidos) quando o último sai. Reconecta com backoff se cair.
class UniFiEventsHub extends EventEmitter {
  private upstream: WebSocket | null = null;
  private subscribers = 0;
  private reconnectDelay = 1000;
  private disconnectTimer: NodeJS.Timeout | null = null;
  // Buffer em memória, não persiste entre restarts, e só é alimentado
  // enquanto a conexão upstream está ativa (ou seja, enquanto pelo menos um
  // cliente WS está/esteve conectado nos últimos 10s) — não é um histórico
  // completo desde sempre, é "o que passou enquanto alguém estava olhando".
  private history: UniFiEventRecord[] = [];

  subscribe(listener: (data: string) => void): () => void {
    this.subscribers++;
    this.on('event', listener);

    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (!this.upstream) this.connectUpstream();

    return () => {
      this.subscribers--;
      this.off('event', listener);
      if (this.subscribers === 0) {
        this.disconnectTimer = setTimeout(() => this.disconnectUpstream(), 10_000);
      }
    };
  }

  getHistory(limit = HISTORY_LIMIT): UniFiEventRecord[] {
    const capped = Math.min(limit, HISTORY_LIMIT);
    return this.history.slice(-capped);
  }

  private connectUpstream() {
    const url = `wss://${env.CONTROLLER_HOST}/proxy/network/wss/s/${env.SITE_ID}/events`;
    this.upstream = new WebSocket(url, {
      headers: { Authorization: `Bearer ${env.UNIFI_API_KEY}` },
      rejectUnauthorized: !env.UNIFI_ALLOW_SELF_SIGNED,
    });

    this.upstream.on('open', () => {
      this.reconnectDelay = 1000;
    });

    this.upstream.on('message', (data) => {
      const record: UniFiEventRecord = { receivedAt: new Date().toISOString(), data: data.toString() };
      this.history.push(record);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      this.emit('event', record.data);
    });

    this.upstream.on('close', () => {
      this.upstream = null;
      if (this.subscribers > 0) {
        setTimeout(() => this.connectUpstream(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });

    this.upstream.on('error', (err) => this.emit('hub-error', err));
  }

  private disconnectUpstream() {
    this.upstream?.close();
    this.upstream = null;
  }
}

export const unifiEventsHub = new UniFiEventsHub();
