/**
 * Servidor LDAP FAKE — usado pelos testes de integração (e no futuro, e2e)
 * do módulo de Active Directory (Onda 3, subtarefa 6 — ver docs/ad-module-plan.md).
 *
 * NUNCA aponta para um Active Directory real. Todo o estado é em memória e
 * reiniciado a cada boot, mesmo espírito de e2e/fake-controller/server.mjs
 * (o "controller UniFi fake" que já existe no projeto) — mas aqui o
 * protocolo não é HTTP/REST, é LDAP de verdade (RFC 4511) sobre um socket
 * TCP com TLS (o `.env.example` exige `ldaps://` em AD_URL).
 *
 * --- Por que uma implementação própria de LDAP em vez de um pacote pronto ---
 *
 * `ldapts` (o client já usado por src/services/ad.service.ts) é só CLIENTE —
 * não expõe um `createServer`. As alternativas de SERVIDOR avaliadas:
 *   - `ldapjs` (o pacote histórico, com `createServer`): DEPRECIADO pelo
 *     próprio autor (`npm view ldapjs deprecated` confirma: "This package
 *     has been decomissioned"), sem atualização desde 2024-05. Descartado —
 *     este projeto já tem precedente forte de tratar dependência nova como
 *     decisão séria (`undici` só entrou para um serviço específico,
 *     documentado como tal no CLAUDE.md) e não faz sentido consolidar em
 *     cima de um pacote que o próprio mantenedor abandonou.
 *   - Servidores LDAP "de verdade" via Docker (ex.: OpenLDAP, samba-ad) —
 *     rejeitado: pesado, exige um processo externo/infra, e este projeto
 *     não tem Docker em nenhum outro lugar do seu ciclo de teste (o
 *     fake-controller e este arquivo são os dois únicos "servidores fake",
 *     ambos Node puro).
 *   - Implementação própria sobre `node:net`/`node:tls`, análoga ao
 *     `https.createServer` manual do fake-controller: ESCOLHIDA. O
 *     protocolo LDAP em si (RFC 4511) é BER/ASN.1 — a codificação de baixo
 *     nível (tag+length+value) é reaproveitada do pacote `asn1-ber`, que
 *     JÁ é uma dependência TRANSITIVA deste projeto (via `net-snmp`, usado
 *     pelo poller de impressoras — `npm ls asn1-ber` confirma
 *     `net-snmp@3.26.3 -> asn1-ber@1.2.2`) — ou seja, promovido a
 *     devDependency explícita em vez de confiar silenciosamente numa
 *     transitiva (que podia sumir numa troca de versão do `net-snmp` sem
 *     aviso nenhum), mas SEM adicionar peso novo à árvore de dependências
 *     de produção. `asn1-ber` é o mesmo pacote usado internamente pelo
 *     extinto `ldapjs` para BER — maduro, pequeno, zero dependências
 *     próprias — só não empacotado como um "servidor LDAP" completo, que é
 *     exatamente o que este arquivo escreve por cima dele.
 *
 * Este servidor NÃO é um LDAP genérico: entende exatamente o subconjunto do
 * protocolo que `ad.service.ts` de fato produz (confirmado lendo o código
 * real de `ldapts` em node_modules — BindRequest simples, SearchRequest com
 * filtros AND/OR/equality/substrings, AddRequest, ModifyRequest com
 * add/delete/replace, DeleteRequest, UnbindRequest — ver os comentários
 * junto de cada `parse*` abaixo para o tag BER exato e a referência no
 * código-fonte do `ldapts` que confirma cada um). Grupos/computadores
 * (subtarefas seguintes do plano) só precisam do necessário para a ponte
 * 802.1X hoje: um objeto `group` com atributo `member` multivalorado.
 */
import tls from 'node:tls';
import asn1ber from 'asn1-ber';
import selfsigned from 'selfsigned';

const { BerReader, BerWriter } = asn1ber;

// --- Códigos de resultado LDAP (RFC 4511 §4.1.9) — só os que este fake
// realmente pode devolver. Conferidos contra StatusCodeParser.parse() em
// node_modules/ldapts/src/StatusCodeParser.ts para garantir que o client
// real levanta a classe de erro que ad.service.ts espera (ex.: código 32 ->
// NoSuchObjectError, código 20 -> TypeOrValueExistsError).
const RESULT = {
  success: 0,
  noSuchAttribute: 16,
  attributeOrValueExists: 20,
  noSuchObject: 32,
  invalidCredentials: 49,
  unwillingToPerform: 53,
  entryAlreadyExists: 68,
};

