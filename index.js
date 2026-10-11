require('dotenv').config();
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const s3 = require("@aws-sdk/client-s3");
const fs = require('fs');
const cron = require("cron");
const { setTimeout: delay } = require('node:timers/promises');

function normalizePrefix(prefix) {
  return prefix.trim().replace(/^\/+|\/+$/g, '');
}

function parseDatabaseURI(uri) {
  // WHATWG URL does not accept MongoDB replica-set host lists with ports.
  // Parse the first host for metadata; pass the original URI to mongodump.
  const metadataURI = uri.replace(/^(mongodb:\/\/)([^/]+)/, (_, scheme, authority) => {
    const credentialsEnd = authority.lastIndexOf('@') + 1;
    return scheme + authority.slice(0, credentialsEnd) + authority.slice(credentialsEnd).split(',')[0];
  });
  return new URL(metadataURI);
}

function loadDatabases() {
  if (process.env.DATABASES_JSON !== undefined) {
    let databases;
    try {
      databases = JSON.parse(process.env.DATABASES_JSON);
    } catch {
      throw new Error('DATABASES_JSON must be valid JSON');
    }
    if (!Array.isArray(databases) || databases.length === 0) {
      throw new Error('DATABASES_JSON must be a non-empty array');
    }
    return databases.map((database, index) => {
      if (!database || typeof database.uri !== 'string' || !database.uri.trim() ||
          (database.prefix !== undefined && typeof database.prefix !== 'string')) {
        throw new Error(`DATABASES_JSON entry ${index + 1} requires a uri string and an optional prefix string`);
      }
      try {
        const url = parseDatabaseURI(database.uri.trim());
        if (!['postgresql:', 'mongodb:', 'mongodb+srv:', 'mysql:'].includes(url.protocol)) {
          throw new Error('Unsupported protocol');
        }
      } catch {
        throw new Error(`DATABASES_JSON entry ${index + 1} has an invalid or unsupported database URI`);
      }
      return { uri: database.uri.trim(), prefix: database.prefix === undefined ? undefined : normalizePrefix(database.prefix) };
    });
  }
  return process.env.DATABASES
    ? process.env.DATABASES.split(',').map(uri => ({ uri: uri.trim() }))
    : [];
}

