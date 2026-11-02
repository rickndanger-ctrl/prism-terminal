import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

/** Text extraction, not a browser or HTML renderer. No URL is opened. */
export function gmailHtmlText(html: string) {
  const inputLimit = 262144;
  const textLimit = 16000;
  let truncated = html.length > inputLimit;
  let omitted = false;
  const tree = parseFragment(html.slice(0, inputLimit));
  const stack: { node: DefaultTreeAdapterMap['node']; depth: number; separator?: boolean }[] = [{ node: tree, depth: 0 }];
  const blocked = new Set(['script', 'style', 'template', 'head', 'title', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'input', 'textarea', 'select']);
  const blocks = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'br', 'hr', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']);
  const chunks: string[] = [];
  let length = 0;
  let visited = 0;
  function append(value: string) {
    const room = textLimit - length;
    if (value.length > room) truncated = true;
    const piece = value.slice(0, Math.max(0, room));
    chunks.push(piece); length += piece.length;
  }
  while (stack.length) {
    const { node, depth, separator } = stack.pop()!;
    if (separator) { append('\n'); continue; }
    if (++visited > 20000 || length >= textLimit) { truncated = true; break; }
    if (depth > 100) { truncated = true; omitted = true; continue; }
    if ('value' in node && node.nodeName === '#text') { append(node.value); continue; }
    if ('tagName' in node) {
      const attribute = (name: string) => node.attrs.find(a => a.name === name)?.value;
      const hidden = attribute('hidden') !== undefined || attribute('aria-hidden')?.toLowerCase() === 'true'
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(attribute('style') ?? '');
      if (blocked.has(node.tagName) || hidden || node.tagName === 'img') { omitted = true; continue; }
      if (blocks.has(node.tagName)) {
        append('\n');
        stack.push({ node, depth, separator: true });
      }
    }
    if ('childNodes' in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node.childNodes[i]!, depth: depth + 1 });
      }
    }
  }
  return { text: chunks.join('').replace(/[\t\r \u00a0]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim(), truncated, omitted };
}
