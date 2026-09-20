const button = document.querySelector('[data-copy]');
const status = document.getElementById('copy-status');
button?.addEventListener('click', async () => {
  const command = document.getElementById(button.dataset.copy)?.textContent;
  if (!command || !status) return;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(command);
    status.textContent = 'Command copied. Paste it into your terminal.';
  } catch {
    status.textContent = 'Copy was unavailable. Select and copy the command above.';
  } finally {
    button.disabled = false;
  }
});
