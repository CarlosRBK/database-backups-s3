# Database Backups to S3

Automated PostgreSQL and MongoDB backups to Amazon S3 or compatible storage, including DigitalOcean Spaces. Deploy on Railway to run weekly, monthly, or on your own schedule.

```mermaid
flowchart TD
    A[Scheduled run or manual execution] --> B[Read environment variables]
    B --> C[Dump each database]
    C --> V[Check dump size and available MongoDB document counts]
    V --> D[Compress backup as tar.gz]
    D --> E[Upload to bucket and configured prefix]
    E --> F[Remove temporary files]
    F --> T[Send optional Telegram summary]
    T --> G[Exit or wait for internal cron]
```

## Requirements

- An accessible PostgreSQL or MongoDB database.
- An S3-compatible bucket and credentials with permission to upload objects.
- Docker, Railway, or Node.js 24 with the appropriate database clients installed.

The Docker image includes `pg_dump`, `pg_restore`, `mongodump`, and `mongorestore`.

## Configuration

Configure environment variables in Railway or in a local `.env` file. Never commit credentials or database connection strings.

For local setup, copy the template only if you do not already have `.env`:

```bash
cp .env.example .env
```

Replace placeholders with your own values. With Docker `--env-file`, do **not**
wrap values in single or double quotes: Docker preserves those characters.
Keep `DATABASES_JSON` on one line, with its JSON double quotes inside the value.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASES` | One of these | Comma-separated database connection URIs, sharing the default prefix. |
| `DATABASES_JSON` | One of these | JSON array of objects with `uri` and optional `prefix`. Takes precedence over `DATABASES`. |
| `AWS_ACCESS_KEY_ID` | Yes | S3 or Spaces access key. |
| `AWS_SECRET_ACCESS_KEY` | Yes | S3 or Spaces secret key. |
| `AWS_S3_BUCKET` | Yes | Bucket name, without a folder path. |
| `AWS_S3_REGION` | Yes | Storage region, such as `nyc3`. |
| `AWS_S3_ENDPOINT` | Yes | Regional S3 endpoint, including `https://`. |
| `AWS_S3_PREFIX` | No | Default folder prefix. Used when a database has no individual `prefix`. Defaults to the bucket root. |
| `RUN_ON_STARTUP` | No | Set to `true` to back up immediately. Defaults to `false`. |
| `CRON` | No | Internal cron schedule. Leave unset when using Railway Cron. |
| `TELEGRAM_BOT_TOKEN` | No | Bot token for optional Telegram notifications. Requires `TELEGRAM_CHAT_ID`. |
| `TELEGRAM_CHAT_ID` | No | Destination chat ID. Requires `TELEGRAM_BOT_TOKEN`. |

Set `RUN_ON_STARTUP=true`, `CRON`, or both to enable backup execution.
Leading and trailing slashes and surrounding whitespace are removed from `AWS_S3_PREFIX`.

### Database connection strings

```text
PostgreSQL: postgresql://user:password@host:5432/database
MongoDB:    mongodb://user:password@host:27017/database
MongoDB SRV: mongodb+srv://user:password@cluster.example.com/database
```

Include the database name in your MongoDB URI to limit the dump to that database.
Add connection options such as TLS or `authSource` as required by your provider.
Encode reserved characters in credentials according to URI rules.

### DigitalOcean Spaces

Use your Spaces credentials in the `AWS_*` variables:

```env
RUN_ON_STARTUP=true
DATABASES=postgresql://user:password@host:5432/database
AWS_ACCESS_KEY_ID=<SPACES_ACCESS_KEY>
AWS_SECRET_ACCESS_KEY=<SPACES_SECRET_KEY>
AWS_S3_BUCKET=<SPACE_NAME>
AWS_S3_REGION=nyc3
AWS_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
AWS_S3_PREFIX=backups/example
```

Replace `nyc3` with your Space's region. Use the regional endpoint, not a CDN URL
or a bucket-specific URL. Keep the bucket private and grant only the permissions
needed for your backup workflow.

### Backup files

Each database produces one compressed archive:

```text
<prefix>/backup-<type>-<YYYY-MM-DD_HH:mm:ss>-<database>-<host>.tar.gz
```

