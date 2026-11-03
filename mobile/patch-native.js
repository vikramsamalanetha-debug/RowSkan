// Adds the camera/photo permissions the VIN scanner needs to the generated native projects. Safe to run twice.
const fs = require('fs'), path = require('path');
const which = process.argv[2];
if (which === 'android') {
  const f = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'); let x = fs.readFileSync(f, 'utf8');
  if (!/android.permission.CAMERA/.test(x)) x = x.replace('<application', '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <application');
  fs.writeFileSync(f, x); console.log('android manifest patched');
} else if (which === 'ios') {
  const f = path.join(__dirname, 'ios', 'App', 'App', 'Info.plist'); let x = fs.readFileSync(f, 'utf8');
  const add = (k, v) => { if (x.indexOf('<key>' + k + '</key>') < 0) x = x.replace(/<\/dict>\s*<\/plist>/, '\t<key>' + k + '</key>\n\t<string>' + v + '</string>\n</dict>\n</plist>'); };
  add('NSCameraUsageDescription', 'RowSkan uses the camera to scan VIN barcodes and take photos of your vehicles.');
  add('NSPhotoLibraryUsageDescription', 'RowSkan lets you pick existing photos of a vehicle from your library.');
  fs.writeFileSync(f, x); console.log('Info.plist patched');
} else { console.error('usage: node patch-native.js android|ios'); process.exit(1); }
