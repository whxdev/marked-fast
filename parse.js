/**
 * EXSALA HERMES MOD · powered by Gienetic
 *
 * parse.js — dependency-free ES module.
 * parse(markdown) returns byte-for-byte the HTML marked 18.1.3 renders with
 * default options (gfm: true, breaks: false, pedantic: false).
 *
 * Architecture:
 *   parse()  -> normalize line endings
 *            -> parseBlocks()  (collects link reference definitions into `DEFS`)
 *            -> renderNodes()  (calls inline() on text at render time)
 *
 * The inline engine lives in ONE delimited section at the bottom
 * (INLINE ENGINE START / END) so it can be replaced wholesale.
 *
 * Performance notes (measured, not guessed):
 *   - The delimiter-run closer search for * / _ / ~ is a hand-written run
 *     scanner (emNextRun) instead of marked's three global "RDelim" regexes.
 *     It classifies runs with the same character classes, so the event
 *     stream is identical; it is the single largest win in the inline engine.
 *   - iText uses a copy of marked's text rule with the two "email follows"
 *     alternatives stripped when the whole inline run has no '@'.
 *   - A plain charCodeAt scanner for the text rule was tried and measured
 *     SLOWER in situ than V8's bitmap-class regex (~460ms vs ~405ms for the
 *     40 big practice docs), so the regex is kept.
 *   - Caching the closer events in an array was also slower: generating
 *     events beyond the window costs more than re-running the scan.
 */

/* ==================================================================== */
/* 1. RULES                                                             */
/* ==================================================================== */

const OTHER = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(OTHER.caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, opt);
    },
  };
  return obj;
}


/* \n[ \t]*\n[ \t]*$ without the regex scan */
function endsWithDoubleBlank(str) {
  let i = str.length;
  while (i > 0 && (str.charCodeAt(i - 1) === 32 || str.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || str.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (str.charCodeAt(i - 1) === 32 || str.charCodeAt(i - 1) === 9)) i--;
  return i > 0 && str.charCodeAt(i - 1) === 10;
}

/* /\n.*\n/ without the regex engine */
function hasTwoNewlines(str) {
  const a = str.indexOf('\n');
  if (a === -1) return false;
  return str.indexOf('\n', a + 1) !== -1;
}

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const idx = Math.max(0, Math.min(3, indent - 1));
    let re = cache[idx];
    if (!re) {
      re = createRegex(idx);
      cache[idx] = re;
    }
    return re;
  };
}