// --- Tags de protocolo LDAP (RFC 4511 §4.2+), conferidos 1:1 contra
// node_modules/ldapts/src/ProtocolOperation.ts (a fonte de verdade de que
// ESTES são os bytes exatos que o client real envia/espera).
const OP = {
  BindRequest: 0x60,
  BindResponse: 0x61,
  UnbindRequest: 0x42,
  SearchRequest: 0x63,
  SearchResultEntry: 0x64,
  SearchResultDone: 0x65,
  ModifyRequest: 0x66,
  ModifyResponse: 0x67,
  AddRequest: 0x68,
  AddResponse: 0x69,
  DelRequest: 0x4a,
  DelResponse: 0x6b,
};

// Tags de Filter (RFC 4511 §4.5.1.7), conferidos contra
// node_modules/ldapts/src/SearchFilter.ts.
const FILTER = {
  and: 0xa0,
  or: 0xa1,
  not: 0xa2,
  equalityMatch: 0xa3,
  substrings: 0xa4,
  present: 0x87,
};

const SEQUENCE = 0x30;
const SET = 0x31;
const OCTET_STRING = 0x04;
const CONTEXT_SIMPLE_AUTH = 0x80;

// --- Normalização de DN --------------------------------------------------
//
// Não é um parser de DN RFC 4514 completo (não precisa: todo DN que passa
// por este servidor foi gerado ou pelo próprio `ldapts` — `DN.addPairRDN`,
// que escapa corretamente — ou pelos dados semeados abaixo, escritos por
// nós). Só precisamos comparar DNs de forma estável independente de
// espaço depois da vírgula (`CN=x, DC=y` vs `CN=x,DC=y`) e de caixa.
function normalizeDn(dn) {
  return String(dn)
    .split(',')
    .map((rdn) => rdn.trim())
    .join(',')
    .toLowerCase();
}

// --- Diretório em memória --------------------------------------------------

function makeEntry(dn) {
  return { dn, attrs: new Map() };
}

function setAttr(entry, name, values) {
  const buffers = values.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8')));
  entry.attrs.set(name.toLowerCase(), buffers);
}

function getAttrBuffers(entry, name) {
  return entry.attrs.get(name.toLowerCase()) ?? [];
}

function getAttrStrings(entry, name) {
  return getAttrBuffers(entry, name).map((b) => b.toString('utf8'));
}

function hasAttrValue(entry, name, value) {
  const target = value.toLowerCase();
  return getAttrStrings(entry, name).some((v) => v.toLowerCase() === target);
}

// --- Avaliação de filtro -----------------------------------------------

function matchesFilter(entry, filter) {
  switch (filter.type) {
    case 'and':
      return filter.filters.every((f) => matchesFilter(entry, f));
    case 'or':
      return filter.filters.some((f) => matchesFilter(entry, f));
    case 'not':
      return !matchesFilter(entry, filter.filter);
    case 'present':
      return getAttrStrings(entry, filter.attr).length > 0;
    case 'equal':
      return hasAttrValue(entry, filter.attr, filter.value);
    case 'substrings': {
      const values = getAttrStrings(entry, filter.attr);
      return values.some((raw) => {
        const s = raw.toLowerCase();
        let pos = 0;
        if (filter.initial) {
          const initial = filter.initial.toLowerCase();
          if (!s.startsWith(initial)) return false;
          pos = initial.length;
        }
        for (const chunk of filter.any) {
          const idx = s.indexOf(chunk.toLowerCase(), pos);
          if (idx === -1) return false;
          pos = idx + chunk.length;
        }
        if (filter.final) {
          const final = filter.final.toLowerCase();
          if (!s.endsWith(final) || s.length - final.length < pos) return false;
        }
        return true;
      });
    }
    default:
      return false;
  }
}

// --- Parsing de mensagens LDAP (BER) -----------------------------------
//
// Cada `parse*` abaixo é a leitura, byte a byte, do formato que a classe
// correspondente em node_modules/ldapts/src/messages/*.ts ESCREVE — a
// referência exata está anotada em cada função.

