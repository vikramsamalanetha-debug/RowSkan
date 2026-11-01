# RowSkan

Scan a vehicle's VIN with a phone, take its photos, move on to the next vehicle — then sync the whole batch to the
computer over WiFi. VIN details (year, make, model, trim, body, drive, engine, fuel) are filled in automatically
from the free NHTSA VIN database.

*A product of [LIT America](https://www.litamerica.net) — www.litamerica.net*

---

## How it fits together

| | What it is | Where it runs |
|---|---|---|
| **Computer app** | Small program that stores the inventory and shows the dashboard (table, photos, search, CSV export) | Your Windows / Mac computer |
| **Phone app** | Web app served by the computer. Camera scan, photo capture, offline queue. Can be added to the home screen so it opens like an installed app | Your phone's browser |

Everything stays on your own computer. Nothing is sent to any cloud. The only outside call is the VIN lookup
(`vpic.nhtsa.dot.gov`, a free U.S. government service).

## Setup — computer (one time, about 5 minutes)

1. Install **Node.js** (LTS version) from https://nodejs.org
2. **Windows only:** install **Git for Windows** from https://git-scm.com/download/win — it provides `openssl`, which RowSkan uses to create its secure connection. (Mac/Linux already have it.)
3. Unzip this folder anywhere (for example `C:\RowSkan`).
4. Double-click **`start.bat`** (Windows) or run **`./start.sh`** (Mac/Linux).
5. If Windows asks about the firewall, click **Allow access** and tick **Private networks**.

The dashboard opens at http://localhost:8080/. Leave that window open while you work.

6. **Sign in or register.** The first screen has **Sign In** and **Register** tabs: email and password (at least 8 characters).
   **Forgot your password?** emails a reset link to the registered address. (Your inventory and photos never leave your devices;
   the email is only used to sign you in.) Until you sign in, the app stays locked and phones cannot be linked. Phones never need
   the password: they link by QR code.

## Link a phone (one time, like WhatsApp Web)

1. Join the phone to the **same WiFi** as the computer.
2. On the dashboard, open **Link a phone**. Point the phone's **camera app** at the QR code and open the link
   (or open the phone link and type the 8-character code shown under the QR).
3. The phone will say the connection is "not private" — expected (it is your own computer talking to your own phone).
   Choose **Advanced → Continue/Proceed**.
4. Allow camera access. The phone is linked: it now has its own secret key and its own copy of the inventory.
5. *Optional:* browser menu → **Add to Home screen** so it opens like an app.

The code works once and expires in 5 minutes (the dashboard makes a fresh one automatically). The dashboard's **Linked phones**
list shows every phone and lets you **Unlink** one at any time (lost or replaced phone). An unlinked phone keeps the photos
it already has but can no longer sync until it is linked again.

## Where the data lives (the WhatsApp model)

* **Each device keeps its own data.** The phone stores its vehicles and photos on the phone; the computer stores everything on
  the computer's disk. There is no cloud account and no online copy.
* Syncing is two-way: what the phone captures goes to the computer, and the computer's inventory (including vehicles added or
  edited on the computer) is copied to the phone. Photos you have not opened on the phone download the first time you view them,
  then stay there. Deleting a vehicle on the computer removes it from linked phones; unsent work on a phone is never overwritten.

## Everyday use

1. **Scan next vehicle** → aim at the VIN barcode (door-jamb sticker). It beeps and the vehicle's details appear.
   No barcode? Type the VIN, or use **Pick a photo** on a picture of the VIN.
2. Walk around the vehicle tapping the big round button for each photo. Add a lot spot / note if you like.
3. **Done — next vehicle** saves it and returns straight to the scanner. Repeat.
4. **Sync.** With *Sync automatically* on (default), anything finished uploads by itself whenever the phone is on the
   same WiFi as the computer — right away if already connected, or as soon as you walk back into range.
   Prefer manual? Tap **Sync now** on the home screen (or switch automatic sync off under the connection status button).

