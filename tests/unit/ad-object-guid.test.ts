import { describe, expect, it } from 'vitest';
import { formatObjectGuid } from '../../src/services/ad.service.js';

// Testes de `formatObjectGuid` (Onda 4, subtarefa 4) — a conversão do
// objectGUID binário do AD para a forma canônica.
//
// ─────────────────────────────────────────────────────────────────────────
// POR QUE ESTES VETORES SÃO EXTERNOS, E NÃO INVENTADOS AQUI
// ─────────────────────────────────────────────────────────────────────────
// A ordem de bytes do objectGUID é MISTA (3 grupos little-endian + 2
// big-endian). Um `toString('hex')` ingênuo produz um GUID que parece válido
// e está trocado — e, pior, está CONSISTENTEMENTE errado: um sync que use
// esse valor dos dois lados funciona, porque a chave errada casa com ela
// mesma. O erro só apareceria ao cruzar o valor com outra ferramenta que lê
// o AD, provavelmente muito depois.
//
// Por isso os vetores abaixo NÃO foram construídos a partir desta
// implementação. São computadores REAIS do domínio `evokaudio.local`, e a
// forma canônica de cada um veio de uma implementação INDEPENDENTE: o
// construtor `System.Guid` do .NET (`New-Object System.Guid(,$bytes)` via
// PowerShell + DirectorySearcher), que é a mesma conversão que o
// `Get-ADComputer` usa. Um teste que só provasse que o código concorda
// consigo mesmo não provaria nada — é exatamente o buraco da sonda da Onda 3
// que comparava o DN contra o campo errado e passou até os dois valores
// divergirem.
//
// Capturados em 2026-09-15. Se um dia estes objetos deixarem de existir, os
// vetores continuam válidos: o que eles ancoram é a CONVERSÃO, não o objeto.
const VETORES_REAIS = [
  { nome: 'EA-SRV-AD01', bytesHex: '4049c0c15b1cfa4ca4f9d05689e80045', canonico: 'c1c04940-1c5b-4cfa-a4f9-d05689e80045' },
  { nome: 'EA-PC-CMP02', bytesHex: '708026dfab22814784657eb4bc790a2b', canonico: 'df268070-22ab-4781-8465-7eb4bc790a2b' },
  { nome: 'EA-PC-COR01', bytesHex: '9e9be33b294f4943a008b7fbcac6f35c', canonico: '3be39b9e-4f29-4349-a008-b7fbcac6f35c' },
];

describe('formatObjectGuid — ancorado em GUIDs reais convertidos pelo .NET', () => {
  for (const vetor of VETORES_REAIS) {
    it(`${vetor.nome}: produz exatamente o que o Get-ADComputer mostraria`, () => {
      expect(formatObjectGuid(Buffer.from(vetor.bytesHex, 'hex'))).toBe(vetor.canonico);
    });
  }

  it('a ordem de bytes é MISTA, não big-endian direto', () => {
    // Este teste existe para matar o mutante mais provável: converter tudo
    // com `toString('hex')` sem inverter grupo nenhum. O valor abaixo é o
    // que essa implementação ingênua produziria para o EA-SRV-AD01 — e ele
    // NÃO pode ser o resultado.
    const ingenuo = '4049c0c1-5b1c-fa4c-a4f9-d05689e80045';
    expect(formatObjectGuid(Buffer.from(VETORES_REAIS[0].bytesHex, 'hex'))).not.toBe(ingenuo);
  });

  it('a ordem de bytes também não é little-endian em TODOS os grupos', () => {
    // O outro mutante provável: inverter os cinco grupos. Os dois últimos
    // são big-endian e precisam ficar como vieram.
    const todosInvertidos = 'c1c04940-1c5b-4cfa-f9a4-4500e88956d0';
    expect(formatObjectGuid(Buffer.from(VETORES_REAIS[0].bytesHex, 'hex'))).not.toBe(todosInvertidos);
  });

  it('aceita o valor multivalorado que o ldapts pode devolver', () => {
    const buffer = Buffer.from(VETORES_REAIS[0].bytesHex, 'hex');
    expect(formatObjectGuid([buffer])).toBe(VETORES_REAIS[0].canonico);
  });

  it('não corrompe o Buffer de origem ao inverter os grupos', () => {
    // A inversão é feita sobre cópias; se fosse in-place sobre o `subarray`,
    // o Buffer da entrada sairia alterado e uma segunda chamada com o mesmo
    // objeto devolveria outro valor — bug que só aparece quando a mesma
    // entrada é convertida duas vezes.
    const buffer = Buffer.from(VETORES_REAIS[0].bytesHex, 'hex');
    expect(formatObjectGuid(buffer)).toBe(VETORES_REAIS[0].canonico);
    expect(formatObjectGuid(buffer)).toBe(VETORES_REAIS[0].canonico);
    expect(buffer.toString('hex')).toBe(VETORES_REAIS[0].bytesHex);
  });
});

describe('formatObjectGuid — lacuna é lacuna, não valor inventado', () => {
  it('atributo ausente vira null', () => {
    expect(formatObjectGuid(undefined)).toBeNull();
  });

  it('array vazio vira null', () => {
    expect(formatObjectGuid([])).toBeNull();
  });

  it('string (o que o ldapts devolveria SEM explicitBufferAttributes) vira null, não lixo', () => {
    // Se alguém remover `explicitBufferAttributes` da busca, o ldapts
    // decodifica os 16 bytes como UTF-8 e entrega uma string corrompida.
    // Devolver `null` aí é a única resposta honesta: um GUID derivado de
    // bytes já corrompidos seria uma âncora silenciosamente errada — a
    // classe de falha que esta subtarefa inteira existe para evitar.
    expect(formatObjectGuid('��I�[')).toBeNull();
  });

  it('Buffer com tamanho diferente de 16 vira null', () => {
    expect(formatObjectGuid(Buffer.alloc(15))).toBeNull();
    expect(formatObjectGuid(Buffer.alloc(17))).toBeNull();
  });
});
