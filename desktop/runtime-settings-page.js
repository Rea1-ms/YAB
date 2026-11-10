'use strict';

const api = window.runtimeSettings;
const tool = document.getElementById('tool');
const locationField = document.getElementById('location');
const index = document.getElementById('index');
const status = document.getElementById('status');
const save = document.getElementById('save');
const controls = [...document.querySelectorAll('button, input, select')];
const toolVersion = document.getElementById('tool-version');
let ready = false;
let customPath = '';

function updateTool() { locationField.readOnly = tool.value !== 'custom'; }
function showStatus(text, error = false) { status.textContent = text; status.title = text; status.classList.toggle('error', error); }
async function action(work) {
  controls.forEach(control => { control.disabled = true; });
  showStatus('正在检查…');
  try { await work(); } catch (error) { showStatus(error.message, true); }
  finally { controls.forEach(control => { control.disabled = !ready; }); }
}
function showTool(result) {
  locationField.value = result.path;
  locationField.title = result.path;
  toolVersion.textContent = result.version.replace(/^uv /, '版本：');
  updateTool();
  showStatus('');
}
async function inspectTool() {
  updateTool();
  toolVersion.textContent = '';
  locationField.value = tool.value === 'custom' ? customPath : '';
  locationField.title = locationField.value;
  if (tool.value === 'custom' && !customPath) { showStatus('选择本地文件，或填写工具的完整位置。'); return; }
  showTool(await api.inspect({ uvMode: tool.value, uvPath: customPath }));
}
tool.addEventListener('change', () => action(inspectTool));
locationField.addEventListener('input', () => {
  customPath = locationField.value;
  locationField.title = customPath;
  toolVersion.textContent = '';
  showStatus('');
});
document.getElementById('detect').addEventListener('click', () => action(async () => {
  const result = await api.detect();
  tool.value = 'system';
  showTool(result);
}));
document.getElementById('browse').addEventListener('click', () => action(async () => {
  const result = await api.browse();
  if (result) { tool.value = 'custom'; customPath = result.path; showTool(result); }
  else showStatus('已取消选择');
}));
save.addEventListener('click', () => action(async () => {
  await api.save({ uvMode: tool.value, uvPath: tool.value === 'custom' ? locationField.value.trim() : '', index: index.value });
  showStatus('设置已保存');
}));
action(async () => {
  const model = await api.get();
  tool.querySelector('[value="bundled"]').disabled = !model.bundled;
  tool.value = model.settings.uvMode;
  customPath = model.settings.uvPath;
  for (const [value, entry] of Object.entries(model.indexes)) {
    const option = document.createElement('option');
    option.value = value; option.textContent = entry.label; index.append(option);
  }
  index.value = model.settings.index;
  save.textContent = model.initial ? '保存并继续' : '保存';
  if (!model.initial) document.getElementById('intro').textContent = '修改后下次启动生效。更换下载源或工具位置会复用已准备好的相同依赖环境。';
  ready = true;
  await inspectTool();
  if (model.warning) showStatus(model.warning, true);
});
