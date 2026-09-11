/**
 * SONDA DE LEITURA — MIB privada Brother (Onda 2, detalhamento de toner).
 *
 * Motivo: as Brothers devolvem `-3` (sentinela `partial` da RFC 3805) em
 * `prtMarkerSuppliesLevel` para os CARTUCHOS — o nível de toner simplesmente
 * não existe na MIB padrão. Mesma classe do bug das HPs corrigido na PR #30,
 * onde a MIB privada do fabricante tinha o valor real.
 *
 * REGRA DURA DESTE PROJETO (ver CLAUDE.md, item 19 achado (c)): a semântica de
 * coluna de MIB privada NUNCA é inferida por correlação numérica sozinha —
 * precisa ser confirmada contra uma fonte que o próprio aparelho exponha, lida
 * no MESMO instante. Por isso esta sonda só COLETA candidatos; quem decide o
 * mapeamento é o percentual lido no painel web pelo operador.
 *
 * Somente LEITURA (get/getNext). Nunca escreve nada em impressora nenhuma.
 *
 * Uso:
 *   node tools/brother-mib-probe.mjs                  # coleta e salva o retrato
 *   node tools/brother-mib-probe.mjs --cruzar 12,40,55,73
 *        ^ percentuais do painel na ordem preto,ciano,magenta,amarelo
 */
import snmp from 'net-snmp';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const SNAPSHOT = 'tools/.brother-mib-snapshot.json';
const ALVOS = [
  { nome: 'DCP-L3560CDW (COLOR)', ip: '172.16.0.80', cores: ['preto', 'ciano', 'magenta', 'amarelo'] },
  { nome: 'HL-L2360DW (mono)', ip: '172.16.0.222', cores: ['preto'] },
  { nome: 'DCP-1610NW (mono)', ip: '172.16.0.77', cores: ['preto'] },
];

// Walk por getNext manual — `subtree()`/`getBulk` da lib NÃO é confiável
// nestas impressoras (achado 2 da subtarefa 5, ver printer-snmp.service.ts).
function walk(session, raiz, limite = 400) {
  return new Promise((resolve) => {
    const out = [];
    let cursor = raiz;
    const passo = () => {
      if (out.length >= limite) return resolve(out);
      // getNext recebe OIDs como STRING (não objeto) — mesma forma usada
      // por walkColumn() em printer-snmp.service.ts.
      session.getNext([cursor], (err, vbs) => {
        if (err || !vbs?.length || snmp.isVarbindError(vbs[0])) return resolve(out);
        const vb = vbs[0];
        if (!vb.oid.startsWith(raiz + '.')) return resolve(out);
        out.push({ oid: vb.oid, valor: Buffer.isBuffer(vb.value) ? vb.value.toString('hex') : vb.value });
        cursor = vb.oid;
        passo();
      });
    };
    passo();
  });
}

// O blob "maintenance info" da Brother é uma sequência TLV:
// <tag:1><len:1><valor:len bytes> ... terminada por 0xff.
function decodeTlv(hex) {
  const b = Buffer.from(hex, 'hex');
  const itens = [];
  let i = 0;
  // Formato real observado nas 3 Brothers: <tag:1><tipo:1><tamanho:1><valor:tamanho>,
  // terminado por 0xff. Ex.: `63 01 04 00000001` = tag 0x63, tipo 1, 4 bytes, valor 1.
  // (A primeira versão desta sonda assumiu <tag><tamanho><valor> e saiu
  // desalinhada, produzindo tags 0x00 e valores nulos — registrado aqui para
  // ninguém "corrigir" de volta.)
  while (i < b.length && b[i] !== 0xff) {
    const tag = b[i];
    const tipo = b[i + 1];
    const len = b[i + 2];
    if (len === undefined || len < 1 || len > 6 || i + 3 + len > b.length) break;
    itens.push({
      tag: '0x' + tag.toString(16).padStart(2, '0'),
      tipo,
      valor: b.readUIntBE(i + 3, len),
    });
    i += 3 + len;
  }
  return itens;
}