function loadConfig() {
  const requiredEnvars = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_S3_REGION',
    'AWS_S3_ENDPOINT',
    'AWS_S3_BUCKET'
  ];
  
  for (const key of requiredEnvars) {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} is required`);
    }
  }

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (Boolean(token) !== Boolean(chatId)) {
    throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both unset');
  }

  return {
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_S3_REGION,
      endpoint: process.env.AWS_S3_ENDPOINT,
      s3_bucket: process.env.AWS_S3_BUCKET,
      s3_prefix: normalizePrefix(process.env.AWS_S3_PREFIX || '')
    },
    databases: loadDatabases(),
    run_on_startup: process.env.RUN_ON_STARTUP === 'true' ? true : false,
    cron: process.env.CRON,
    telegram: { token, chatId },
  };
}

const config = loadConfig();

const s3Client = new s3.S3Client(config.aws);

async function notifyTelegram(results, failed) {
  if (!config.telegram.token) return;
  const text = [
    failed ? '❌ Backup completed with errors' : '✅ Backup completed successfully',
    ...results,
    `UTC-3: ${new Intl.DateTimeFormat('es-AR', {
      timeZone: 'Etc/GMT+3', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(new Date())}`,
  ].join('\n');
  // Telegram accepts up to 4096 characters. No URIs or raw errors are sent.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let retry = true;
    let retryAfter = attempt * 1000;
    let reason = 'unknown error';
    try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (response.ok && body.ok) return;
    reason = `HTTP ${response.status}`;
    retry = response.status === 429 || response.status >= 500;
    if (response.status === 429 && Number.isFinite(body.parameters?.retry_after)) {
      retryAfter = Math.min(Math.max(body.parameters.retry_after, 1), 30) * 1000;
    }
    } catch (error) {
      // Never log the request URL, token, or raw error messages.
      const code = error.cause?.code || error.name;
      reason = typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'network error';
    }
    console.error(`Telegram notification attempt ${attempt}/3 failed (${reason}).`);
    if (!retry || attempt === 3) break;
    await delay(retryAfter);
  }
  console.error('Telegram notification failed. Check credentials, chat access, and network connectivity.');
}

async function processBackup() {
  if (config.databases.length === 0) {
    console.error("No databases defined.");
    process.exitCode = 1;
    await notifyTelegram(['No databases configured.'], true);
    return;
  }

  let failed = false;
  const results = [];
  for (const [index, database] of config.databases.entries()) {
    const databaseURI = database.uri;
    const prefix = database.prefix === undefined ? config.aws.s3_prefix : database.prefix;
    const databaseIteration = index + 1;
    const totalDatabases = config.databases.length;

    let url;
    try {
      url = parseDatabaseURI(databaseURI);
    } catch {
      console.error(`Invalid database URI for entry ${index + 1}.`);
      failed = true;
      results.push(`❌ Database ${index + 1}: invalid URI`);
      continue;
    }
    const dbType = url.protocol.slice(0, -1); // remove trailing colon
    const dbName = url.pathname.substring(1); // extract db name from URL
    const dbHostname = url.hostname;
    const dbUser = url.username;
    const dbPassword = url.password;
    const dbPort = url.port;
  
    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const timestamp = `${yyyy}-${mm}-${dd}_${hh}:${min}:${ss}`;
    const filename = `backup-${dbType}-${timestamp}-${dbName}-${dbHostname}.tar.gz`;
    const filepath = `/tmp/${filename}`;

    console.log(`\n[${databaseIteration}/${totalDatabases}] ${dbType}/${dbName} Backup in progress...`);

    let dumpCommand;
    let versionCommand = 'echo "Unknown database type"';
    switch (dbType) {
      case 'postgresql':
        dumpCommand = `pg_dump "${databaseURI}" -F c > "${filepath}.dump"`;
        versionCommand = 'psql --version';
        break;
      case 'mongodb':
      case 'mongodb+srv':
        dumpCommand = `mongodump --uri="${databaseURI}" --archive="${filepath}.dump"`;
        versionCommand = 'mongodump --version';
        break;
      case 'mysql':
        dumpCommand = `mysqldump -u ${dbUser} -p${dbPassword} -h ${dbHostname} -P ${dbPort} ${dbName} > "${filepath}.dump"`;
        versionCommand = 'mysql --version';
        break;
      default:
        console.log(`Unknown database type: ${dbType}`);
        failed = true;
        results.push(`❌ Database ${index + 1}: unsupported protocol`);
        continue;
    }

    try {
      // Log database client version
      try {
        const { stdout: versionOutput } = await exec(versionCommand);
        console.log(`Using ${dbType} client version:`, versionOutput.trim());
      } catch (versionError) {
        console.warn(`Failed to get ${dbType} client version:`, versionError.message);
      }

      // 1. Execute the dump command
      const dumpOutput = await exec(dumpCommand);
      if (fs.statSync(`${filepath}.dump`).size === 0) throw new Error('Database dump is empty');
      let records = 'not verified';
      if (dbType === 'mongodb' || dbType === 'mongodb+srv') {
        const counts = [...`${dumpOutput.stdout || ''}\n${dumpOutput.stderr || ''}`.matchAll(/done dumping .* \((\d+) documents?\)/g)];
        if (counts.length > 0) {
          const total = counts.reduce((sum, match) => sum + Number(match[1]), 0);
          if (total === 0) throw new Error('MongoDB dump contains zero documents');
          records = `${total} documents reported by mongodump`;
        }
      }

      // 2. Compress the dump file
      await exec(`tar -czvf ${filepath} ${filepath}.dump`);

      // 3. Read the compressed file
      const data = fs.readFileSync(filepath);
      if (data.length === 0) throw new Error('Compressed backup is empty');

      // 4. Upload to S3
      const params = {
        Bucket: config.aws.s3_bucket,
        Key: prefix ? `${prefix}/${filename}` : filename,
        Body: data
      };

      const putCommand = new s3.PutObjectCommand(params);
      await s3Client.send(putCommand);
      
      console.log(`✓ Successfully uploaded db backup for database ${dbType} ${dbName} ${dbHostname}.`);

      // 5. Clean up temporary files
      await exec(`rm -f ${filepath} ${filepath}.dump`);
      results.push(`✅ ${dbType} / ${dbName || '(all databases)'}\n   Uploaded: ${data.length.toLocaleString('en-US')} bytes\n   Folder: ${prefix || '(bucket root)'}\n   Records: ${records}`);
    } catch (error) {
      failed = true;
      results.push(`❌ ${dbType} / ${dbName || '(all databases)'}: backup failed; check service logs`);
      console.error(`An error occurred while processing the database ${dbType} ${dbName}, host: ${dbHostname}): ${error}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
  await notifyTelegram(results, failed);
}

if (config.cron) {
  const CronJob = cron.CronJob;
  const job = new CronJob(config.cron, processBackup);
  job.start();
  
  console.log(`Backups configured on Cron job schedule: ${config.cron}`);
}

if (config.run_on_startup) {
  console.log("run_on_startup enabled, backing up now...")
  processBackup();
}