// Filter ::= CHOICE { and[0], or[1], not[2], equalityMatch[3] SEQUENCE,
//   substrings[4] SEQUENCE, present[7] OCTET STRING, ... } — ver
// node_modules/ldapts/src/filters/{And,Or,Not,Equality,Substring,Presence}Filter.ts
function parseFilter(reader) {
  const tag = reader.peek();
  switch (tag) {
    case FILTER.and:
    case FILTER.or: {
      reader.readSequence(tag);
      const end = reader.offset + reader.length;
      const filters = [];
      while (reader.offset < end) filters.push(parseFilter(reader));
      return { type: tag === FILTER.and ? 'and' : 'or', filters };
    }
    case FILTER.not: {
      reader.readSequence(tag);
      const inner = parseFilter(reader);
      return { type: 'not', filter: inner };
    }
    case FILTER.equalityMatch: {
      reader.readSequence(tag);
      const attr = reader.readString(OCTET_STRING);
      const value = reader.readString(OCTET_STRING);
      return { type: 'equal', attr, value };
    }
    case FILTER.substrings: {
      reader.readSequence(tag);
      const attr = reader.readString(OCTET_STRING);
      reader.readSequence(SEQUENCE);
      const subEnd = reader.offset + reader.length;
      let initial = '';
      let final = '';
      const any = [];
      while (reader.offset < subEnd) {
        const subTag = reader.peek();
        const value = reader.readString(subTag);
        if (subTag === 0x80) initial = value;
        else if (subTag === 0x81) any.push(value);
        else if (subTag === 0x82) final = value;
      }
      return { type: 'substrings', attr, initial, any, final };
    }
    case FILTER.present: {
      const attr = reader.readString(FILTER.present);
      return { type: 'present', attr };
    }
    default:
      throw new Error(`fake-ldap-server: filtro não suportado (tag 0x${(tag ?? -1).toString(16)})`);
  }
}

// AttributeList/PartialAttributeList — SEQUENCE OF SEQUENCE { type OCTET
// STRING, vals SET OF OCTET STRING } — ver Attribute.parse em
// node_modules/ldapts/src/Attribute.ts. O chamador já posicionou `reader`
// logo depois de abrir o SEQUENCE OF externo (com `readSequence`); aqui só
// iteramos até `endOffset` (o fim desse SEQUENCE OF).
function parseAttributes(reader, endOffset) {
  const attributes = [];
  while (reader.offset < endOffset) {
    reader.readSequence(SEQUENCE);
    const type = reader.readString(OCTET_STRING);
    reader.readSequence(SET);
    const valuesEnd = reader.offset + reader.length;
    const values = [];
    while (reader.offset < valuesEnd) values.push(reader.readString(OCTET_STRING, true));
    attributes.push({ type, values });
  }
  return attributes;
}

// Determina se o buffer acumulado contém pelo menos uma LDAPMessage BER
// completa (tag 0x30 + length [+ conteúdo]). TCP não preserva fronteira de
// mensagem — sem isso, uma mensagem grande (ex.: AddRequest com vários
// atributos) fragmentada em 2+ pacotes TCP quebraria o parse.
function completeMessageLength(buf) {
  if (buf.length < 2) return null;
  if (buf[0] !== SEQUENCE) throw new Error(`fake-ldap-server: esperava SEQUENCE (0x30), veio 0x${buf[0].toString(16)}`);
  const lenByte = buf[1];
  let headerLen;
  let contentLen;
  if ((lenByte & 0x80) === 0) {
    headerLen = 2;
    contentLen = lenByte;
  } else {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0) throw new Error('fake-ldap-server: comprimento indefinido não suportado');
    if (buf.length < 2 + numOctets) return null;
    contentLen = 0;
    for (let i = 0; i < numOctets; i += 1) contentLen = contentLen * 256 + buf[2 + i];
    headerLen = 2 + numOctets;
  }
  const total = headerLen + contentLen;
  return buf.length < total ? null : total;
}

// --- Escrita de mensagens LDAP (BER) -------------------------------------

function encodeMessage(messageId, opTag, writeOp) {
  const writer = new BerWriter();
  writer.startSequence(SEQUENCE);
  writer.writeInt(messageId);
  writer.startSequence(opTag);
  writeOp(writer);
  writer.endSequence();
  writer.endSequence();
  return writer.buffer;
}

