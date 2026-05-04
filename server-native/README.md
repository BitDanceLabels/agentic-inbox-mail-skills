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

## Production run

```bash
MAIL_WORKER_CONFIG_JSON='{"mailboxes":[...]}' npm run mail:worker
```

Useful environment variables:

- `MAIL_WORKER_CONFIG_JSON`: JSON config for mailboxes.
- `MAIL_WORKER_DATA_DIR`: state directory. Default: `server-native/data`.
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

