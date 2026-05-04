# Bumbee Server-Native Ticket Mail Worker

This service runs on the Bumbee server without Cloudflare Workers.

It watches configured mailboxes, detects subjects containing `ticket` or `task`
case-insensitively, creates a local work-item record, asks AI for an operational
reply, and replies on the same mail thread when auto-send is enabled.

## Quick demo

```bash
npm run mail:demo
```

The demo uses a mock mailbox and writes local state under:

```text
server-native/data/
```

## Web admin UI

```bash
npm run mail:admin
```

Default local URL:

```text
http://127.0.0.1:18920
```

Current Bumbee public URL:

```text
https://mailcenter.bumbee.asia
```

The admin UI can:

- save mailbox config to `server-native/data/config.json`;
- run one scan immediately;
- run the mock demo from the browser;
- show latest work items and outbox replies.

For public exposure, protect the admin API with a token:

```bash
MAIL_WORKER_ADMIN_TOKEN='change-me' npm run mail:admin
```

Then open:

```text
https://mailcenter.bumbee.asia/?token=change-me
```

Or require email-code login:

```bash
MAIL_WORKER_REQUIRE_AUTH=true \
MAIL_WORKER_ADMIN_EMAILS=nhutpham@bitdancegroup.com \
MAIL_WORKER_AUTH_FROM=nhutpham@bitdancegroup.com \
npm run mail:admin
```

## Production run

```bash
npm run mail:worker
```

Useful environment variables:

- `MAIL_WORKER_CONFIG_JSON`: JSON config for mailboxes.
- `MAIL_WORKER_CONFIG_FILE`: config file path. Default: `server-native/data/config.json`.
- `MAIL_WORKER_DATA_DIR`: state directory. Default: `server-native/data`.
- `MAIL_WORKER_ADMIN_PORT`: admin UI port. Default: `18920`.
- `MAIL_WORKER_ADMIN_HOST`: admin UI host. Default: `127.0.0.1`.
- `MAIL_WORKER_ADMIN_TOKEN`: optional admin token required by API calls.
- `MAIL_WORKER_REQUIRE_AUTH`: `true` to require login even without a static token.
- `MAIL_WORKER_ADMIN_EMAILS`: comma-separated emails allowed to request login codes.
- `MAIL_WORKER_AUTH_FROM`: from address for login-code email. Default: `nhutpham@bitdancegroup.com`.
- `MAIL_WORKER_AUTH_DELIVERY`: set to `console` for local testing instead of sendmail.
- `MAIL_WORKER_AUTO_SEND`: `true` to send replies. Default: `false`.
- `MAIL_WORKER_POLL_MS`: polling interval. Default: `120000`.
- `BUMBBEE_MAIL_AI_ENDPOINT` or `BUMBEE_MAIL_AI_ENDPOINT`: optional AI endpoint.
- `BUMBEE_MAIL_AI_TOKEN`: optional bearer token for AI endpoint.

## Mailbox config examples

Gmail API:

```json
{
  "mailboxes": [
    {
      "id": "bitdance.work@gmail.com",
      "provider": "gmail",
      "accessToken": "ya29...",
      "refreshToken": "...",
      "clientId": "...",
      "clientSecret": "..."
    }
  ]
}
```

Microsoft Graph:

```json
{
  "mailboxes": [
    {
      "id": "nhutpham@bitdancegroup.com",
      "provider": "microsoft",
      "accessToken": "...",
      "refreshToken": "...",
      "clientId": "...",
      "clientSecret": "...",
      "tenantId": "common"
    }
  ]
}
```

Mock mailbox for tests:

```json
{
  "mailboxes": [
    {
      "id": "support@bumbee.asia",
      "provider": "mock",
      "messages": [
        {
          "id": "demo-1",
          "subject": "[ticket] Website checkout issue",
          "from": "customer@example.com",
          "bodyText": "The payment button does not work."
        }
      ]
    }
  ]
}
```