function writeLdapResult(writer, resultCode, errorMessage = '') {
  writer.writeEnumeration(resultCode);
  writer.writeString(''); // matchedDN — não usado por este fake
  writer.writeString(errorMessage);
}

function encodeResult(messageId, opTag, resultCode, errorMessage = '') {
  return encodeMessage(messageId, opTag, (writer) => writeLdapResult(writer, resultCode, errorMessage));
}

function encodeSearchEntry(messageId, entry, requestedAttributes) {
  return encodeMessage(messageId, OP.SearchResultEntry, (writer) => {
    writer.writeString(entry.dn);
    writer.startSequence(SEQUENCE);
    for (const name of requestedAttributes) {
      const values = getAttrBuffers(entry, name);
      writer.startSequence(SEQUENCE);
      writer.writeString(name);
      writer.startSequence(SET);
      for (const value of values) writer.writeBuffer(value, OCTET_STRING);
      writer.endSequence();
      writer.endSequence();
    }
    writer.endSequence();
  });
}

// --- Estado do diretório fake -------------------------------------------

const UF_ACCOUNTDISABLE = 0x0002;
const UF_NORMAL_ACCOUNT = 0x0200;

function seedDirectory(config) {
  const directory = new Map();

  const put = (entry) => directory.set(normalizeDn(entry.dn), entry);

  const makeUser = ({ sam, displayName, mail, department, title, uac, lockoutTime, workstations }) => {
    const dn = `CN=${sam},${config.usersOu}`;
    const entry = makeEntry(dn);
    setAttr(entry, 'objectClass', ['top', 'person', 'organizationalPerson', 'user']);
    setAttr(entry, 'objectCategory', ['person']);
    setAttr(entry, 'distinguishedName', [dn]);
    setAttr(entry, 'cn', [sam]);
    setAttr(entry, 'sAMAccountName', [sam]);
    setAttr(entry, 'displayName', [displayName]);
    if (mail) setAttr(entry, 'mail', [mail]);
    if (department) setAttr(entry, 'department', [department]);
    if (title) setAttr(entry, 'title', [title]);
    setAttr(entry, 'userAccountControl', [String(uac ?? UF_NORMAL_ACCOUNT)]);
    setAttr(entry, 'lockoutTime', [String(lockoutTime ?? 0)]);
    if (workstations?.length) setAttr(entry, 'userWorkstations', [workstations.join(',')]);
    put(entry);
    return entry;
  };

  // Usuário "normal", habilitado — o caso feliz da maioria dos fluxos.
  makeUser({
    sam: 'jsilva',
    displayName: 'João Silva',
    mail: 'joao.silva@fakeldap.test',
    department: 'TI',
    title: 'Analista',
  });

  // Desabilitado de propósito — exercita `enabled: false` em getUser/
  // searchUsers sem precisar de nenhuma mutação antes.
  makeUser({
    sam: 'mreis',
    displayName: 'Maria Reis',
    mail: 'maria.reis@fakeldap.test',
    department: 'RH',
    title: 'Gerente',
    uac: UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE,
  });

  // Bloqueado de propósito (lockoutTime != '0') — exercita `lockedOut: true`
  // e o fluxo de `unlockUser`.
  makeUser({
    sam: 'ptravado',
    displayName: 'Pedro Travado',
    lockoutTime: Date.now(),
  });

  // Grupo da ponte 802.1X (docs/ad-module-plan.md) — começa sem membros;
  // os testes de grant/revoke são quem povoa/esvazia `member`.
  const group = makeEntry(config.networkAccessGroupDn);
  setAttr(group, 'objectClass', ['top', 'group']);
  setAttr(group, 'cn', ['Rede-Permitida']);
  setAttr(group, 'member', []);
  put(group);

  return directory;
}

// --- Núcleo: uma conexão -------------------------------------------------

function handleConnection(socket, state) {
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      let total;
      try {
        total = completeMessageLength(buf);
      } catch (err) {
        state.log(`erro de framing: ${err.message}`);
        socket.destroy();
        return;
      }
      if (total === null) return;
      const msgBuf = buf.subarray(0, total);
      buf = buf.subarray(total);
      try {
        handleMessage(socket, state, msgBuf);
      } catch (err) {
        state.log(`erro processando mensagem: ${err.stack ?? err.message}`);
        socket.destroy();
        return;
      }
    }
  });

  socket.on('error', () => {
    // Conexão pode cair a qualquer momento (o próprio ldapts fecha sem
    // esperar resposta no unbind) — não é um erro do servidor.
  });
}

