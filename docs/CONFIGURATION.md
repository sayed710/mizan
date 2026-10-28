# Configuration

The server reads these environment variables. The list lives in `server/config.js`. At startup the server checks every variable that is set and refuses to start if a value is malformed. For example, `PORT` must be a number and a flag must be `0` or `1`. Unset variables use their default.

| Variable | Kind | Default | Meaning |
|---|---|---|---|
| `PORT` | port | `8069` | HTTP port (0 picks a free port). |
| `NODE_ENV` | text |  | `production` turns off demo-only features. |
| `MIZAN_DB` | path | `mizan.sqlite` | SQLite database file. |
| `MIZAN_ADMIN_PASSWORD` | secret |  | Password of the `admin` user created on first start (otherwise a random one is generated). |
| `MIZAN_SECURE_COOKIE` | flag |  | Session cookies get `Secure`: on by default when `NODE_ENV=production`; `0` for plain-HTTP LAN use, `1` to force. |
| `MIZAN_TRUST_PROXY` | flag |  | `1` behind a reverse proxy: the client IP is read from `X-Forwarded-For`. |
| `MIZAN_PUBLIC_URL` | url |  | Public origin of the site (links in emails, sitemap, Twilio signatures). |
| `MIZAN_LOG_REQUESTS` | flag | `1` | `0` turns off the per-request JSON access log. |
| `MIZAN_DEMO_PAYMENTS` | flag |  | `1` lets the shop confirm orders without a payment (ignored in production). |
| `MIZAN_SMTP_HOST` | text |  | SMTP server; email is sent only when set. |
| `MIZAN_SMTP_PORT` | port | `587` | SMTP port. |
| `MIZAN_SMTP_USER` | text |  | SMTP user. |
| `MIZAN_SMTP_PASS` | secret |  | SMTP password. |
| `MIZAN_SMTP_FROM` | text |  | Sender address. |
| `MIZAN_SMTP_SECURE` | flag |  | `1` for implicit TLS (port 465); otherwise STARTTLS when offered. |
| `MIZAN_SMTP_INSECURE` | flag |  | `1` accepts an invalid SMTP certificate (testing only). |
| `MIZAN_AI` | flag |  | `1` turns on AI features with the default Anthropic credentials. |
| `ANTHROPIC_API_KEY` | secret |  | Anthropic API key for AI features. |
| `ANTHROPIC_AUTH_TOKEN` | secret |  | Alternative Anthropic credential. |
| `MIZAN_WHATSAPP_TOKEN` | secret |  | WhatsApp Cloud API token. |
| `MIZAN_WHATSAPP_PHONE_ID` | text |  | WhatsApp sender phone number id. |
| `MIZAN_WHATSAPP_APP_SECRET` | secret |  | Meta app secret used to verify webhook signatures. |
| `MIZAN_WHATSAPP_VERIFY_TOKEN` | secret |  | Token Meta sends when the webhook is registered. |
| `MIZAN_TWILIO_SID` | text |  | Twilio account SID for SMS. |
| `MIZAN_TWILIO_TOKEN` | secret |  | Twilio auth token (also verifies inbound SMS). |
| `MIZAN_TWILIO_FROM` | text |  | Twilio sender number. |
| `MIZAN_SHIPPING_TOKEN` | secret |  | Token for carrier rate APIs. |
| `MIZAN_MARKETPLACE_TOKEN` | secret |  | Token for marketplace order feeds. |

## Logs

- The server writes one JSON object per line, with the fields `time`, `level` and `msg`. Errors go to stderr; everything else goes to stdout.
- Every HTTP request is logged with its `requestId`, method, path, status and duration in ms. Set `MIZAN_LOG_REQUESTS=0` to turn this off.
- The same id is sent back in the `X-Request-Id` header. On a server error, the response body also carries it as `requestId`, so a user can quote it when reporting a problem.
- Two lines stay plain text for humans: the startup line (`Mizan listening on …`) and the first-start admin line.