The archive contains a `.dump` file. PostgreSQL uses custom dump format;
MongoDB uses its archive format.
The timestamp follows the runtime's timezone.

## Deploy on Railway

1. Create a Railway service from this repository. Railway builds the Dockerfile.
2. Add the environment variables from the configuration section.
3. Set `RUN_ON_STARTUP=true` and leave `CRON` unset.
4. Configure a Railway Cron schedule in UTC.
5. Set the restart policy to **Never**.
6. Run the service and confirm the backup appears under the expected bucket prefix.

| Schedule | Cron expression |
| --- | --- |
| Every Sunday at 03:00 UTC | `0 3 * * 0` |
| First day of each month at 03:00 UTC | `0 3 1 * *` |

The database must be reachable from the service. Configure networking, TLS,
and provider access rules as needed.

### Multiple databases in one service

Set `DATABASES_JSON` to configure a different folder for each database:

```env
DATABASES_JSON=[{"uri":"postgresql://user:password@host:5432/database","prefix":"backups/postgres"},{"uri":"mongodb://user:password@host:27017/database","prefix":"backups/mongo"}]
```

In Railway, paste only the JSON array as the variable's value, without the
`DATABASES_JSON=` prefix or outer quotes. All databases run sequentially on the same schedule and use
the same bucket. An omitted `prefix` uses `AWS_S3_PREFIX`; an empty `prefix`
uploads to the bucket root. JSON also supports MongoDB connection strings
containing commas, such as replica-set host lists.

### Separate services for independent schedules

Deploy the same repository twice to configure independent destinations and schedules:

| Setting | PostgreSQL service | MongoDB service |
| --- | --- | --- |
| `DATABASES` | PostgreSQL URI | MongoDB URI |
| `AWS_S3_PREFIX` | `backups/postgres` | `backups/mongo` |
| `RUN_ON_STARTUP` | `true` | `true` |

Both services can share the same bucket. Configure actual folder names in Railway
variables; no project-specific paths need to be stored in the repository.

## Telegram notifications

1. Open Telegram and create a bot with **@BotFather**, using `/newbot`.
2. Save the bot token privately.
3. Open your new bot's chat and send `/start`.
4. Retrieve your chat ID from the Telegram Bot API `getUpdates` response
   (the `message.chat.id` field). Avoid sharing your token or using third-party
   sites to retrieve it.
   The API URL is `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`.
   Replace `<BOT_TOKEN>` privately; the URL contains your secret token.
5. Set both variables in `.env` or Railway, without surrounding quotes:

```env
TELEGRAM_BOT_TOKEN=<BOT_TOKEN>
TELEGRAM_CHAT_ID=<CHAT_ID>
```

Leave both empty to disable notifications. Each run sends one summary with
the database name, protocol, folder, uploaded archive size in bytes, and a
timestamp formatted as `DD/MM/YYYY, HH:mm:ss` in UTC-3. Messages do not
include connection strings or raw errors.
Empty dump files and empty compressed archives are rejected before upload.
MongoDB document totals are taken from `mongodump` output when available;
a reported total of zero is treated as a failure. PostgreSQL record counts
are not verified and are explicitly marked as such in the notification.
Notification failures are logged and do not change the backup exit code.
Each request times out after 15 seconds. Network errors, rate limits, and
server errors are retried up to three attempts. Logs include safe HTTP or
network error codes, never the token. Retrying after an ambiguous network
failure may deliver duplicate messages. Startup configuration errors and jobs
that never start cannot be reported through this summary.

Example notification (sizes and counts are illustrative):

```text
✅ Backup completed successfully
✅ postgresql / example
   Uploaded: 12,430 bytes
   Folder: backups/postgres
   Records: not verified
✅ mongodb / example
   Uploaded: 125,430 bytes
   Folder: backups/mongo
   Records: 992 documents reported by mongodump
UTC-3: 11/10/2026, 14:00:00
```

Archive size is not proof of record completeness. MongoDB counts reflect the
tool's output, not a separate verification of the uploaded object. Restore
testing remains necessary. A failed database is marked with `❌` in the summary.

## Run locally

### Docker

Create `.env` using the configuration above, then run:

```bash
docker build -t database-backups-s3 .
docker run --rm --env-file .env database-backups-s3
```