function handleMessage(socket, state, msgBuf) {
  const reader = new BerReader(msgBuf);
  reader.readSequence(SEQUENCE); // LDAPMessage
  const messageId = reader.readInt();
  const opTag = reader.readSequence(); // consome tag+length do protocolOp
  const opEnd = reader.offset + reader.length;

  switch (opTag) {
    case OP.BindRequest:
      handleBind(socket, state, messageId, reader);
      return;
    case OP.UnbindRequest:
      socket.end();
      return;
    case OP.SearchRequest:
      handleSearch(socket, state, messageId, reader, opEnd);
      return;
    case OP.AddRequest:
      handleAdd(socket, state, messageId, reader);
      return;
    case OP.ModifyRequest:
      handleModify(socket, state, messageId, reader);
      return;
    case OP.DelRequest: {
      // DelRequest ::= [APPLICATION 10] LDAPDN — PRIMITIVO (não é uma
      // SEQUENCE: o próprio ldapts escreve os bytes do DN direto como
      // conteúdo do tag, ver DeleteRequest.writeMessage). O conteúdo já
      // está delimitado por `reader.length` (setado pelo readSequence
      // acima, que só olha tag+length, não a semântica constructed/
      // primitive do tag).
      const dn = reader.buffer.subarray(0, reader.length).toString('utf8');
      handleDelete(socket, state, messageId, dn);
      return;
    }
    default:
      state.log(`operação não suportada: tag 0x${opTag.toString(16)}`);
      socket.write(encodeResult(messageId, OP.BindResponse, RESULT.unwillingToPerform, 'Operação não suportada pelo fake-ldap-server'));
  }
}

// BindRequest ::= SEQUENCE { version INTEGER, name LDAPDN,
//   authentication AuthenticationChoice } — só bind SIMPLES (tag 0x80) é
// suportado, que é o único que ad.service.ts usa (`client.bind(dn, senha)`
// sem `mechanism`, ver node_modules/ldapts/src/messages/BindRequest.ts).
function handleBind(socket, state, messageId, reader) {
  reader.readInt(); // version
  const dn = reader.readString(OCTET_STRING);
  const authTag = reader.peek();
  const password = authTag === CONTEXT_SIMPLE_AUTH ? reader.readString(CONTEXT_SIMPLE_AUTH) : null;

  const ok = password !== null && normalizeDn(dn) === normalizeDn(state.config.bindDn) && password === state.config.bindPassword;

  socket.write(
    encodeResult(messageId, OP.BindResponse, ok ? RESULT.success : RESULT.invalidCredentials, ok ? '' : 'Credenciais inválidas (fake-ldap-server)'),
  );
}

// SearchRequest ::= SEQUENCE { baseObject LDAPDN, scope ENUM, derefAliases
// ENUM, sizeLimit INT, timeLimit INT, typesOnly BOOL, filter Filter,
// attributes AttributeSelection } — ver SearchRequest.parseMessage em
// node_modules/ldapts/src/messages/SearchRequest.ts.
function handleSearch(socket, state, messageId, reader, opEnd) {
  const baseObject = reader.readString(OCTET_STRING);
  const scope = reader.readEnumeration(); // 0=base,1=one,2=sub,3=children
  reader.readEnumeration(); // derefAliases — ignorado (fake não tem alias)
  reader.readInt(); // sizeLimit — ignorado (diretório fake é pequeno)
  reader.readInt(); // timeLimit — ignorado
  reader.readBoolean(); // typesOnly — ignorado (sempre devolvemos valores)
  const filter = parseFilter(reader);

  const attributes = [];
  if (reader.offset < opEnd && reader.peek() === SEQUENCE) {
    reader.readSequence(SEQUENCE);
    const attrsEnd = reader.offset + reader.length;
    while (reader.offset < attrsEnd) attributes.push(reader.readString(OCTET_STRING));
  }

  const normalizedBase = normalizeDn(baseObject);
  const matches = [];
  for (const entry of state.directory.values()) {
    const normalizedEntryDn = normalizeDn(entry.dn);
    let inScope;
    if (scope === 0) inScope = normalizedEntryDn === normalizedBase;
    else if (scope === 1) {
      // singleLevel — simplificação deliberada (suficiente para um
      // diretório fake raso): trata como filho direto se, removendo o
      // sufixo do base, sobra exatamente um RDN (sem vírgula).
      if (normalizedEntryDn === normalizedBase || !normalizedEntryDn.endsWith(`,${normalizedBase}`)) inScope = false;
      else inScope = !normalizedEntryDn.slice(0, -(normalizedBase.length + 1)).includes(',');
    } else {
      // wholeSubtree (2) — o único scope que ad.service.ts de fato usa
      // (`scope: 'sub'` em todo `client.search`). `children` (3) tratado
      // igual a subtree por simplicidade — não usado pelo serviço.
      inScope = normalizedEntryDn === normalizedBase || normalizedEntryDn.endsWith(`,${normalizedBase}`);
    }
    if (inScope && matchesFilter(entry, filter)) matches.push(entry);
  }

  for (const entry of matches) socket.write(encodeSearchEntry(messageId, entry, attributes));
  socket.write(encodeResult(messageId, OP.SearchResultDone, RESULT.success));
}