const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const blockquoteBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}>`));

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const htmlBeginRegex = cachedIndentRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));

const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

/* ---- block level ---- */

const B_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const B_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const B_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const B_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const B_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const B_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const _lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

const B_LHEADING = edit(_lheadingCore)
  .replace(/bull/g, B_BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/)
  .getRegex();

const _paragraph = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const B_TEXT = /^[^\n]+/;
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

const B_DEF = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

const B_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, B_BULLET)
  .getRegex();

const B_HTML = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

const B_TABLE = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', B_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();

function createParagraph(listInterrupt, tableInterrupt) {
  const edited = edit(_paragraph)
    .replace('hr', B_HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  // the table replacement must precede the html/tag insertion: the tag list
  // itself contains the word "table"
  if (tableInterrupt) edited.replace('table', tableInterrupt);
  else edited.replace('|table', '');
  edited
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', _tag);
  return edited.getRegex();
}

const B_PARAGRAPH = createParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, B_TABLE);
const B_BQ_PARAGRAPH = createParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const B_BLOCKQUOTE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', B_BQ_PARAGRAPH)
  .getRegex();

/* ---- inline level ---- */

const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

const I_PUNCTUATION = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace)
  .getRegex();

/* ASCII fast discriminator for the punctuation rule (identical to the regex) */
const PUNCT_ASCII = new Uint8Array(128);
for (let i = 0; i < 128; i++) PUNCT_ASCII[i] = I_PUNCTUATION.test(String.fromCharCode(i)) ? 1 : 0;

function isPunctChar(ch) {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if (c < 128) return PUNCT_ASCII[c] === 1;
  }
  return I_PUNCTUATION.test(ch);
}

const I_BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const _emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;

const I_EM_STRONG_LDELIM = edit(_emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const _emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)';

const I_EM_STRONG_RDELIM_AST = edit(_emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();

const I_EM_STRONG_RDELIM_UND = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const I_DEL_LDELIM = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();

const _delRDelimCore =
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)';

const I_DEL_RDELIM = edit(_delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();

const I_ANY_PUNCTUATION = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const I_ANY_PUNCTUATION_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();

const I_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();

const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();

const I_TAG = edit(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;

const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const I_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();

const I_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();

const I_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();

const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();

const I_REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();

const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][tPp]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

const I_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, _extendedEmail).getRegex())
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();

const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const I_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const I_TEXT = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

/* Same pattern with the two "email address follows" alternatives removed.
 * Only valid when the whole inline run contains no '@' (checked per run). */
const I_TEXT_NO_AT = (() => {
  const trySrc = I_TEXT.source
    .replace("|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)", "")
    .replace("|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)", "");
  return trySrc.length < I_TEXT.source.length ? new RegExp(trySrc) : null;
})();
let TX_NO_AT = false;

/* text tokens containing none of these need no entity work */
const I_TEXT_CLEAN = /[&<>"']/;

/* ==================================================================== */
/* 2. HELPERS                                                           */
/* ==================================================================== */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (ch) => ESCAPE_MAP[ch];

function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (OTHER.escapeTest.test(html)) return html.replace(OTHER.escapeReplace, escChar);
  } else if (OTHER.escapeTestNoEncode.test(html)) {
    return html.replace(OTHER.escapeReplaceNoEncode, escChar);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (text.indexOf('&') === -1) return text;
  if (!OTHER.numericCharacterReference.test(text)) return text;
  return text.replace(OTHER.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(OTHER.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && OTHER.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(OTHER.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\t') {
      const added = 4 - (col % 4);
      expanded += added === 1 ? ' ' : added === 2 ? '  ' : added === 3 ? '   ' : '    ';
      col += added;
    } else {
      expanded += ch;
      col++;
    }
  }
  return expanded;
}

/* first line of s (no trailing \n), without allocating an array */
function firstLineOf(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.substring(0, i);
}

/* column reached by the leading run of spaces and tabs (tab = 4 columns) */
function leadingCol(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4;
    else break;
  }
  return col;
}

/* index of the first character that is not a space, -1 when none */
function firstNonSpaceIdx(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 32) return i;
  }
  return -1;
}

/* true when the first `len` characters hold only whitespace */
function isBlankLineAt(s, len) {
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (c > 127 || c === 11 || c === 12 || c === 13) return s.slice(0, len).trim() === '';
    return false;
  }
  return true;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(OTHER.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(OTHER.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(OTHER.slashPipe, '|');
  }
  return cells;
}

/* closer hints (em/strong/del window optimisation) */

function scanClosers(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { src, lastEm, lastDel };
}

/* ==================================================================== */
/* 3. BLOCK TOKENIZERS                                                  */
/* ==================================================================== */

function tokSpace(src) {
  const cap = B_NEWLINE.exec(src);
  if (cap && cap[0].length > 0) return { t: 'space', raw: cap[0] };
}

function tokCode(src) {
  const cap = B_CODE.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(OTHER.codeRemoveIndent, '');
    return { t: 'code', raw, text, lang: undefined };
  }
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(OTHER.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const m2 = node.match(OTHER.beginningSpace);
    if (m2 === null) return node;
    const indentInNode = m2[0];
    return node.slice(Math.min(indentInNode.length, indentToCode.length));
  }).join('\n');
}

function tokFences(src) {
  const cap = B_FENCES.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      t: 'code',
      raw,
      text,
      lang: cap[2] ? cap[2].trim().replace(I_ANY_PUNCTUATION, '$1') : cap[2],
    };
  }
}

function tokHeading(src) {
  const cap = B_HEADING.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (OTHER.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || OTHER.endingSpaceTabChar.test(trimmed)) {
        text = trimmed.trim();
      }
    }
    return { t: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
  }
}

function tokHr(src) {
  const cap = B_HR.exec(src);
  if (cap) return { t: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(src, ctx) {
  const cap = B_BLOCKQUOTE.exec(src);
  if (!cap) return;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const children = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (OTHER.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(OTHER.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(OTHER.blockquoteSetextReplace, '\n    $1')
      .replace(OTHER.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    const top = ctx.top;
    ctx.top = true;
    parseBlocks(currentText, ctx, true, true, children);
    ctx.top = top;

    if (lines.length === 0) break;

    const lastToken = children[children.length - 1];

    if (lastToken && (lastToken.t === 'code' || lastToken.t === 'heading' || lastToken.t === 'hr'
      || lastToken.t === 'html' || lastToken.t === 'table')) {
      break;
    } else if (lastToken && lastToken.t === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(OTHER.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(newText, ctx);
      children[children.length - 1] = newToken;

      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      lines = lines.slice(consumed.length);
      if (lines.length > 0 && OTHER.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken && lastToken.t === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText, ctx);
      children[children.length - 1] = newToken;

      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { t: 'blockquote', raw, text, children };
}

function tokList(src, ctx) {
  let cap = B_LIST.exec(src);
  if (!cap) return;

  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;

  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;

  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (B_HR.test(src)) break;

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstLine = firstLineOf(cap[2]);
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(OTHER.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    let nextLine = firstLineOf(src);
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(OTHER.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && OTHER.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesBeginRe = fencesBeginRegex(indent);
      const headingBeginRe = headingBeginRegex(indent);
      const htmlBeginRe = htmlBeginRegex(indent);
      const blockquoteBeginRe = blockquoteBeginRegex(indent);

      while (src) {
        const nl = src.indexOf('\n');
        const rawLen = nl === -1 ? src.length : nl;

        let leadSpaces = 0;
        while (leadSpaces < rawLen && src.charCodeAt(leadSpaces) === 32) leadSpaces++;
        let hasTabInLead = false;
        if (leadSpaces < rawLen && src.charCodeAt(leadSpaces) === 9) {
          hasTabInLead = true;
        }

        let nextLineWithoutTabs = null;

        // A block start needs at most three spaces of indent before its marker.
        if (!hasTabInLead && leadSpaces <= 3) {
          const c1 = src.charCodeAt(leadSpaces);
          if (c1 === 96 || c1 === 126) {
            if (fencesBeginRe.test(src)) break;
          } else if (c1 === 35) {
            if (headingBeginRe.test(src)) break;
          } else if (c1 === 60) {
            if (htmlBeginRe.test(src)) break;
          } else if (c1 === 62) {
            if (blockquoteBeginRe.test(src)) break;
          } else if (c1 === 42 || c1 === 43 || c1 === 45 || c1 === 95 || (c1 >= 48 && c1 <= 57)) {
            if (nextBulletRe.test(src)) break;
            if (hrRe.test(src)) break;
          }
        }

        if (hasTabInLead) {
          const lineStr = src.slice(0, rawLen);
          nextLineWithoutTabs = lineStr.replace(OTHER.leadingSpaceTab, (whitespace) => expandTabs(whitespace));
        }

        const blankNext = isBlankLineAt(src, rawLen);
        const nsp = hasTabInLead
          ? firstNonSpaceIdx(nextLineWithoutTabs)
          : (leadSpaces === rawLen ? -1 : leadSpaces);

        if ((nsp !== -1 && nsp >= indent) || blankNext) {
          nextLine = src.slice(0, rawLen);
          itemContents += '\n' + (hasTabInLead ? nextLineWithoutTabs : nextLine).slice(indent);
        } else {
          if (blankLine) break;
          const lineRaw = src.slice(0, rawLen);
          if (leadingCol(line) >= 4) break;
          if (fencesBeginRe.test(line)) break;
          if (headingBeginRe.test(line)) break;
          if (htmlBeginRe.test(line)) break;
          if (hrRe.test(line)) break;

          let setextContinuation = false;
          if (lineRaw.indexOf('=') !== -1 || lineRaw.indexOf('-') !== -1) {
            setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(lineRaw)
              && B_LHEADING.test(`${line}\n${lineRaw}`);
          }
          const continuation = setextContinuation
            ? `    ${(nextLineWithoutTabs || lineRaw).replace(/^ {0,3}/, '')}`
            : lineRaw;
          itemContents += '\n' + continuation;
          nextLine = lineRaw;
        }

        blankLine = blankNext;
        src = src.substring(rawLen + 1);
        line = hasTabInLead ? nextLineWithoutTabs.slice(indent) : nextLine.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithDoubleBlank(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      raw,
      task: OTHER.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      children: [],
      checked: false,
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    ctx.top = false;
    item.children = parseBlocks(item.text, ctx, false);
    if (!list.loose) {
      let hasMultiple = false;
      for (let k = 0; k < item.children.length; k++) {
        const tk = item.children[k];
        if (tk.t === 'space' && hasTwoNewlines(tk.raw)) {
          hasMultiple = true;
          break;
        }
      }
      list.loose = hasMultiple;
    }
  }

  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i];
    const itemToken = item.children[0];
    if (item.task && itemToken && (itemToken.t === 'text' || itemToken.t === 'paragraph')) {
      item.text = item.text.replace(OTHER.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(OTHER.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(OTHER.listReplaceTask, '');

      const taskRaw = OTHER.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        item.checked = taskRaw[0] !== '[ ]';
      } else {
        item.task = false;
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (let i = 0; i < list.items.length; i++) list.items[i].loose = true;
  }

  return list;
}

function tokHtml(src) {
  const cap = B_HTML.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { t: 'html', raw, text: raw };
  }
}

function tokDef(src, ctx) {
  const cap = B_DEF.exec(src);
  if (!cap) return;
  if (!OTHER.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;

  const tag = normalizeLabel(cap[1]);
  const href = cap[2]
    ? cap[2].replace(OTHER.hrefBrackets, '$1').replace(I_ANY_PUNCTUATION, '$1')
    : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I_ANY_PUNCTUATION, '$1') : cap[3];
  return { t: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tokTable(src) {
  const cap = B_TABLE.exec(src);
  if (!cap) return;
  if (!OTHER.tableDelimiter.test(cap[2])) return;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(OTHER.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim()
    ? cap[3].replace(OTHER.tableRowBlankLine, '').split('\n')
    : [];

  if (headers.length !== aligns.length) return;

  const align = [];
  for (let i = 0; i < aligns.length; i++) {
    const al = aligns[i];
    if (OTHER.tableAlignRight.test(al)) align.push('right');
    else if (OTHER.tableAlignCenter.test(al)) align.push('center');
    else if (OTHER.tableAlignLeft.test(al)) align.push('left');
    else align.push(null);
  }

  const outRows = [];
  for (let i = 0; i < rows.length; i++) {
    outRows.push(splitCells(rows[i], headers.length));
  }

  return { t: 'table', raw: rtrim(cap[0], '\n'), aligns: align, header: headers, rows: outRows };
}

function tokLheading(src) {
  const cap = B_LHEADING.exec(src);
  if (cap) {
    return {
      t: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text: cap[1].trim(),
    };
  }
}

function tokParagraph(src) {
  const cap = B_PARAGRAPH.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { t: 'paragraph', raw: cap[0], text };
  }
}

function tokText(src) {
  const cap = B_TEXT.exec(src);
  if (cap) return { t: 'text', raw: cap[0], text: cap[0] };
}

/* ==================================================================== */
/* 4. BLOCK PARSER                                                      */
/* ==================================================================== */

function parseBlocks(src, ctx, top, lastParagraphClipped, into) {
  const nodes = into || [];
  if (top !== undefined) ctx.top = top;
  let srcLength = Infinity;

  while (src) {
    if (src.length < srcLength) srcLength = src.length;
    else break;

    let token;
    const c0 = src.charCodeAt(0);

    if (c0 === 10 || c0 === 32 || c0 === 9) {
      if ((token = tokSpace(src))) {
        src = src.substring(token.raw.length);
        const lastToken = nodes[nodes.length - 1];
        if (token.raw.length === 1 && lastToken !== undefined) {
          lastToken.raw += '\n';
        } else {
          nodes.push(token);
        }
        continue;
      }
    }

    // first character after up to three spaces of indent
    let lead = 0;
    if (c0 === 32) {
      while (src.charCodeAt(lead) === 32) lead++;
    }
    const c = src.charCodeAt(lead);

    if (c === 9 || lead >= 4) {
      if ((token = tokCode(src))) {
        src = src.substring(token.raw.length);
        const lastToken = nodes[nodes.length - 1];
        if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
        } else {
          nodes.push(token);
        }
        continue;
      }
    }

    if (c === 96 || c === 126) {
      if ((token = tokFences(src))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 35) {
      if ((token = tokHeading(src))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 45 || c === 95 || c === 42) {
      if ((token = tokHr(src))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 62) {
      if ((token = tokBlockquote(src, ctx))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 42 || c === 43 || c === 45 || (c >= 48 && c <= 57)) {
      if ((token = tokList(src, ctx))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 60) {
      if ((token = tokHtml(src))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (c === 91) {
      if ((token = tokDef(src, ctx))) {
        src = src.substring(token.raw.length);
        const lastToken = nodes[nodes.length - 1];
        if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
        } else {
          if (!ctx.defs.has(token.tag)) {
            ctx.defs.set(token.tag, { href: token.href, title: token.title });
          }
          nodes.push(token);
        }
        continue;
      }
    }

    const nl = src.indexOf('\n');
    if (nl !== -1) {
      let d = nl + 1;
      while (src.charCodeAt(d) === 32) d++;
      const c2 = src.charCodeAt(d);
      if (c2 === 124 || c2 === 58 || c2 === 45) {
        if ((token = tokTable(src))) {
          src = src.substring(token.raw.length);
          nodes.push(token);
          continue;
        }
      }

      if ((token = tokLheading(src))) {
        src = src.substring(token.raw.length);
        nodes.push(token);
        continue;
      }
    }

    if (ctx.top && (token = tokParagraph(src))) {
      const lastToken = nodes[nodes.length - 1];
      if (lastParagraphClipped && lastToken && lastToken.t === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        nodes.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    if ((token = tokText(src))) {
      src = src.substring(token.raw.length);
      const lastToken = nodes[nodes.length - 1];
      if (lastToken && lastToken.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
      } else {
        nodes.push(token);
      }
      continue;
    }

    if (src) break;
  }

  ctx.top = true;
  return nodes;
}

/* ==================================================================== */
/* 5. BLOCK RENDERER                                                    */
/* ==================================================================== */

const CHECKBOX_UNCHECKED = '<input disabled="" type="checkbox"> ';
const CHECKBOX_CHECKED = '<input checked="" disabled="" type="checkbox"> ';

function renderCode(n) {
  const lang = n.lang || '';
  const m = lang.match(OTHER.notSpaceStart);
  const langString = m ? m[0] : '';
  const text = n.text;
  const code = text ? text.replace(OTHER.endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeHtmlEntities(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-' + escapeHtmlEntities(langString)
    + '">' + escapeHtmlEntities(code, true) + '</code></pre>\n';
}

function renderTable(n, out) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let i = 0; i < n.header.length; i++) {
    const al = n.aligns[i];
    const tag = al ? '<th align="' + al + '">' : '<th>';
    out.push(tag, inline(n.header[i]), '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (n.rows.length > 0) {
    out.push('<tbody>');
    for (let r = 0; r < n.rows.length; r++) {
      const row = n.rows[r];
      out.push('<tr>\n');
      for (let c = 0; c < row.length; c++) {
        const al = n.aligns[c];
        const tag = al ? '<td align="' + al + '">' : '<td>';
        out.push(tag, inline(row[c]), '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

function renderNodes(nodes, out, tight, prefix) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.t) {
      case 'space':
        break;
      case 'heading': {
        const d = n.depth;
        out.push('<h', d === 1 ? '1' : d === 2 ? '2' : d === 3 ? '3' : d === 4 ? '4' : d === 5 ? '5' : '6', '>');
        out.push(inline(n.text));
        out.push('</h', d === 1 ? '1' : d === 2 ? '2' : d === 3 ? '3' : d === 4 ? '4' : d === 5 ? '5' : '6', '>\n');
        break;
      }
      case 'paragraph':
        out.push('<p>', inline(n.text), '</p>\n');
        break;
      case 'text': {
        const body = inline(n.text);
        if (tight) {
          if (i === 0 && prefix) out.push(prefix);
          out.push(body);
        } else {
          out.push('<p>', i === 0 && prefix ? prefix : '', body, '</p>\n');
        }
        break;
      }
      case 'code':
        out.push(renderCode(n));
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(n.text);
        break;
      case 'def':
        break;
      case 'blockquote':
        out.push('<blockquote>\n');
        renderNodes(n.children, out, false, null);
        out.push('</blockquote>\n');
        break;
      case 'list': {
        const ordered = n.ordered;
        const type = ordered ? 'ol' : 'ul';
        out.push('<', type);
        if (ordered && n.start !== 1) out.push(' start="', String(n.start), '"');
        out.push('>\n');
        for (let k = 0; k < n.items.length; k++) {
          const item = n.items[k];
          out.push('<li>');
          const cb = item.task ? (item.checked ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED) : null;
          renderNodes(item.children, out, !n.loose, cb);
          out.push('</li>\n');
        }
        out.push('</', type, '>\n');
        break;
      }
      case 'table':
        renderTable(n, out);
        break;
      default:
        break;
    }
  }
}

/* ==================================================================== */
/* 6. INLINE ENGINE START                                               */
/* ==================================================================== */

/* Link reference definitions for the parse in flight (label -> {href,title}). */
let DEFS = new Map();

const IST = {
  inLink: false,
  inRawBlock: false,
  linkEmitted: false,
  linkParenPossible: true,
  depth: 0,
};

/* Characters that can start a GFM extended autolink (email / www. / protocol). */
const URL_START = new Uint8Array(128);
(() => {
  const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+-';
  for (let i = 0; i < s.length; i++) URL_START[s.charCodeAt(i)] = 1;
})();

/**
 * inline(text) -> html string.
 * Renders one inline run. `textMode` (second argument, internal) renders the
 * plain-text form used for image alt attributes.
 */
function inline(src) {
  const outerLP = IST.linkParenPossible;
  IST.linkParenPossible = outerLP && src.indexOf(')') !== -1;

  if (IST.depth === 0) IST.inRawBlock = false;
  IST.depth++;
  try {
    return inlineRun(src, false);
  } finally {
    IST.depth--;
    IST.linkParenPossible = outerLP;
  }
}

function inlineAlt(src) {
  const outerLP = IST.linkParenPossible;
  IST.linkParenPossible = outerLP && src.indexOf(')') !== -1;
  IST.depth++;
  try {
    return inlineRun(src, true);
  } finally {
    IST.depth--;
    IST.linkParenPossible = outerLP;
  }
}

function lastEmCloser(maskedSrc, delim) {
  if (CL_SRC === maskedSrc) {
    if (CL_SCAN === null) CL_SCAN = scanClosers(maskedSrc);
    return CL_SCAN.lastEm[delim];
  }
  return scanClosers(maskedSrc).lastEm[delim];
}

function lastDelCloser(maskedSrc) {
  if (CL_SRC === maskedSrc) {
    if (CL_SCAN === null) CL_SCAN = scanClosers(maskedSrc);
    return CL_SCAN.lastDel;
  }
  return scanClosers(maskedSrc).lastDel;
}

function linkInText(text) {
  if (text.indexOf('[') === -1) return false;

  I_BLOCK_SKIP.lastIndex = 0;
  let m;
  while ((m = I_BLOCK_SKIP.exec(text)) !== null) {
    if (I_LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }

  I_REFLINK_SEARCH.lastIndex = 0;
  while ((m = I_REFLINK_SEARCH.exec(text)) !== null) {
    const match0 = m[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !DEFS.has(normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(src) {
  let maskedSrc = src;

  if (DEFS.size !== 0 && src.indexOf('[') !== -1 && src.indexOf(']') !== -1) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!DEFS.has(normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          I_REFLINK_SEARCH.lastIndex = 0;
          return '[' + text.replace(I_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    I_REFLINK_SEARCH.lastIndex = 0;
    maskedSrc = maskedSrc.replace(I_REFLINK_SEARCH, maskReflink);
  }

  const hasBacktick = src.indexOf('`') !== -1;
  const hasBracket = src.indexOf('[') !== -1;
  const hasAngle = src.indexOf('<') !== -1;

  if (hasBacktick || src.indexOf('\\') !== -1) {
    maskedSrc = maskedSrc.replace(I_ANY_PUNCTUATION_OUTSIDE_CODE, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }

  if (hasBracket || hasBacktick || hasAngle) {
    maskedSrc = maskedSrc.replace(I_BLOCK_SKIP, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

let T_TEXT = '';
let T_HREF = '';
let T_HTML = '';
let T_CLEAN = false;
let CL_SRC = null;
let CL_SCAN = null;

function cpCount(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xDC00 && d <= 0xDFFF) {
        n--;
        i++;
      }
    }
  }
  return n;
}

