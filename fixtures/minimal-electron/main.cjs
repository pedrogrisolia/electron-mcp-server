const { app, BrowserWindow } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`
<!DOCTYPE html>
<html>
<head><title>MCP Test App</title></head>
<body>
  <h1 id="title">Electron MCP Test</h1>
  <button id="btn">Click me</button>
  <input id="input" type="text" placeholder="Type here" value="hello" />
  <form id="form"><button type="submit">Submit</button></form>
  <script>
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('title').textContent = 'Clicked!';
      console.log('button clicked');
    });
  </script>
</body>
</html>
      `)
  );
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
