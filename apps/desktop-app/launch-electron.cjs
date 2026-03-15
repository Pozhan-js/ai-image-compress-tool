const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const rendererPort = Number(process.env.RENDERER_PORT || 5173);
const waitTimeoutMs = Number(process.env.RENDERER_WAIT_TIMEOUT_MS || 60000);

function isExecutable(filePath) {
  try {
    return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveElectronBinary() {
  const localElectronBinary = path.resolve(
    __dirname,
    '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  );
  if (isExecutable(localElectronBinary)) {
    return localElectronBinary;
  }

  const envBinary = process.env.ELECTRON_PATH || process.env.ELECTRON_EXECUTABLE;
  if (isExecutable(envBinary)) {
    return envBinary;
  }

  const whichResult = spawnSync('which', ['electron'], { encoding: 'utf8' });
  const pathBinary = whichResult.status === 0 ? whichResult.stdout.trim() : '';
  if (isExecutable(pathBinary)) {
    return pathBinary;
  }

  const commonPaths = [
    path.join(os.homedir(), 'Applications/Electron.app/Contents/MacOS/Electron'),
    '/Applications/Electron.app/Contents/MacOS/Electron',
    '/opt/homebrew/Caskroom/electron/41.0.2/Electron.app/Contents/MacOS/Electron'
  ];

  return commonPaths.find(isExecutable) || '';
}

function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });

      socket.once('connect', () => {
        socket.end();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`等待前端开发服务超时: localhost:${port}`));
          return;
        }

        setTimeout(tryConnect, 500);
      });
    };

    tryConnect();
  });
}

async function main() {
  const electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    console.error('未找到可用的 Electron 可执行文件。');
    console.error('请先安装项目内 electron 依赖，或设置 ELECTRON_PATH。');
    process.exit(1);
  }

  try {
    await waitForPort(rendererPort, waitTimeoutMs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '前端服务未就绪。');
    process.exit(1);
  }

  const child = spawn(
    electronBinary,
    ['--disable-gpu', '--disable-software-rasterizer', '--in-process-gpu', '.'],
    {
    cwd: __dirname,
    stdio: 'inherit'
    }
  );

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error(`启动 Electron 失败: ${error.message}`);
    process.exit(1);
  });
}

void main();