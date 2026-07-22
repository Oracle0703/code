const path = require('node:path');

const asarArgument = process.argv[2];
if (!asarArgument) {
  console.error('Expected the packaged app.asar path.');
  process.exit(1);
}
const asarPath = path.resolve(asarArgument);

const nodePty = require(path.join(asarPath, 'node_modules', 'node-pty'));
const shell =
  process.platform === 'win32'
    ? process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    : process.env.SHELL || '/bin/sh';
const marker = 'DAILY_WORKBENCH_PTY_OK';
let receivedMarker = false;
let settled = false;

const terminal = nodePty.spawn(shell, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

const timeout = setTimeout(() => {
  if (!settled) {
    console.error('Packaged terminal smoke test timed out.');
    terminal.kill();
    process.exit(1);
  }
}, 15_000);

terminal.onData((data) => {
  if (!receivedMarker && data.includes(marker)) {
    receivedMarker = true;
    terminal.kill();
  }
});

terminal.onExit(() => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (!receivedMarker) {
    console.error('Packaged terminal exited before returning the smoke marker.');
    process.exit(1);
  }
  console.log('Packaged node-pty create/write/close smoke test passed.');
  process.exit(0);
});

terminal.write(`echo ${marker}${process.platform === 'win32' ? '\r' : '\n'}`);
