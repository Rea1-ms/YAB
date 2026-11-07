'use strict';

const fs = require('fs');
const path = require('path');

// Instrument the installed builder's extraction macros rather than maintaining
// a fork. All copying, retries and error handling remain the upstream code.
function extractionWithProgress(source) {
  const hooks = [
    ['!macro extractEmbeddedAppPackage',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabUnpacking)" 5 15', false],
    ['  !insertmacro compute_files_for_current_arch',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabExtracting)" 15 65', false],
    ['  !insertmacro decompress',
      '  YabInstallUI::Phase /NOUNLOAD "$(yabRegistering)" 90 98', false],
    ['    CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR',
      '    YabInstallUI::Phase /NOUNLOAD "$(yabCopying)" 65 90', true],
    ['    Nsis7z::Extract "${FILE}"',
      '    YabInstallUI::Phase /NOUNLOAD "$(yabExtracting)" 65 90', true],
  ];
  let patched = source.replaceAll('\r\n', '\n');
  for (const [anchor, hook, before] of hooks) {
    if (patched.split(anchor).length !== 2) {
      throw new Error(`安装器模板已变化，需要检查进度阶段：${anchor}`);
    }
    patched = patched.replace(anchor, before ? `${hook}\n${anchor}` : `${anchor}\n${hook}`);
  }
  return patched;
}

function prepareInstallerProgress(release) {
  const builderRoot = path.dirname(require.resolve('app-builder-lib/package.json', {
    paths: [path.dirname(require.resolve('electron-builder'))],
  }));
  const source = fs.readFileSync(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'), 'utf8');
  const includeDir = path.join(release, 'nsis-progress');
  fs.mkdirSync(includeDir, { recursive: true });
  fs.writeFileSync(path.join(includeDir, 'extractAppPackage.nsh'), extractionWithProgress(source));
  return includeDir;
}

module.exports = { extractionWithProgress, prepareInstallerProgress };
