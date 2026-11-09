'use strict';
window.yabMessage.get().then(model => {
  document.getElementById('message').textContent = model.message;
  document.getElementById('detail').textContent = model.detail;
  let responding = false;
  const respond = async index => {
    if (responding) return;
    responding = true;
    try { await window.yabMessage.respond(index); } catch { responding = false; }
  };
  model.buttons.forEach((label, index) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (index === model.defaultId) button.className = 'primary';
    button.addEventListener('click', () => respond(index));
    document.getElementById('buttons').append(button);
    if (index === model.defaultId) button.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); respond(model.cancelId); }
  });
});