function firstCpLen(s) {
  const c = s.charCodeAt(0);
  if (c >= 0xD800 && c <= 0xDBFF && s.length > 1) {
    const d = s.charCodeAt(1);
    if (d >= 0xDC00 && d <= 0xDFFF) return 2;
  }
  return 1;
}

function inlineRun(src, tm) {
  const prevNoAt = TX_NO_AT;
  TX_NO_AT = I_TEXT_NO_AT !== null && src.indexOf('@') === -1;
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  const out = [];

  /* Masking (code spans, links, tags, escapes -> neutral text of the same
   * length) is only needed once a delimiter character is actually reached, so
   * it is computed at the first emphasis/strikethrough delimiter instead of
   * up front.  It always masks
   * the whole run, never the current suffix, because the emphasis scanner
   * derives absolute offsets from maskedSrc.length - src.length. */
  const fullSrc = src;
  let maskedSrc = null;
  const needMask = src.indexOf('*') !== -1 || src.indexOf('_') !== -1
    || src.indexOf('~') !== -1;

  const savedClSrc = CL_SRC;
  const savedClScan = CL_SCAN;
  CL_SRC = maskedSrc;
  CL_SCAN = null;
  try {
    while (src) {
      if (src.length >= srcLength) break;
      srcLength = src.length;

      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;

      const c = src.charCodeAt(0);
      let n;

      if (c === 92) {
        if ((n = iEscape(src)) !== 0) {
          src = src.substring(n);
          out.push(tm ? T_TEXT : escapeHtmlEntities(T_TEXT));
          continue;
        }
        if ((n = iBr(src)) !== 0) {
          src = src.substring(n);
          if (!tm) out.push('<br>');
          continue;
        }
      } else if (c === 60) {
        if ((n = iTag(src)) !== 0) {
          src = src.substring(n);
          out.push(T_TEXT);
          continue;
        }
        if ((n = iAutolink(src)) !== 0) {
          src = src.substring(n);
          out.push(tm ? T_TEXT : renderLinkHtml(T_HREF, null, escapeHtmlEntities(T_TEXT, true), true));
          continue;
        }
      } else if (c === 33) {
        if (src.charCodeAt(1) === 91) {
          if ((n = iLink(src, tm)) !== 0) {
            src = src.substring(n);
            out.push(T_HTML);
            continue;
          }
          if ((n = iReflink(src, tm)) !== 0) {
            src = src.substring(n);
            out.push(T_HTML);
            continue;
          }
        }
      } else if (c === 91) {
        if ((n = iLink(src, tm)) !== 0) {
          src = src.substring(n);
          out.push(T_HTML);
          continue;
        }
        if ((n = iReflink(src, tm)) !== 0) {
          src = src.substring(n);
          out.push(T_HTML);
          continue;
        }
      } else if (c === 42 || c === 95) {
        if (maskedSrc === null) maskedSrc = needMask ? maskSrc(fullSrc) : fullSrc;
        if ((n = iEmStrong(src, maskedSrc, prevChar, tm)) !== 0) {
          src = src.substring(n);
          out.push(T_HTML);
          continue;
        }
      } else if (c === 96) {
        if ((n = iCodespan(src)) !== 0) {
          src = src.substring(n);
          out.push(tm ? T_TEXT : '<code>' + escapeHtmlEntities(T_TEXT, true) + '</code>');
          continue;
        }
      } else if (c === 126) {
        if (maskedSrc === null) maskedSrc = needMask ? maskSrc(fullSrc) : fullSrc;
        if ((n = iDel(src, maskedSrc, prevChar, tm)) !== 0) {
          src = src.substring(n);
          out.push(T_HTML);
          continue;
        }
      } else if (c === 32) {
        if ((n = iBr(src)) !== 0) {
          src = src.substring(n);
          if (!tm) out.push('<br>');
          continue;
        }
      }

      if (!IST.inLink && c < 128 && URL_START[c] === 1) {
        if ((n = iUrl(src)) !== 0) {
          src = src.substring(n);
          out.push(tm ? T_TEXT : renderLinkHtml(T_HREF, null, escapeHtmlEntities(T_TEXT, true), true));
          continue;
        }
      }

      if ((n = iText(src)) !== 0) {
        if (src.charCodeAt(n - 1) !== 95) prevChar = src.charAt(n - 1);
        keepPrevChar = true;
        src = n === src.length ? '' : src.substring(n);
        out.push(tm || T_CLEAN ? T_TEXT : escapeHtmlEntities(T_TEXT));
        continue;
      }

      break;
    }
  } finally {
    CL_SRC = savedClSrc;
    CL_SCAN = savedClScan;
    TX_NO_AT = prevNoAt;
  }

  return out.join('');
}