async function coletar() {
  const retrato = { capturadoEm: new Date().toISOString(), impressoras: [] };
  for (const alvo of ALVOS) {
    console.log(`\n===== ${alvo.nome} — ${alvo.ip} =====`);
    const s = snmp.createSession(alvo.ip, 'public', { version: snmp.Version2c, timeout: 5000, retries: 1 });
    const reg = { ...alvo, padrao: [], privado: {} };

    const desc = await walk(s, '1.3.6.1.2.1.43.11.1.1.6');
    const lvl = await walk(s, '1.3.6.1.2.1.43.11.1.1.9');
    const idx = (r) => new Map(r.map((x) => [x.oid.split('.').slice(-2).join('.'), x.valor]));
    const D = idx(desc), L = idx(lvl);
    console.log('  --- MIB padrão (o que o poller já lê) ---');
    for (const [k, v] of D) {
      const nivel = L.get(k);
      const nome = /^[0-9a-f]+$/.test(String(v)) ? Buffer.from(String(v), 'hex').toString('utf8') : String(v);
      reg.padrao.push({ indice: k, nome, level: nivel });
      const marca = nivel === -3 ? '  <== SEM MEDIÇÃO (sentinela partial)' : '';
      console.log(`    [${k}] ${String(v).padEnd(26)} level=${nivel}${marca}`);
    }

    console.log('  --- MIB privada Brother (candidatos) ---');
    for (const raiz of ['1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5', '1.3.6.1.4.1.2435.2.4.3.2435.5.13.3']) {
      const linhas = await walk(s, raiz, 60);
      if (!linhas.length) { console.log(`    ${raiz} -> (sem resposta)`); continue; }
      reg.privado[raiz] = linhas;
      for (const l of linhas) {
        const ehHex = typeof l.valor === 'string' && /^[0-9a-f]+$/.test(l.valor);
        if (ehHex && l.valor.length > 8) {
          const tlv = decodeTlv(l.valor);
          if (tlv.length) {
            console.log(`    ${l.oid}  (TLV, ${tlv.length} campos)`);
            for (const t of tlv) console.log(`        tag ${t.tag} = ${t.valor}`);
            continue;
          }
        }
        console.log(`    ${l.oid} = ${l.valor}`);
      }
    }
    s.close();
    retrato.impressoras.push(reg);
  }
  writeFileSync(SNAPSHOT, JSON.stringify(retrato, null, 2));
  console.log(`\nRetrato salvo em ${SNAPSHOT} — capturado em ${retrato.capturadoEm}`);
  console.log('Próximo passo: leia o painel web AGORA e rode com --cruzar.');
}

// Cruza os percentuais do painel contra TODO candidato numérico do retrato.
// Não decide nada: lista o que bate e o que não bate, para julgamento humano.
function cruzar(percentuais) {
  if (!existsSync(SNAPSHOT)) return console.log('Sem retrato. Rode a sonda sem --cruzar primeiro.');
  const retrato = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const alvo = retrato.impressoras.find((p) => p.cores.length === percentuais.length) ?? retrato.impressoras[0];
  console.log(`Cruzando contra: ${alvo.nome} (retrato de ${retrato.capturadoEm})`);
  console.log(`Painel informou: ${alvo.cores.map((c, i) => `${c}=${percentuais[i]}%`).join(', ')}\n`);

  const candidatos = [];
  for (const [raiz, linhas] of Object.entries(alvo.privado)) {
    for (const l of linhas) {
      if (typeof l.valor === 'number') candidatos.push({ onde: l.oid, valor: l.valor });
      else if (/^[0-9a-f]+$/.test(String(l.valor))) {
        for (const t of decodeTlv(String(l.valor))) candidatos.push({ onde: `${l.oid} tag ${t.tag}`, valor: t.valor });
      }
    }
  }
  for (let i = 0; i < percentuais.length; i++) {
    const alvoPct = percentuais[i];
    const batem = candidatos.filter((c) => c.valor === alvoPct);
    console.log(`${alvo.cores[i]} = ${alvoPct}%`);
    if (!batem.length) console.log('   (nenhum candidato com esse valor exato)');
    for (const b of batem) console.log(`   CANDIDATO  ${b.onde} = ${b.valor}`);
  }
  console.log('\nAVISO: um valor bater NÃO confirma a semântica da coluna.');
  console.log('Só vale se o MESMO candidato bater em TODAS as cores/impressoras — e, mesmo assim,');
  console.log('o CLAUDE.md exige confirmação contra fonte que o aparelho exponha, lida no mesmo instante.');
}

const arg = process.argv.indexOf('--cruzar');
if (arg !== -1) cruzar(process.argv[arg + 1].split(',').map(Number));
else await coletar();
