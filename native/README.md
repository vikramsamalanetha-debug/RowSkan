# RowSkan 0.1.0 — Native source preview
Product of LIT America — https://litamerica.net

This is application SOURCE, not a verified installer. Flutter/Dart and native platform toolchains were unavailable in the authoring environment, so this source has NOT been compiled or tested on a device. Do not use for sole custody of live business records yet.

## Implemented in source
- Shared Flutter app for Android, iOS, Windows and macOS.
- SQLite inventory in application support storage; private local photo files.
- VIN barcode camera scanner on phones; manual entry; online NHTSA decode.
- Native phone camera photo capture, gallery selection, 12 photos per vehicle.
- Retake/remove draft photos before confirming; protected saved team photos on phones.
- Search, status filters, mileage, keys, yard location and notes.
- Solo owner deletion on phone; team desktop deletion; restore last deleted record.
- ZIP export/import of active records and photos. Mobile export uses the system share sheet.
- No analytics, AI API, cloud database, accounts or subscription dependency.

## Build on Windows
1. Install Flutter stable, Python 3, and Visual Studio with Desktop development with C++.
2. Extract this folder and run Setup-Windows.cmd.
3. A successful build puts the app and dependencies in build/windows/x64/runner/Release/. Distribute the whole folder, not only its EXE.
4. For Android install Android Studio/SDK, accept SDK licenses using flutter doctor --android-licenses, then run flutter build apk --release. Device validation and proper release signing are still required before store submission.

## Build on Mac
Install Flutter, Xcode with its command-line tools, CocoaPods and Python 3. Run bash Setup-Mac.sh. For iOS, open ios/Runner.xcworkspace, set the minimum target to 15.5 or above, choose your Apple development team, configure signing and run on a real iPhone. Use flutter build ipa only after device testing.

The setup scripts generate standard platform runners using your installed Flutter SDK and apply camera, gallery, network and file access settings. Generated default widget tests may need removal: the source tests here replace the template app assumptions. Run flutter doctor for missing platform dependencies. Actual store identifiers, artwork, privacy forms and release signing require review before publishing.

## Boundaries of this milestone
- Internet device sync and pairing are NOT implemented. ZIP import is a manual transfer, not synchronization. Existing record IDs/VINs are preserved, so imports do not merge edits.
- Paid cloud storage, billing, authenticated owners/admins, enrollment and encryption at rest are NOT implemented.
- Team permissions apply to the app's local interface and repository operations. They are not protection against a device owner editing files or reinstalling. Secure role enrollment/signed device identity must precede production sync.
- Camera scanner reads VIN barcodes, not printed VIN text. NHTSA requires internet and may provide partial results. Verify details manually.
- Draft/removed photo files are retained locally in this preview. Deletion is soft deletion. Cleanup/retention policy must be implemented before high-volume deployment.
- Interrupted Android camera recovery is attempted when opening intake. Persisted draft forms and crash recovery need additional testing.
- Backups are unencrypted ZIPs; imports are additive and can partially complete before a malformed record fails. Export beforehand. Archive size limits are safeguards, not a complete hostile-file security boundary.
- Database migrations, data-loss recovery, concurrency and actual camera behavior require platform tests. Windows/Mac camera capture is not provided; desktop selects photos.

## Next implementation work
1. Compile, resolve SDK/plugin compatibility, and test all local flows on Windows and Android.
2. Add durable drafts, encrypted backup option, transaction-safe backup import and local photo cleanup.
3. Implement desktop administrator enrollment with device key pairs and QR pairing.
4. Implement resumable encrypted peer sync, signed permissions, conflicts and deletion tombstones. Test LAN first, then signaling and TURN for internet connections. Self-hosting still needs reachable infrastructure and bandwidth.
5. Add opt-in subscription storage and signing/store releases only after sync and security verification.
