// Sonda de PRONTIDÃO para a subtarefa 7 — somente leitura, nada é escrito.
//
// Responde uma pergunta só: existe hoje alguma máquina alcançável em 3389 a
// partir de onde o `guacd` roda? É o gate humano da subtarefa 2 (GPO de RDP
// + firewall) visto do lado de cá, e o pré-requisito do e2e da subtarefa 7.
//
// Faz apenas um handshake TCP (connect + close imediato) — não fala RDP, não
// autentica, não envia nada. Uso: npx tsx tools/rdp-readiness-probe.mts
import net from 'node:net';
import { searchComputers } from '../src/services/ad.service.js';

const PORTA = 3389;
const TIMEOUT_MS = 1500;

function alcancavel(host: string): Promise<'aberto' | 'recusado' | 'timeout' | 'sem-dns'> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const fim = (r: 'aberto' | 'recusado' | 'timeout' | 'sem-dns') => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => fim('aberto'));
    socket.once('timeout', () => fim('timeout'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      fim(err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'sem-dns' : 'recusado'),
    );
    socket.connect(PORTA, host);
  });
}

const computers = (await searchComputers()).filter((c) => c.enabled === true);
console.log(`computadores habilitados no AD: ${computers.length}\n`);

const resultados = new Map<string, string[]>();
for (const computer of computers) {
  const host = computer.dnsHostName ?? computer.name;
  const r = await alcancavel(host);
  if (!resultados.has(r)) resultados.set(r, []);
  resultados.get(r)!.push(computer.name);
}

for (const [estado, nomes] of [...resultados].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${estado}: ${nomes.length}`);
  if (estado === 'aberto') for (const n of nomes) console.log(`   - ${n}`);
}

const abertos = resultados.get('aberto') ?? [];
console.log(
  abertos.length > 0
    ? `\n>>> ${abertos.length} maquina(s) aceitam conexao em 3389 — ha alvo possivel para a subtarefa 7.`
    : '\n>>> NENHUMA maquina aceita conexao em 3389 a partir daqui: a subtarefa 7 esta travada no gate humano (GPO de RDP + firewall + VM de teste).',
);
