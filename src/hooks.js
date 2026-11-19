'use strict';
// Petit lecteur JSON (avec commentaires et virgules finales tolerees) qui garde les positions.
// Il ne fait que LIRE du texte : aucune execution.

class JsonScanError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'JsonScanError';
    this.offset = offset;
  }
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function parseWithOffsets(text) {
  let i = 0;

  function fail(message) {
    throw new JsonScanError(message, i);
  }

  function skip() {
    while (i < text.length) {
      const c = text[i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\ufeff') {
        i += 1;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('commentaire non ferme');
        i = end + 2;
      } else {
        break;
      }
    }
  }

  function readString() {
    const start = i;
    i += 1;
    let value = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return { type: 'string', value, start, end: i };
      }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('echappement unicode invalide');
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (Object.prototype.hasOwnProperty.call(ESCAPES, n)) {
          value += ESCAPES[n];
          i += 2;
        } else {
          fail('echappement invalide');
        }
      } else if (c === '\n') {
        fail('chaine non fermee');
      } else {
        value += c;
        i += 1;
      }
    }
    return fail('chaine non fermee');
  }

  function readLiteral() {
    const start = i;
    const m = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 40));
    if (!m) fail('valeur inattendue');
    i += m[0].length;
    let type = 'number';
    let value = Number(m[0]);
    if (m[0] === 'true' || m[0] === 'false') {
      type = 'boolean';
      value = m[0] === 'true';
    } else if (m[0] === 'null') {
      type = 'null';
      value = null;
    }
    return { type, value, start, end: i };
  }

  function readArray() {
    const start = i;
    i += 1;
    const items = [];
    for (;;) {
      skip();
      if (i >= text.length) fail('tableau non ferme');
      if (text[i] === ']') {
        i += 1;
        return { type: 'array', items, start, end: i };
      }
      items.push(readValue());
      skip();
      if (text[i] === ',') i += 1;
      else if (text[i] !== ']') fail('virgule attendue');
    }
  }

  function readObject() {
    const start = i;
    i += 1;
    const props = [];
    for (;;) {
      skip();
      if (i >= text.length) fail('objet non ferme');
      if (text[i] === '}') {
        i += 1;
        return { type: 'object', props, start, end: i };
      }
      if (text[i] !== '"') fail('nom de cle attendu');
      const key = readString();
      skip();
      if (text[i] !== ':') fail('deux-points attendu');
      i += 1;
      props.push({ key: key.value, keyStart: key.start, value: readValue() });
      skip();
      if (text[i] === ',') i += 1;
      else if (text[i] !== '}') fail('virgule attendue');
    }
  }

  function readValue() {
    skip();
    const c = text[i];
    if (c === '{') return readObject();
    if (c === '[') return readArray();
    if (c === '"') return readString();
    return readLiteral();
  }

  const root = readValue();
  skip();
  if (i < text.length) fail('texte apres la valeur');
  return root;
}

function getProp(node, key) {
  if (!node || node.type !== 'object') return undefined;
  const found = node.props.find((p) => p.key === key);
  return found ? found.value : undefined;
}

// Extrait les hooks de type "command" d'un fichier settings de hooks.
// Ne lance rien : lit seulement le texte.
function extractHooks(text) {
  let root;
  try {
    root = parseWithOffsets(text);
  } catch (err) {
    return { hooks: [], error: err.message };
  }
  const hooks = [];
  const section = getProp(root, 'hooks');
  if (!section || section.type !== 'object') return { hooks, error: null };

  for (const eventProp of section.props) {
    if (eventProp.value.type !== 'array') continue;
    for (const group of eventProp.value.items) {
      if (group.type !== 'object') continue;
      const matcherNode = getProp(group, 'matcher');
      const matcher = matcherNode && matcherNode.type === 'string' ? matcherNode.value : '';
      const list = getProp(group, 'hooks');
      if (!list || list.type !== 'array') continue;
      for (const entry of list.items) {
        const typeNode = getProp(entry, 'type');
        const cmdNode = getProp(entry, 'command');
        if (!typeNode || typeNode.value !== 'command') continue;
        if (!cmdNode || cmdNode.type !== 'string') continue;
        hooks.push({
          event: eventProp.key,
          matcher,
          command: cmdNode.value,
          start: cmdNode.start,
          end: cmdNode.end,
        });
      }
    }
  }
  return { hooks, error: null };
}

module.exports = { extractHooks, parseWithOffsets, getProp, JsonScanError };
