const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

// Run the actual entry point with isolated environment variables and fake I/O.
// No database clients, network access, dependencies, or credentials are needed.
function createBackup(overrides = {}, options = {}) {
  const commands = [];
  const uploads = [];
  const errors = [];
  const events = [];
  const schedules = [];
  const notifications = [];
  const env = {
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    AWS_S3_REGION: 'test-region',
    AWS_S3_ENDPOINT: 'https://spaces.example.com',
    AWS_S3_BUCKET: 'test-bucket',
    DATABASES: 'postgresql://user:password@db.example.com:5432/example',
    ...overrides,
  };
  const context = vm.createContext({
    process: { env },
    URL,
    AbortSignal,
    async fetch(url, request) {
      notifications.push({ url, ...request, body: JSON.parse(request.body) });
      if (options.failTelegram) throw new Error(`Network failure: ${url}`);
      return { ok: !options.rejectTelegram, async json() { return { ok: !options.telegramApiError }; } };
    },
    console: { log() {}, warn() {}, error(message) { errors.push(message); } },
    require(name) {
      switch (name) {
        case 'dotenv':
          return { config() {} };
        case 'node:timers/promises':
          return { async setTimeout() {} };
        case 'util':
          return { promisify: () => async (command) => {
            commands.push(command);
            events.push(command);
            if (options.failDump && /^(pg_dump|mongodump|mysqldump) /.test(command)) {
              throw new Error('Dump failed');
            }
            return { stdout: 'test client version', stderr: command.startsWith('mongodump ') ? options.mongoOutput || '' : '' };
          } };
        case 'child_process':
          return { exec() {} };
        case '@aws-sdk/client-s3':
          return {
            S3Client: class {
              async send(command) {
                events.push('upload');
                if (options.failUpload) throw new Error('Upload failed');
                uploads.push(command.params);
              }
            },
            PutObjectCommand: class {
              constructor(params) { this.params = params; }
            },
          };
        case 'fs':
          return {
            statSync() { return { size: options.emptyDump ? 0 : 17 }; },
            readFileSync() { return options.emptyArchive ? Buffer.alloc(0) : Buffer.from('compressed backup'); },
          };
        case 'cron':
          return { CronJob: class {
            constructor(schedule, callback) { schedules.push({ schedule, callback }); }
            start() { events.push('cron-start'); }
          } };
        default:
          throw new Error(`Unexpected dependency: ${name}`);
      }
    },
  });
  vm.runInContext(source, context);
  return {
    commands, uploads, errors, events, schedules, notifications,
    exitCode: () => context.process.exitCode,
    run: () => vm.runInContext('processBackup()', context),
  };
}

for (const prefix of ['backups/example', '/backups/example/', ' /backups/example/ ']) {
  test(`uploads inside normalized prefix ${JSON.stringify(prefix)}`, async () => {
    const backup = createBackup({ AWS_S3_PREFIX: prefix });
    await backup.run();
    assert.equal(backup.uploads.length, 1);
    assert.match(backup.uploads[0].Key, /^backups\/example\/backup-postgresql-.*\.tar\.gz$/);
    assert.equal(backup.uploads[0].Bucket, 'test-bucket');
    assert.equal(backup.uploads[0].Body.toString(), 'compressed backup');
  });
}

for (const prefix of [undefined, '', '   ', '///']) {
  test(`uses bucket root for prefix ${JSON.stringify(prefix)}`, async () => {
    const backup = createBackup({ AWS_S3_PREFIX: prefix });
    await backup.run();
    assert.match(backup.uploads[0].Key, /^backup-postgresql-.*\.tar\.gz$/);
    assert.ok(!backup.uploads[0].Key.includes('/'));
  });
}

for (const [uri, command] of [
  ['postgresql://user:password@host:5432/example', 'pg_dump'],
  ['mongodb://user:password@host:27017/example', 'mongodump'],
  ['mongodb+srv://user:password@host/example', 'mongodump'],
  ['mysql://user:password@host:3306/example', 'mysqldump'],
]) {
  test(`selects ${command} for ${new URL(uri).protocol}`, async () => {
    const backup = createBackup({ DATABASES: uri });
    await backup.run();
    assert.ok(backup.commands.some(value => value.startsWith(`${command} `)));
    assert.equal(backup.uploads.length, 1);
    assert.equal(backup.errors.length, 0);
  });
}

