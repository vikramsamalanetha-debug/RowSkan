# RowSkan phone apps (Android and iPhone)

The phone apps are the web app in `../app` wrapped with Capacitor. A product of [LIT America](https://www.litamerica.net).
Nothing native is committed: the GitHub workflows create the Android/iPhone projects on every build.

## Android
GitHub → Actions → **Build Android app** → Run workflow. When it finishes, download the artifact `rowskan-android-debug-apk` and install the APK on an Android phone (allow "install unknown apps").
Publishing to Google Play later needs a signing key (one-time setup).

## iPhone (TestFlight)
One-time setup in your Apple developer account:
1. App Store Connect → Apps → **+ New App**: platform iOS, name RowSkan, bundle ID `net.litamerica.rowskan` (register it under Certificates, Identifiers & Profiles → Identifiers if it is not listed), SKU `rowskan`.
2. App Store Connect → Users and Access → Integrations → **App Store Connect API** → generate a key with the **Admin** (or App Manager) role. Note the **Key ID** and **Issuer ID**, and download the `.p8` file (it can only be downloaded once).
3. Your **Team ID** is under Membership details in the developer account.
4. GitHub → repository → Settings → Secrets and variables → Actions → add these four secrets:
   - `ASC_KEY_ID` - the Key ID
   - `ASC_ISSUER_ID` - the Issuer ID
   - `ASC_KEY_P8_BASE64` - the .p8 file encoded as base64 (Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("AuthKey_XXXX.p8"))`)
   - `APPLE_TEAM_ID` - the Team ID
5. Actions → **Build iPhone app** → Run workflow → tick **Upload to TestFlight**. After about 15 minutes the build appears in App Store Connect → TestFlight; install it with the TestFlight app on your iPhone.

Running the workflow without the tick only checks that the app compiles.
