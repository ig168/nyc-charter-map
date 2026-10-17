'use strict';

const path = require('node:path');
const { loadDotEnv, buildConfig } = require('./src/config');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}

loadDotEnv(path.join(__dirname, '.env'));
const config = buildConfig();
const { createApp } = require('./src/app');

let server;
try {
  server = createApp(config);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  NYC Charter School Finder running at http://${host}:${server.address().port}`);
  if (!config.googleClientId) console.log('  ⚠  GOOGLE_CLIENT_ID is not set — Google sign-in is disabled (see README).');
  if (config.devLogin) console.log('  ⚠  DEV_LOGIN is on — a developer sign-in is offered. Never enable in production.');
  if (config.allowedEmails.length || config.allowedDomains.length) console.log('  🔒 Sign-in restricted by allow-list.');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
