// O pacote `net-snmp` (3.26.x) é JavaScript puro e não publica tipos, e não
// existe @types/net-snmp. Este arquivo declara apenas a fatia da API que o
// poller de impressoras (src/services/printer-snmp.service.ts) usa de fato —
// não é uma tipagem completa do pacote. Se alguma outra parte do projeto
// passar a usar mais da API (traps, agent, tabelas), estender aqui.
declare module 'net-snmp' {
  export interface Varbind {
    oid: string;
    type: number;
    // OctetString vem como Buffer; Integer/Counter/Gauge/TimeTicks como
    // number; OID como string. `null` para os tipos Null/erro.
    value: Buffer | number | string | null;
  }

  export type ResponseCallback = (error: Error | null, varbinds: Varbind[]) => void;

  export interface Session {
    get(oids: string[], callback: ResponseCallback): Session;
    getNext(oids: string[], callback: ResponseCallback): Session;
    close(): void;
    on(event: string, listener: (error: Error) => void): void;
  }

  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    version?: number;
    transport?: string;
    idBitsSize?: number;
    context?: string;
  }

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: string;
    authKey?: string;
    privProtocol?: string;
    privKey?: string;
  }

  export function createSession(target: string, community: string, options?: SessionOptions): Session;
  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;

  export function isVarbindError(varbind: Varbind): boolean;
  export function varbindError(varbind: Varbind): string;

  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export const ObjectType: Record<string, number | string>;
  export const AuthProtocols: Record<string, number | string>;
  export const PrivProtocols: Record<string, number | string>;
  export const SecurityLevel: Record<string, number | string>;

  const netSnmp: {
    createSession: typeof createSession;
    createV3Session: typeof createV3Session;
    isVarbindError: typeof isVarbindError;
    varbindError: typeof varbindError;
    Version1: number;
    Version2c: number;
    Version3: number;
    ObjectType: Record<string, number | string>;
    AuthProtocols: Record<string, number | string>;
    PrivProtocols: Record<string, number | string>;
    SecurityLevel: Record<string, number | string>;
  };
  export default netSnmp;
}