// AddRequest ::= SEQUENCE { entry LDAPDN, attributes AttributeList } — ver
// AddRequest.parseMessage em node_modules/ldapts/src/messages/AddRequest.ts.
function handleAdd(socket, state, messageId, reader) {
  const dn = reader.readString(OCTET_STRING);
  reader.readSequence(SEQUENCE);
  const attrsEnd = reader.offset + reader.length;
  const parsedAttributes = parseAttributes(reader, attrsEnd);

  const key = normalizeDn(dn);
  if (state.directory.has(key)) {
    socket.write(encodeResult(messageId, OP.AddResponse, RESULT.entryAlreadyExists, `Já existe uma entrada em ${dn}`));
    return;
  }

  const entry = makeEntry(dn);
  for (const { type, values } of parsedAttributes) setAttr(entry, type, values);
  // AD mantém `distinguishedName` como atributo espelhando o DN — sem
  // isso, `findUserEntry`/`toAdUser` (ad.service.ts) cairiam no fallback
  // `entry.dn` de qualquer forma, mas replicar aqui deixa este fake fiel
  // ao comportamento real que a subtarefa 2 já documentou depender disso.
  setAttr(entry, 'distinguishedName', [dn]);

  // ACHADO REAL desta subtarefa (não hipótese — reproduzido rodando este
  // fake antes desta linha existir): `createUser` (ad.service.ts) NUNCA
  // envia `objectCategory` no `add()` — só `objectClass`. Contra um AD de
  // verdade isso não é problema: o schema do AD deriva `objectCategory`
  // automaticamente a partir de `objectClass` (todo objeto `user` ganha
  // `objectCategory=Person` sozinho, via `defaultObjectCategory` da classe
  // no schema). Um LDAP genérico SEM esse comportamento de schema (este
  // fake, sem a linha abaixo) cria a entrada normalmente, mas a releitura
  // que `createUser` faz logo em seguida — `findUserEntry`, cujo filtro é
  // `(&(objectClass=user)(objectCategory=person)(sAMAccountName=...))` —
  // não encontra NADA, e a exceção genérica vira `AdPasswordAmbiguousError`
  // (a senha tentada fica "perdida" no sentido em que o chamador não
  // recebe confirmação nenhuma — exatamente a categoria de bug que a
  // revisão crítica da PR #25 tratou como grave). Ou seja: o comportamento
  // observável de `createUser` depende de uma premissa de schema do AD que
  // NUNCA foi verificada contra um AD real (o próprio ad.service.ts já
  // avisa isso no topo do arquivo) — replicar aqui o auto-preenchimento é
  // a única forma de manter este fake fiel ao AD real published na
  // documentação da Microsoft, mas o achado em si (a dependência oculta em
  // `objectCategory` auto-derivado) só apareceu por falar o protocolo de
  // verdade — o mock de tests/unit/ad.service.test.ts nunca teve como
  // revelar isso, porque ele não reavalia filtro nenhum contra o que foi
  // de fato gravado no `add()`.
  if (!entry.attrs.has('objectcategory') && getAttrStrings(entry, 'objectClass').some((v) => v.toLowerCase() === 'user')) {
    setAttr(entry, 'objectCategory', ['person']);
  }
  state.directory.set(key, entry);

  socket.write(encodeResult(messageId, OP.AddResponse, RESULT.success));
}

