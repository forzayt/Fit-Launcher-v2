const list = document.getElementById('versions');

if (window.appInfo) {
  const { electron, chrome, node } = window.appInfo.versions;
  const entries = [
    ['Electron', electron],
    ['Chromium', chrome],
    ['Node.js', node],
  ];

  for (const [label, version] of entries) {
    const item = document.createElement('li');
    item.innerHTML = `<span>${label}</span><code>${version}</code>`;
    list.appendChild(item);
  }
}
