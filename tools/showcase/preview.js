const frame = document.getElementById('app');
const status = document.getElementById('status');
async function action(operation) {
  try {
    const api = frame.contentWindow.__SHOWCASE__;
    if (!api) throw new Error('软件预览尚未加载');
    await operation(api, frame.contentDocument);
    status.textContent = `模拟时间 ${(api.diagnostics().timeMs / 1000).toFixed(1)} 秒；所有设备操作均为模拟。`;
  } catch (error) {
    status.textContent = String(error);
  }
}
document.getElementById('populate').onclick = () =>
  action(async (api, doc) => {
    api.freeze();
    if (!api.diagnostics().connected) {
      doc.getElementById('btn-connect').click();
      await api.waitFor(() => api.diagnostics().connected);
    }
    if (!api.diagnostics().segment) {
      const tempButton = doc.getElementById('btn-temp-toggle');
      if (tempButton.getAttribute('aria-pressed') !== 'true') tempButton.click();
      doc.getElementById('btn-record-toggle').click();
      await api.waitFor(() => api.diagnostics().segment > 0);
    }
    await api.advance(120_000);
  });
document.getElementById('freeze').onclick = () => action((api) => api.freeze());
document.getElementById('resume').onclick = () => action((api) => api.resume());
document.getElementById('advance').onclick = () => action((api) => api.advance(10_000));
document.getElementById('reset').onclick = () => {
  frame.contentWindow.location.reload();
};