test('compresses before uploading and cleans up after uploading', async () => {
  const backup = createBackup();
  await backup.run();
  const dump = backup.events.findIndex(value => value.startsWith('pg_dump '));
  const compress = backup.events.findIndex(value => value.startsWith('tar '));
  const upload = backup.events.indexOf('upload');
  const cleanup = backup.events.findIndex(value => value.startsWith('rm '));
  assert.ok(dump >= 0 && dump < compress && compress < upload && upload < cleanup);
});

test('backs up multiple databases using the same deployment prefix', async () => {
  const backup = createBackup({
    DATABASES: 'postgresql://user:password@host:5432/first,mongodb://host:27017/second',
    AWS_S3_PREFIX: 'backups/shared',
  });
  await backup.run();
  assert.equal(backup.uploads.length, 2);
  for (const upload of backup.uploads) assert.ok(upload.Key.startsWith('backups/shared/'));
  assert.notEqual(backup.uploads[0].Key, backup.uploads[1].Key);
});

test('does no work when no databases are configured', async () => {
  const backup = createBackup({ DATABASES: '' });
  await backup.run();
  assert.equal(backup.commands.length, 0);
  assert.equal(backup.uploads.length, 0);
});

test('JSON databases upload to independent normalized folders', async () => {
  const backup = createBackup({ DATABASES_JSON: JSON.stringify([
    { uri: 'postgresql://host/first', prefix: ' /backups/postgres/ ' },
    { uri: 'mongodb://host/second', prefix: 'backups/mongo' },
  ]) });
  await backup.run();
  assert.equal(backup.uploads.length, 2);
  assert.ok(backup.uploads[0].Key.startsWith('backups/postgres/'));
  assert.ok(backup.uploads[1].Key.startsWith('backups/mongo/'));
});

test('JSON prefixes inherit the default only when omitted', async () => {
  const backup = createBackup({ AWS_S3_PREFIX: 'backups/default', DATABASES_JSON: JSON.stringify([
    { uri: 'postgresql://host/first' },
    { uri: 'mongodb://host/second', prefix: '' },
  ]) });
  await backup.run();
  assert.ok(backup.uploads[0].Key.startsWith('backups/default/'));
  assert.ok(backup.uploads[1].Key.startsWith('backup-'));
});

test('JSON preserves MongoDB replica-set host lists', async () => {
  const uri = 'mongodb://host1:27017,host2:27017/example?replicaSet=rs0';
  const backup = createBackup({ DATABASES_JSON: JSON.stringify([{ uri }]) });
  await backup.run();
  assert.equal(backup.uploads.length, 1);
  assert.ok(backup.commands.some(command => command.includes(`--uri="${uri}"`)));
});

for (const value of ['', 'not-json', '{}', '[]', '[null]', '[{"prefix":"folder"}]',
  '[{"uri":"postgresql://host/db","prefix":42}]', '[{"uri":"invalid"}]',
  '[{"uri":"https://host/db"}]']) {
  test(`rejects invalid DATABASES_JSON ${JSON.stringify(value)}`, () => {
    assert.throws(() => createBackup({ DATABASES_JSON: value }), /DATABASES_JSON/);
  });
}

for (const variable of [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_REGION',
  'AWS_S3_ENDPOINT', 'AWS_S3_BUCKET',
]) {
  test(`requires ${variable}`, () => {
    assert.throws(() => createBackup({ [variable]: '' }), new RegExp(`${variable} is required`));
  });
}

test('does not upload if the dump fails', async () => {
  const backup = createBackup({}, { failDump: true });
  await backup.run();
  assert.equal(backup.uploads.length, 0);
  assert.equal(backup.errors.length, 1);
  assert.equal(backup.exitCode(), 1);
  assert.ok(!backup.commands.some(value => value.startsWith('tar ')));
});

test('logs upload failures without running success cleanup', async () => {
  const backup = createBackup({}, { failUpload: true });
  await backup.run();
  assert.equal(backup.errors.length, 1);
  assert.equal(backup.exitCode(), 1);
  assert.ok(!backup.commands.some(value => value.startsWith('rm ')));
});

test('successful backups set a zero exit code', async () => {
  const backup = createBackup();
  await backup.run();
  assert.equal(backup.exitCode(), 0);
});

test('missing databases set a failure exit code', async () => {
  const backup = createBackup({ DATABASES: '' });
  await backup.run();
  assert.equal(backup.exitCode(), 1);
});

test('continues after an invalid URI and preserves the failure exit code', async () => {
  const backup = createBackup({ DATABASES: 'invalid,postgresql://host/example' });
  await backup.run();
  assert.equal(backup.uploads.length, 1);
  assert.equal(backup.exitCode(), 1);
});