// ModifyRequest ::= SEQUENCE { object LDAPDN, changes SEQUENCE OF SEQUENCE {
//   operation ENUM {add(0),delete(1),replace(2)}, modification
//   PartialAttribute } } — ver ModifyRequest.parseMessage e Change.parse em
// node_modules/ldapts/src/{messages/ModifyRequest,Change}.ts.
//
// IMPORTANTE (ver o comentário de topo de ad.service.ts sobre atomicidade):
// `createUser`/`resetPassword` despacham vários `changes` NUM ÚNICO
// ModifyRequest exatamente para que o LDAP garanta "todos aplicam ou
// nenhum aplica". Este fake honra isso: valida TODOS os changes antes de
// aplicar qualquer um (a validação abaixo é síncrona e em memória, então
// não há janela real de falha parcial como um AD de verdade poderia ter
// por I/O em disco/replicação — mas o contrato observável pelo client é o
// mesmo: erro = nada mudou).
function handleModify(socket, state, messageId, reader) {
  const dn = reader.readString(OCTET_STRING);
  reader.readSequence(SEQUENCE);
  const changesEnd = reader.offset + reader.length;

  const changes = [];
  while (reader.offset < changesEnd) {
    reader.readSequence(SEQUENCE);
    const operationEnum = reader.readEnumeration();
    reader.readSequence(SEQUENCE);
    const type = reader.readString(OCTET_STRING);
    reader.readSequence(SET);
    const valuesEnd = reader.offset + reader.length;
    const values = [];
    while (reader.offset < valuesEnd) values.push(reader.readString(OCTET_STRING, true));
    changes.push({ operation: operationEnum, type, values });
  }

  const entry = state.directory.get(normalizeDn(dn));
  if (!entry) {
    socket.write(encodeResult(messageId, OP.ModifyResponse, RESULT.noSuchObject, `Não existe entrada em ${dn}`));
    return;
  }

  // Passo 1: validar TODOS os changes antes de tocar no diretório (ver
  // docblock acima) — replica a semântica RFC 4511 §4.6 que
  // grantNetworkAccess/revokeNetworkAccess (ad.service.ts) dependem para
  // distinguir "já estava assim" (idempotente, tratado como sucesso pelo
  // serviço) de um erro de verdade.
  for (const change of changes) {
    const current = getAttrStrings(entry, change.type);
    const values = change.values.map((v) => v.toString('utf8'));
    if (change.operation === 0) {
      // add — RFC 4511: erro se algum valor já existir no atributo.
      for (const v of values) {
        if (current.some((c) => c.toLowerCase() === v.toLowerCase())) {
          socket.write(
            encodeResult(messageId, OP.ModifyResponse, RESULT.attributeOrValueExists, `${change.type}=${v} já existe em ${dn}`),
          );
          return;
        }
      }
    } else if (change.operation === 1) {
      // delete — RFC 4511: erro se o atributo não existe, ou se algum
      // valor pedido para remover não está presente (delete de todos os
      // valores, corpo vazio, é tratado como "apagar o atributo inteiro").
      if (current.length === 0) {
        socket.write(encodeResult(messageId, OP.ModifyResponse, RESULT.noSuchAttribute, `${change.type} não existe em ${dn}`));
        return;
      }
      for (const v of values) {
        if (!current.some((c) => c.toLowerCase() === v.toLowerCase())) {
          socket.write(
            encodeResult(messageId, OP.ModifyResponse, RESULT.noSuchAttribute, `${change.type}=${v} não existe em ${dn}`),
          );
          return;
        }
      }
    }
    // replace nunca falha (RFC 4511): cria, substitui ou remove o
    // atributo conforme os valores fornecidos.
  }

  // Passo 2: aplicar.
  for (const change of changes) {
    const current = getAttrStrings(entry, change.type);
    const values = change.values.map((v) => v.toString('utf8'));
    if (change.operation === 0) {
      setAttr(entry, change.type, [...current, ...values]);
    } else if (change.operation === 1) {
      if (values.length === 0) {
        entry.attrs.delete(change.type.toLowerCase());
      } else {
        const lowerValues = new Set(values.map((v) => v.toLowerCase()));
        const remaining = current.filter((c) => !lowerValues.has(c.toLowerCase()));
        if (remaining.length === 0) entry.attrs.delete(change.type.toLowerCase());
        else setAttr(entry, change.type, remaining);
      }
    } else if (change.operation === 2) {
      if (values.length === 0) entry.attrs.delete(change.type.toLowerCase());
      else setAttr(entry, change.type, values);
    }
  }

  socket.write(encodeResult(messageId, OP.ModifyResponse, RESULT.success));
}

