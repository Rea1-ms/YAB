'use strict';

// Hidden Chromium regression for the bundled help documents, without starting the backend.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const ts = require('../../webapp/node_modules/typescript');

app.setPath('userData', process.env.YAB_HELP_TEST_DATA);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../..');
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'webapp/src/lib/help-document.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const files = fs.readdirSync(path.join(root, 'src/descriptions'), { recursive: true })
    .filter(name => name.endsWith('.html'));
  const documents = files.map(name => ({ name, html: fs.readFileSync(path.join(root, 'src/descriptions', name), 'utf8') }));
  documents.push({ name: 'inline-colours', html: '<html><head></head><body style="color:black;background:white">'
    + '<span style="color:#000;background-color:#f1c40f">highlight</span>'
    + '<span style="color:#e03e2d">warning</span><a href="https://example.com">link</a></body></html>' });
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadURL('data:text/html,<html><body></body></html>');
  const result = await window.webContents.executeJavaScript(`(async () => {
    const exports = {};
    ${source}
    const documents = ${JSON.stringify(documents)};
    for (const { name, html } of documents) {
      const frame = document.createElement('iframe');
      frame.sandbox = 'allow-same-origin';
      frame.srcdoc = exports.styleHelpDocument(html);
      const loaded = new Promise(resolve => frame.onload = resolve);
      document.body.append(frame);
      await loaded;
      const doc = frame.contentDocument;
      const css = frame.contentWindow.getComputedStyle(doc.body);
      if (css.backgroundColor !== 'rgb(29, 33, 43)' || css.color !== 'rgb(230, 230, 230)')
        throw new Error(name + ': incorrect help canvas: ' + css.backgroundColor + '/' + css.color);
      if (frame.contentWindow.getComputedStyle(doc.documentElement).colorScheme !== 'dark')
        throw new Error(name + ': missing dark scheme');
      for (const link of doc.querySelectorAll('a[href]')) {
        if (link.target !== '_blank' || !link.rel.includes('noopener')) throw new Error(name + ': unsafe external link');
      }
      if (name === 'inline-colours') {
        const highlight = frame.contentWindow.getComputedStyle(doc.querySelector('span'));
        if (highlight.color !== css.color || highlight.backgroundColor === 'rgb(241, 196, 15)')
          throw new Error('Legacy highlight failed to adopt the dark palette');
      }
      frame.remove();
    }
    return { documents: documents.length, darkCanvas: true, inlineColours: true };
  })()`);
  console.log('HELP_RENDER_OK ' + JSON.stringify(result));
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
