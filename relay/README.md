# RowSkan relay

The relay is the small online "mailbox" that lets one account's devices (phone, browser, Windows app) share changes
when they are not on the same WiFi. A product of [LIT America](https://www.litamerica.net).

* **No master inventory.** Each device keeps its own full copy. The relay only passes changes along.
* **Encrypted on the device.** The relay stores ciphertext it cannot read.
* **Deleted on delivery.** A change is removed from a device's mailbox as soon as that device confirms receipt.
  Anything undelivered is deleted after 30 days (`RELAY_TTL_DAYS`).
* **Account isolation.** Every call needs a Firebase ID token; the relay verifies it (RS256, Google's public certificates,
  project id, expiry) and only touches data under that account.
* **Delete everything:** `DELETE /v1/account`.

## API (all calls: `Authorization: Bearer <Firebase ID token>`)

| Call | Purpose |
|---|---|
| `POST /v1/devices` `{deviceId,name,kind,pub}` | register / refresh a device (max 10 per account) |
| `GET /v1/devices` | list the account's devices |
| `DELETE /v1/devices?deviceId=` | remove a device and its mailbox |
| `POST /v1/send` `{from,to?,kind,payload,blobs?}` | put one ciphertext message in other devices' mailboxes (<= 256 KB) |
| `GET /v1/inbox?device=&after=&limit=` | read a device's pending messages, oldest first |
| `POST /v1/ack` `{device,upTo}` | confirm receipt up to a sequence number; the relay deletes them |
| `PUT /v1/blob?id=&from=&to=` (raw body) | upload an encrypted photo (<= 12 MB) |
| `GET /v1/blob?id=&device=` | download it (only the addressed devices) |
| `DELETE /v1/account` | wipe everything held for the account |

Limits: 500 MB of undelivered data per account (`RELAY_QUOTA_BYTES`), 600 requests/minute per account.

## Run

```
RELAY_PROJECT_ID=<your-firebase-project-id> node relay/relay.js     # port 8787, data in relay/relay-data
```

Settings: `RELAY_PROJECT_ID` (required), `RELAY_PORT`, `RELAY_DATA`, `RELAY_TTL_DAYS`, `RELAY_QUOTA_BYTES`.
Zero dependencies, Node 18+. This version stores data on local disk behind a small adapter; a Firebase
(Firestore + Cloud Storage) adapter for hosting on Firebase Functions comes with the Firebase project.
