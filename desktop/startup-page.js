'use strict';

const byId = id => document.getElementById(id);
let state;
function updateClock() {
  if (!state) return;
  const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  byId('elapsed').textContent = seconds < 60 ? `已用 ${seconds} 秒` : `已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  const idle = state.lastOutputAt ? Math.max(0, Math.floor((Date.now() - state.lastOutputAt) / 1000)) : null;
  byId('activity').textContent = state.status === 'failed' ? '请查看错误信息' : state.status === 'complete' ? '启动完成'
    : idle === null ? '等待输出' : idle < 2 ? '正在输出' : `${idle} 秒前有新日志`;
}

function render(value) {
  if (state && value.revision < state.revision) return;
  state = value;
  document.body.dataset.status = value.status;
  byId('message').textContent = value.message;
  byId('percent').textContent = Math.floor(value.percent) + '%';
  byId('progress').value = value.percent;
  byId('title').textContent = value.status === 'complete' ? '准备就绪' : value.status === 'failed' ? '启动失败' : '正在启动';
  const steps = Array.from(byId('steps').children);
  for (let index = 0; index < steps.length; index++) {
    const current = steps[index];
    current.className = value.percent >= Number(steps[index + 1]?.dataset.start ?? 100) ? 'done'
      : value.percent >= Number(current.dataset.start) ? 'active' : '';
  }
  const logs = byId('logs');
  // Text output is never interpreted as markup or executable content.
  if (logs.textContent !== value.logText && value.logText) {
    const top = logs.scrollTop;
    logs.textContent = value.logText;
    logs.scrollTop = byId('follow').checked ? logs.scrollHeight : top;
  }
  if (value.environment) byId('environment').textContent = '运行环境：' + value.environment;
  updateClock();
}

byId('follow').addEventListener('change', () => {
  if (byId('follow').checked) byId('logs').scrollTop = byId('logs').scrollHeight;
});
window.yabStartup.onUpdate(render);
window.yabStartup.get().then(render).catch(error => {
  byId('message').textContent = '无法读取启动状态';
  byId('logs').textContent = error.message;
});
setInterval(updateClock, 1000);

let transition;
window.finishStartupTransition = () => transition ||= (async () => {
  render(await window.yabStartup.get());
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fade = document.body.animate([{ opacity: 1 }, { opacity: 0 }], {
    delay: 240, duration: 280, easing: 'ease-in-out', fill: 'forwards',
  });
  await fade.finished;
})();