Each execution creates new backups and sends a Telegram summary when enabled.
Rebuild after changing source code; changes to `.env` only require another run.

On Docker Desktop, use `host.docker.internal` in database URIs to connect to
a database exposed on the host. `localhost` inside the backup container refers
to that container, not your computer.

### Node.js

Install Node.js 24 and the database clients needed for your connection types.
Then create `.env` and run:

```bash
nvm use
npm ci
npm start
```

`nvm use` is only necessary if you manage Node.js with nvm.

### Internal scheduler

For a continuously running deployment, set an internal schedule:

```env
RUN_ON_STARTUP=false
CRON=0 3 * * 0
```

The process remains running between backups. The internal scheduler uses the
runtime's timezone. Do not combine it with Railway Cron; use one scheduler.

## Restore a backup

Download the archive from storage and extract it:

```bash
mkdir -p restore
tar -xzf backup.tar.gz -C restore
find restore -name '*.dump'
```

Replace `path/to/backup.dump` below with the extracted file's path.
Restore into a **separate, empty database** first, not your production database.

### PostgreSQL

```bash
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname="postgresql://user:password@host:5432/restore_database" \
  path/to/backup.dump
```

Use a `pg_restore` version compatible with the version of `pg_dump` that created
the file. `--no-owner --no-privileges` skips original ownership and grants;
omit those options if you need to preserve them and have the required roles.

### MongoDB

```bash
mongorestore \
  --uri="mongodb://user:password@host:27017/?authSource=admin" \
  --archive=path/to/backup.dump \
  --nsInclude='source_database.*' \
  --nsFrom='source_database.*' \
  --nsTo='restore_database.*'
```

Replace the database names and connection options with your own. This example
maps the original collections into a separate restore database.

After restoring, verify collection/table counts and representative data.
Repeat restore testing regularly; a successful upload alone does not validate recovery.

## Tests

```bash
npm test
```

Or run tests inside the built image:

```bash
docker run --rm --entrypoint node database-backups-s3 --test
```

Tests simulate database commands and S3 uploads. They require no credentials,
network access, or running databases and do not replace an end-to-end restore test.

## Operational notes

- Backups run sequentially for the entries in `DATABASES_JSON` or `DATABASES`.
- All databases in one deployment use the same bucket. Use `DATABASES_JSON`
  to assign individual folder prefixes.
- Allow disk space for both the dump and compressed archive. Uploads load the
  compressed file into memory, so size the service accordingly.
- Temporary files are removed after successful uploads.
- Errors are written to logs. If a backup fails, the remaining databases are
  still attempted and the run sets exit code `1`; successful runs use `0`.
  With the internal scheduler, the process stays running until stopped.
- Email notifications, automatic retention, and application-level backup retries
  are not included. Telegram notifications have their own retry policy.
- Configure storage lifecycle rules if you want backups to expire automatically.
- Prevent overlapping runs by allowing enough time between scheduled executions.

## Troubleshooting

| Problem | Check |
| --- | --- |
| No backup runs | Set `RUN_ON_STARTUP=true` or configure `CRON`. Configure `DATABASES_JSON` or `DATABASES`. |
| Database connection fails | URI, credentials, database name, TLS options, network access, and firewall rules. |
| PostgreSQL version mismatch | The `pg_dump` client must support your server version. Check the client version in logs. |
| Spaces upload fails | Access permissions, bucket name, region, and regional endpoint. |
| Backup appears in the wrong folder | Check each JSON entry's `prefix`, or the default `AWS_S3_PREFIX`. Do not put folders in `AWS_S3_BUCKET`. |
| Container cannot reach a local DB | Use `host.docker.internal` on Docker Desktop or appropriate Docker networking. |
| `DATABASES_JSON must be valid JSON` | Use a single-line JSON array without outer quotes in Docker's `.env`. |
| `Region not accepted` | Remove outer quotes from `AWS_S3_REGION` and check the region value. |
| Telegram HTTP 401 or 404 | Verify the bot token. |
| Telegram HTTP 400 or 403 | Verify the chat ID, send `/start` to the bot, and check that it can send messages to the chat. |
| Telegram network error or timeout | Check outbound connectivity to `api.telegram.org`; temporary failures are retried. |
