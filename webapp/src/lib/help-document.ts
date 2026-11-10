/** Give full HTML documents their own canvas; iframe documents do not inherit the app theme. */
export function styleHelpDocument(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const neutral = /^(?:black|white|rgb\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\s*\))$/i;
  // Keep coloured emphasis, while replacing the editor's black/white text and bright highlights.
  for (const node of doc.querySelectorAll<HTMLElement>('[style], font[color]')) {
    const color = node.style.color || node.getAttribute('color');
    node.removeAttribute('color');
    if (color) {
      node.style.color = neutral.test(color) ? 'inherit' : `color-mix(in srgb, ${color} 75%, #e6e6e6)`;
    }
    const background = node.style.backgroundColor;
    if (background) {
      node.style.backgroundColor = `color-mix(in srgb, ${background} 22%, #1d212b)`;
    }
  }
  for (const link of doc.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const style = doc.createElement('style');
  style.textContent = `
    :root { color-scheme: dark; }
    html, body { background: #1d212b !important; color: #e6e6e6 !important; }
    body { margin: 0; padding: 18px; font: 14px/1.7 "Segoe UI", "Microsoft YaHei UI", sans-serif;
      overflow-wrap: anywhere; }
    a, a:visited { color: #9bb9ff !important; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    code { background: #161922; color: #cbd8ff; border-radius: 4px; padding: 2px 4px; }
    table { border-collapse: collapse; max-width: 100%; }
    th, td { border-color: #495365 !important; padding: 5px 8px; }
    hr { border: 0; border-top: 1px solid #495365; }
    img { max-width: 100%; height: auto; }
  `;
  doc.head.append(style);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