test('continues after unsupported protocol and preserves the failure exit code', async () => {
  const backup = createBackup({ DATABASES: 'https://host/example,postgresql://host/example' });
  await backup.run();
  assert.equal(backup.uploads.length, 1);
  assert.equal(backup.exitCode(), 1);
});

test('attempts every database after dump failures', async () => {
  const backup = createBackup({ DATABASES: 'postgresql://host/first,mongodb://host/second' }, { failDump: true });
  await backup.run();
  assert.equal(backup.errors.length, 2);
  assert.ok(backup.commands.some(command => command.startsWith('pg_dump ')));
  assert.ok(backup.commands.some(command => command.startsWith('mongodump ')));
  assert.equal(backup.exitCode(), 1);
});

test('only schedules the internal cron when configured', () => {
  assert.equal(createBackup().schedules.length, 0);
  const backup = createBackup({ CRON: '0 3 * * 0' });
  assert.equal(backup.schedules[0].schedule, '0 3 * * 0');
  assert.ok(backup.events.includes('cron-start'));
});

const telegram = { TELEGRAM_BOT_TOKEN: 'test-bot-token', TELEGRAM_CHAT_ID: '12345' };

test('Telegram is disabled by default', async () => {
  const backup = createBackup();
  await backup.run();
  assert.equal(backup.notifications.length, 0);
});

test('Telegram sends one summary for all databases without secrets', async () => {
  const backup = createBackup({ ...telegram, DATABASES: 'postgresql://user:privatepassword@host/first,mongodb://host/second' });
  await backup.run();
  assert.equal(backup.notifications.length, 1);
  const request = backup.notifications[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.body.chat_id, '12345');
  assert.match(request.body.text, /completed successfully/);
  assert.match(request.body.text, /postgresql \/ first/);
  assert.match(request.body.text, /mongodb \/ second/);
  assert.match(request.body.text, /Uploaded: 17 bytes/);
  assert.match(request.body.text, /UTC-3: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
  assert.ok(!request.body.text.includes('privatepassword'));
  assert.ok(!request.body.text.includes('test-bot-token'));
  assert.ok(request.signal instanceof AbortSignal);
});

test('Telegram reports backup failures and keeps failure exit code', async () => {
  const backup = createBackup(telegram, { failDump: true });
  await backup.run();
  assert.match(backup.notifications[0].body.text, /completed with errors/);
  assert.match(backup.notifications[0].body.text, /backup failed/);
  assert.equal(backup.exitCode(), 1);
});

test('Telegram reports missing databases', async () => {
  const backup = createBackup({ ...telegram, DATABASES: '' });
  await backup.run();
  assert.match(backup.notifications[0].body.text, /No databases configured/);
});

for (const option of ['failTelegram', 'rejectTelegram', 'telegramApiError']) {
  test(`Telegram ${option} does not change successful backup status or leak token`, async () => {
    const backup = createBackup(telegram, { [option]: true });
    await backup.run();
    assert.equal(backup.uploads.length, 1);
    assert.equal(backup.exitCode(), 0);
    assert.equal(backup.notifications.length, option === 'failTelegram' ? 3 : 1);
    assert.ok(backup.errors.length >= 2);
    assert.ok(backup.errors.every(message => !message.includes('test-bot-token')));
  });
}

for (const variable of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
  test(`requires both Telegram settings when ${variable} is present`, () => {
    assert.throws(() => createBackup({ [variable]: 'test' }), /Set both TELEGRAM/);
  });
}

for (const option of ['emptyDump', 'emptyArchive']) {
  test(`rejects ${option} before uploading`, async () => {
    const backup = createBackup(telegram, { [option]: true });
    await backup.run();
    assert.equal(backup.uploads.length, 0);
    assert.equal(backup.exitCode(), 1);
  });
}

test('reports the total number of MongoDB documents', async () => {
  const backup = createBackup({ ...telegram, DATABASES: 'mongodb://host/example' }, {
    mongoOutput: 'done dumping example.first (3 documents)\ndone dumping example.second (1 document)',
  });
  await backup.run();
  assert.match(backup.notifications[0].body.text, /4 documents reported by mongodump/);
});

test('rejects a MongoDB dump reporting zero documents', async () => {
  const backup = createBackup({ ...telegram, DATABASES: 'mongodb://host/example' }, {
    mongoOutput: 'done dumping example.first (0 documents)',
  });
  await backup.run();
  assert.equal(backup.uploads.length, 0);
  assert.equal(backup.exitCode(), 1);
});