function iEscape(src) {
  const cap = I_ESCAPE.exec(src);
  if (!cap) return 0;
  T_TEXT = cap[1];
  return cap[0].length;
}

function iTag(src) {
  const cap = I_TAG.exec(src);
  if (!cap) return 0;
  if (!IST.inLink && OTHER.startATag.test(cap[0])) {
    IST.inLink = true;
  } else if (IST.inLink && OTHER.endATag.test(cap[0])) {
    IST.inLink = false;
  }
  if (!IST.inRawBlock && OTHER.startPreScriptTag.test(cap[0])) {
    IST.inRawBlock = true;
  } else if (IST.inRawBlock && OTHER.endPreScriptTag.test(cap[0])) {
    IST.inRawBlock = false;
  }
  T_TEXT = cap[0];
  return cap[0].length;
}

function iCodespan(src) {
  const cap = I_CODE.exec(src);
  if (!cap) return 0;
  let text = cap[2].replace(OTHER.newLineCharGlobal, ' ');
  if (OTHER.nonSpaceChar.test(text) && OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  T_TEXT = text;
  return cap[0].length;
}

function iBr(src) {
  const cap = I_BR.exec(src);
  if (!cap) return 0;
  return cap[0].length;
}

function iAutolink(src) {
  const cap = I_AUTOLINK.exec(src);
  if (!cap) return 0;
  if (cap[2] === '@') {
    T_TEXT = cap[1];
    T_HREF = 'mailto:' + cap[1];
  } else {
    T_TEXT = cap[1];
    T_HREF = cap[1];
  }
  return cap[0].length;
}

function iUrl(src) {
  const cap = I_URL.exec(src);
  if (!cap) return 0;
  if (cap[2] === '@') {
    T_TEXT = cap[0];
    T_HREF = 'mailto:' + cap[0];
    return cap[0].length;
  }
  let prevCapZero;
  do {
    prevCapZero = cap[0];
    const bp = I_BACKPEDAL.exec(cap[0]);
    cap[0] = bp ? bp[0] : '';
  } while (prevCapZero !== cap[0]);
  if (!cap[0]) return 0;
  T_TEXT = cap[0];
  T_HREF = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  return cap[0].length;
}

function iText(src) {
  const cap = (TX_NO_AT && I_TEXT_NO_AT !== null ? I_TEXT_NO_AT : I_TEXT).exec(src);
  if (!cap) return 0;
  const raw = cap[0];
  if (IST.inRawBlock) {
    T_TEXT = raw;
    T_CLEAN = true;
    return raw.length;
  }
  if (I_TEXT_CLEAN.test(raw)) {
    T_CLEAN = false;
    T_TEXT = decodeNumericCharacterReferences(raw);
  } else {
    T_CLEAN = true;
    T_TEXT = raw;
  }
  return raw.length;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (label.indexOf('<') === -1) return false;

  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I_CODE.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;

    const tokenSrc = src.slice(labelStart + i);
    const token = I_TAG.exec(tokenSrc) || I_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function renderLinkHtml(href, title, text, autolink) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return text;
  let out = '<a href="' + escapeHtmlEntities(cleanHref, autolink) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  out += '>' + text + '</a>';
  return out;
}

function renderImageHtml(href, title, text) {
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return escapeHtmlEntities(text);
  let out = '<img src="' + escapeHtmlEntities(cleanHref)
    + '" alt="' + escapeHtmlEntities(text) + '"';
  if (title) out += ' title="' + escapeHtmlEntities(title) + '"';
  out += '>';
  return out;
}

function outputLink(cap, href, title, rawLen, tm) {
  const text = cap[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = IST.inLink;
  const outerLinkEmitted = IST.linkEmitted;
  const outerInRawBlock = IST.inRawBlock;
  IST.inLink = true;
  IST.linkEmitted = false;
  const inner = isImage ? inlineAlt(text) : inline(text);
  const textHasLink = IST.linkEmitted;
  IST.linkEmitted = outerLinkEmitted;
  IST.inLink = outerInLink;

  if (!isImage) {
    if (textHasLink) {
      IST.inRawBlock = outerInRawBlock;
      return 0;
    }
    IST.linkEmitted = true;
  }

  if (tm) {
    T_HTML = inner;
    return rawLen;
  }

  T_HTML = isImage ? renderImageHtml(href, title || null, inner) : renderLinkHtml(href, title || null, inner, false);
  return rawLen;
}

function iLink(src, tm) {
  if (IST.linkParenPossible === false) return 0;
  const cap = I_LINK.exec(src);
  if (!cap) return 0;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return 0;

  const trimmedUrl = cap[2].trim();
  if (OTHER.startAngleBracket.test(trimmedUrl)) {
    if (!OTHER.endAngleBracket.test(trimmedUrl)) return 0;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return 0;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return 0;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }

  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return 0;

  let href = cap[2];
  let title = cap[3] ? cap[3].slice(1, -1) : '';

  href = href.trim();
  if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);

  return outputLink(cap,
    href ? href.replace(I_ANY_PUNCTUATION, '$1') : href,
    title ? title.replace(I_ANY_PUNCTUATION, '$1') : title,
    cap[0].length, tm);
}

function iReflink(src, tm) {
  let cap;
  if ((cap = I_REFLINK.exec(src)) || (cap = I_NOLINK.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return 0;

    const link = DEFS.get(normalizeLabel(cap[2] || cap[1]));
    if (!link) {
      const text = cap[0].charAt(0);
      T_HTML = text;
      return 1;
    }
    return outputLink(cap, link.href, link.title, cap[0].length, tm);
  }
  return 0;
}


/* ---- closer-run scanner for em/strong and strikethrough -------------
 * marked finds closers by running one big global regex per delimiter char
 * (emStrongRDelimAst / emStrongRDelimUnd / delRDelim).  The same events are
 * produced here by scanning delimiter runs and classifying them with the very
 * same character classes, which removes the per-character regexp cost.  The
 * events are cached per inline run because every opener re-walks the same
 * tail; the cache is saved/restored around nested inline runs in inline().
 */

const TX_WS = new Uint8Array(128);   /* \s                     */
const TX_PU = new Uint8Array(128);   /* \p{P}\p{S}             */
const TX_PS = new Uint8Array(128);   /* \s\p{P}\p{S}          */
const TX_NP = new Uint8Array(128);   /* ^\s\p{P}\p{S}         */
const TX_PUG = new Uint8Array(128);  /* \p{P}\p{S} minus ~    */
const TX_PSG = new Uint8Array(128);  /* \s\p{P}\p{S} minus ~ */
const TX_NPG = new Uint8Array(128);  /* ^\s\p{P}\p{S} plus ~  */
const RX_WS = /\s/;
const RX_PU = /[\p{P}\p{S}]/u;
const RX_PS = /[\s\p{P}\p{S}]/u;
const RX_NP = /[^\s\p{P}\p{S}]/u;
const RX_PUG = /(?!~)[\p{P}\p{S}]/u;
const RX_PSG = /(?!~)[\s\p{P}\p{S}]/u;
const RX_NPG = /(?:[^\s\p{P}\p{S}]|~)/u;
for (let i = 0; i < 128; i++) {
  const ch = String.fromCharCode(i);
  TX_WS[i] = RX_WS.test(ch) ? 1 : 0;
  TX_PU[i] = RX_PU.test(ch) ? 1 : 0;
  TX_PS[i] = RX_PS.test(ch) ? 1 : 0;
  TX_NP[i] = RX_NP.test(ch) ? 1 : 0;
  TX_PUG[i] = RX_PUG.test(ch) ? 1 : 0;
  TX_PSG[i] = RX_PSG.test(ch) ? 1 : 0;
  TX_NPG[i] = RX_NPG.test(ch) ? 1 : 0;
}

function txWS(c) { return c < 128 ? TX_WS[c] === 1 : RX_WS.test(String.fromCodePoint(c)); }
function txPU(c) { return c < 128 ? TX_PU[c] === 1 : RX_PU.test(String.fromCodePoint(c)); }
function txPS(c) { return c < 128 ? TX_PS[c] === 1 : RX_PS.test(String.fromCodePoint(c)); }
function txNP(c) { return c < 128 ? TX_NP[c] === 1 : RX_NP.test(String.fromCodePoint(c)); }
function txPUG(c) { return c < 128 ? TX_PUG[c] === 1 : RX_PUG.test(String.fromCodePoint(c)); }
function txPSG(c) { return c < 128 ? TX_PSG[c] === 1 : RX_PSG.test(String.fromCodePoint(c)); }
function txNPG(c) { return c < 128 ? TX_NPG[c] === 1 : RX_NPG.test(String.fromCodePoint(c)); }

/* the two "tricky prefix" alternatives of the delimiter regexes (^ anchored) */
const I_EM_AST0 = /[^_*]*?__[^_*]*?\*[^_*]*?(?=__)/y;
const I_EM_UND0 = /[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)/y;

/* Next delimiter run at or after `from` that the marked pattern reports as a
 * closer/opener event.  kind: 0 = '*' (gfm strong/em), 1 = '_', 2 = '~'. */
function emNextRun(src, from, kind) {
  const delim = kind === 0 ? 42 : kind === 1 ? 95 : 126;
  let r = src.indexOf(String.fromCharCode(delim), from);
  while (r !== -1) {
    let e = r + 1;
    while (src.charCodeAt(e) === delim) e++;
    const rl = e - r;
    let p = -1;
    let plen = 0;
    if (r > 0) {
      const c = src.charCodeAt(r - 1);
      if (c >= 0xDC00 && c <= 0xDFFF && r > 1) {
        const c0 = src.charCodeAt(r - 2);
        if (c0 >= 0xD800 && c0 <= 0xDBFF) { p = src.codePointAt(r - 2); plen = 2; }
        else { p = c; plen = 1; }
      } else { p = c; plen = 1; }
    }
    let cap = 0;
    if (p >= 0) {
      const n = e < src.length ? src.codePointAt(e) : -1;
      if (kind === 0) {
        const nWS = n < 0 || txWS(n);
        const nPSG = n < 0 || txPSG(n);
        const nPG = n >= 0 && txPUG(n);
        const nNPG = n >= 0 && txNPG(n);
        if (txPUG(p) && p !== 42 && nWS) cap = 1;
        else if (txNPG(p) && nPSG) cap = 2;
        else if (txPSG(p) && p !== 42 && nNPG) cap = 3;
        else if (txWS(p) && nPG) cap = 4;
        else if (txPUG(p) && p !== 42 && nPG) cap = 5;
        else if (txNPG(p) && nNPG) cap = 6;
      } else if (kind === 1) {
        const nWS = n < 0 || txWS(n);
        const nPS = n < 0 || txPS(n);
        const nP = n >= 0 && txPU(n);
        const nNP = n >= 0 && txNP(n);
        if (txPU(p) && p !== 95 && nWS) cap = 1;
        else if (txNP(p) && nPS) cap = 2;
        else if (txPS(p) && p !== 95 && nNP) cap = 3;
        else if (txWS(p) && nP) cap = 4;
        else if (txPU(p) && p !== 95 && nP) cap = 5;
      } else if (rl <= 2) {
        const nWS = n < 0 || txWS(n);
        const nPS = n < 0 || txPS(n);
        const nP = n >= 0 && txPU(n);
        const nNP = n >= 0 && txNP(n);
        if (txPU(p) && p !== 126 && nWS) cap = 1;
        else if (txNP(p) && nPS) cap = 2;
        else if (txPS(p) && p !== 126 && nNP) cap = 3;
        else if (txWS(p) && nP) cap = 4;
        else if (txPU(p) && p !== 126 && nP) cap = 5;
        else if (txNP(p) && nNP) cap = 6;
      }
    }
    if (cap) {
      NFC.i = r - plen;
      NFC.p = plen;
      NFC.n = rl;
      NFC.c = cap;
      NFC.e = e;
      return cap;
    }
    r = src.indexOf(String.fromCharCode(delim), e);
  }
  return 0;
}

/* Scratch result of emNextRun (avoids allocating an object per run). */
const NFC = { i: 0, p: 0, n: 0, c: 0, e: 0 };

function iEmStrong(src, maskedSrc, prevChar, tm) {
  let match = I_EM_STRONG_LDELIM.exec(src);
  if (!match) return 0;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return 0;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  let runPrevChar = '';
  if (runStart > 0) {
    const rc = maskedSrc.charCodeAt(runStart - 1);
    if (runStart > 1 && rc >= 0xDC00 && rc <= 0xDFFF) {
      const rc0 = maskedSrc.charCodeAt(runStart - 2);
      runPrevChar = (rc0 >= 0xD800 && rc0 <= 0xDBFF)
        ? maskedSrc.slice(runStart - 2, runStart)
        : maskedSrc.charAt(runStart - 1);
    } else {
      runPrevChar = maskedSrc.charAt(runStart - 1);
    }
  }
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctChar(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : isPunctChar(prevChar);

  if (match[4] && OTHER.unicodeAlphaNumeric.test(prevChar)) return 0;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = cpCount(match[0]) - 1;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return 0;
    const kind = delimChar === '*' ? 0 : 1;
    const lastPossible = lastEmCloser(maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return 0;
    const lastInWindow = lastPossible - windowStart;

    let cursor = windowStart;
    const zero = kind === 0 ? I_EM_AST0 : I_EM_UND0;
    zero.lastIndex = windowStart;
    const a0 = zero.exec(maskedSrc);
    if (a0 !== null) cursor = windowStart + a0[0].length;

    for (;;) {
      const cIdx = emNextRun(maskedSrc, cursor, kind);
      if (cIdx === 0) break;
      cursor = NFC.e;
      const at = NFC.i - windowStart;
      if (at > lastInWindow) break;
      const capped = cIdx;
      rLength = NFC.n;

      if (capped === 3 || capped === 4) {
        delimTotal += rLength;
        continue;
      } else if (capped === 5 || capped === 6 || openerCanClose) {
        if (midRun && (capped === 5 || capped === 6)) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const rawLen = lLength + at + NFC.p + rLength;

      if (Math.min(lLength, rLength) % 2) {
        const text = src.slice(1, rawLen - 1);
        T_HTML = tm ? inlineAlt(text) : '<em>' + inline(text) + '</em>';
        return rawLen;
      }
      const text = src.slice(2, rawLen - 2);
      T_HTML = tm ? inlineAlt(text) : '<strong>' + inline(text) + '</strong>';
      return rawLen;
    }
  }
  return 0;
}

function iDel(src, maskedSrc, prevChar, tm) {
  let match = I_DEL_LDELIM.exec(src);
  if (!match) return 0;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || isPunctChar(prevChar)) {
    const lLength = cpCount(match[0]) - 1;
    let rLength;
    let delimTotal = lLength;

    const lastPossible = lastDelCloser(maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return 0;
    const lastInWindow = lastPossible - windowStart;

    let cursor = windowStart;

    for (;;) {
      const capped = emNextRun(maskedSrc, cursor, 2);
      if (capped === 0) break;
      cursor = NFC.e;
      const at = NFC.i - windowStart;
      if (at > lastInWindow) break;
      rLength = NFC.n;
      if (rLength !== lLength) continue;
      if (capped === 3 || capped === 4) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const rawLen = lLength + at + NFC.p + rLength;
      const text = src.slice(lLength, rawLen - lLength);
      T_HTML = tm ? inlineAlt(text) : '<del>' + inline(text) + '</del>';
      return rawLen;
    }
  }
  return 0;
}

/* ==================================================================== */
/* 7. INLINE ENGINE END                                                 */
/* ==================================================================== */

/* ==================================================================== */
/* 8. ENTRY POINT                                                       */
/* ==================================================================== */

export function parse(markdown) {
  const raw = String(markdown);
  const src = raw.indexOf('\r') === -1 ? raw : raw.replace(OTHER.carriageReturn, '\n');
  const ctx = { top: true, defs: new Map() };
  const nodes = parseBlocks(src, ctx);
  DEFS = ctx.defs;
  IST.inLink = false;
  IST.linkEmitted = false;
  IST.depth = 0;
  IST.linkParenPossible = true;
  const out = [];
  renderNodes(nodes, out, false, null);
  return out.join('');
}

export default parse;