function handleDelete(socket, state, messageId, dn) {
  const key = normalizeDn(dn);
  if (!state.directory.has(key)) {
    socket.write(encodeResult(messageId, OP.DelResponse, RESULT.noSuchObject, `Não existe entrada em ${dn}`));
    return;
  }
  state.directory.delete(key);
  socket.write(encodeResult(messageId, OP.DelResponse, RESULT.success));
}

// --- Bootstrap -------------------------------------------------------------

/**
 * Sobe o fake LDAP server em TLS (autoassinado, gerado em memória — mesmo
 * padrão do fake-controller: nenhuma chave privada versionada, sem
 * depender de openssl da máquina) e devolve os dados de conexão + um
 * `stop()`.
 *
 * @param {object} [options]
 * @param {number} [options.port] porta fixa; default 0 (o SO escolhe uma livre)
 * @param {string} [options.baseDn]
 * @param {string} [options.usersOu]
 * @param {string} [options.networkAccessGroupDn]
 * @param {string} [options.bindDn]
 * @param {string} [options.bindPassword]
 */
export async function startFakeLdapServer(options = {}) {
  const baseDn = options.baseDn ?? 'DC=fakeldap,DC=test';
  const config = {
    baseDn,
    usersOu: options.usersOu ?? `OU=Funcionarios,${baseDn}`,
    networkAccessGroupDn: options.networkAccessGroupDn ?? `CN=Rede-Permitida,CN=Users,${baseDn}`,
    bindDn: options.bindDn ?? `CN=svc-dashboard,CN=Users,${baseDn}`,
    bindPassword: options.bindPassword ?? 'S3nha-Fake-Ldap-2026',
  };

  const directory = seedDirectory(config);
  const log = options.log ?? (() => {});
  const state = { config, directory, log };

  // Certificado autoassinado em memória — mesma técnica de
  // e2e/fake-controller/server.mjs (mesmo comentário sobre `algorithm:
  // 'sha256'`: o OpenSSL 3 embutido no Node recusa o handshake com o
  // default SHA-1 do pacote `selfsigned`).
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          { type: 2, value: 'localhost' },
        ],
      },
    ],
  });

  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (socket) => handleConnection(socket, state));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const { port } = server.address();
  log(`[fake-ldap-server] escutando em ldaps://127.0.0.1:${port} (base ${config.baseDn})`);

  return {
    port,
    url: `ldaps://127.0.0.1:${port}`,
    ...config,
    directory,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Execução standalone (`node e2e/fake-ldap-server/server.mjs`), mesmo
// padrão do fake-controller — útil para a subtarefa 8 (e2e Playwright do
// módulo de AD), que ainda não existe.
const invokedDirectly =
  process.argv[1] !== undefined && (process.argv[1].endsWith('fake-ldap-server/server.mjs') || process.argv[1].endsWith('fake-ldap-server\\server.mjs'));

if (invokedDirectly) {
  const port = Number(process.env.FAKE_LDAP_PORT ?? 3636);
  const handle = await startFakeLdapServer({
    port,
    bindDn: process.env.FAKE_LDAP_BIND_DN,
    bindPassword: process.env.FAKE_LDAP_BIND_PASSWORD,
    log: (msg) => console.log(msg),
  });
  console.log(`[fake-ldap-server] AD_URL=${handle.url} AD_BASE_DN=${handle.baseDn} AD_USERS_OU=${handle.usersOu}`);
  console.log(`[fake-ldap-server] AD_BIND_DN=${handle.bindDn} AD_NETWORK_ACCESS_GROUP_DN=${handle.networkAccessGroupDn}`);
}
