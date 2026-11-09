// bar "Back to Dashboard" (dipakai halaman request, Environment, All Environments). Dipasang SEBELUM script halaman:
// acquireVsCodeApi hanya boleh dipanggil sekali, jadi dibungkus supaya halaman mendapat objek yang sama.
(function () {
  if (typeof acquireVsCodeApi !== 'function') return;
  const orig = window.acquireVsCodeApi;
  let api;
  window.acquireVsCodeApi = () => (api ??= orig());
  const bar = document.getElementById('backBar');
  document.getElementById('backBtn').onclick = () => window.acquireVsCodeApi().postMessage({ type: 'backToDashboard' });
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'backBar') return;
    bar.hidden = !e.data.on;
    document.body.classList.toggle('has-backbar', !!e.data.on);
  });
})();