Photos are never lost if you are out of range: they wait on the phone until the computer is reachable. Syncing the
same vehicle twice never creates duplicates.

On the computer, the dashboard updates live as vehicles arrive. Click a row to see photos, edit lot spot/notes,
retry a VIN lookup, or delete. **Export CSV** opens in Excel. Photos are plain JPEG files in `data/vehicles/<VIN>/photos/`
— back up the `data` folder to back up the inventory.

## Using only the computer (no phone needed)

On the dashboard click **＋ Add vehicle / photos**. Type the VIN or click **Scan VIN with webcam**, then take photos with the
computer's webcam, or drag in / choose photo files already on the computer. **Save to inventory** puts them in the same
folder and table as the phone's. The same button appears as **＋ Add photos** inside any vehicle.
Any other device with a browser (a tablet, a second laptop) can also be a capture station: open the phone link on it.

## Account sign-up (one-time setup by the app owner)

Sign-in uses **Firebase Authentication** (email + password), the same service as DayZift. Whoever distributes RowSkan (LIT America)
sets this up **once**. The password is forwarded straight to Firebase over HTTPS and is never saved or logged by RowSkan.

1. In the Firebase console create a project for RowSkan (separate from DayZift).
2. *Build → Authentication → Sign-in method:* enable **Email/Password**.
3. *Project settings → General:* copy the **Web API key** into `account.config.json`: `{ "firebaseApiKey": "AIza..." }`.
   (A Firebase web API key is designed to be public.) Restart RowSkan.
4. *Authentication → Templates → Password reset:* edit the sender name/wording if you like. Firebase sends the reset link itself.
5. Password rules: 8-72 characters, not a very common password (e.g. 12345678), not one repeated character. Five wrong
   passwords lock that email for one minute on the computer.

*Demo mode:* start with the environment variable `ROWSKAN_ACCOUNT_DEV=1`; accounts are kept in memory on this computer and no
emails are sent. For demos only; it announces itself and those registrations are ignored when demo mode is off.

**Not built yet (needed before app-store listings):** in-app **account deletion** (Apple requires it whenever an app lets you
create an account), sign-out, and a privacy policy page — the stores ask for a link to one.

## Good to know (please read)

* **Same-WiFi requirement.** The phone can only sync while it can reach the computer. If your computer's address
  changes (router restart), re-scan the QR code. Giving the computer a fixed address in your router ("DHCP reservation") avoids this.
* **Lot without WiFi coverage.** The phone app keeps working while it is already open, and queues everything. To also
  *open* the app away from WiFi, install the RowSkan certificate on the phone once (dashboard → "install the RowSkan certificate")
  so the phone fully trusts the computer; the app then caches itself. Without it, open the app while on WiFi and leave it open.
* **Barcode types.** Door-jamb Code 39 barcodes are read on every phone (built-in reader on Android/Chrome, RowSkan's own
  reader elsewhere, e.g. iPhone). Newer 2D codes (PDF417 / Data Matrix / QR) are read only where the browser provides its
  barcode reader (Android Chrome). Windshield-plate VINs have no barcode: type them.
* **VIN lookup coverage.** NHTSA decodes U.S.-market vehicles from 1981 on. Older or foreign VINs may return no details;
  the vehicle is still saved.
* **Security.** Each phone gets its own 256-bit key when linked; the computer stores only a hash of it, and any phone can be
  unlinked instantly. Link codes are single-use and expire. Only the computer itself can create codes, edit, delete, or unlink
  other phones. After 8 wrong guesses a device is locked out for a minute. Anyone on your WiFi who also holds a linked phone
  can read and add inventory, so unlink lost phones.
* **Starting automatically on a Windows PC:** press `Win+R`, type `shell:startup`, and put a shortcut to `start.bat` there.

## Files

```
server.js            computer app (no npm packages needed)
public/desktop/      dashboard
public/m/            phone app (+ code39.js, service worker, manifest)
lib/qr/              QR-code encoder (MIT license, from qrcode-terminal)
data/                created on first run: vehicles, photos, certificates, linked-phone list
```
