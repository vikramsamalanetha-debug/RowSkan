// Adds the camera/photo permissions the VIN scanner needs to the generated native projects. Safe to run twice.
const fs = require('fs'), path = require('path');
const which = process.argv[2];
if (which === 'android') {
  const f = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'); let x = fs.readFileSync(f, 'utf8');
  if (!/android.permission.CAMERA/.test(x)) x = x.replace('<application', '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <application');
  if (!/ACCESS_FINE_LOCATION/.test(x)) x = x.replace('<application', '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <application');
  fs.writeFileSync(f, x); console.log('android manifest patched');
} else if (which === 'ios') {
  const f = path.join(__dirname, 'ios', 'App', 'App', 'Info.plist'); let x = fs.readFileSync(f, 'utf8');
  const add = (k, v) => { if (x.indexOf('<key>' + k + '</key>') < 0) x = x.replace(/<\/dict>\s*<\/plist>/, '\t<key>' + k + '</key>\n\t<string>' + v + '</string>\n</dict>\n</plist>'); };
  add('NSCameraUsageDescription', 'RowSkan uses the camera to scan VIN barcodes and take photos of your vehicles.');
  add('NSLocationWhenInUseUsageDescription', 'RowSkan saves where a vehicle is parked so you can find it again in the lot.');
  add('NSPhotoLibraryUsageDescription', 'RowSkan lets you pick existing photos of a vehicle from your library.');
  fs.writeFileSync(f, x); console.log('Info.plist patched');
  // Apple requires iOS 15+ from April 2027
  const pj = path.join(__dirname, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), pf = path.join(__dirname, 'ios', 'App', 'Podfile');
  if (fs.existsSync(pj)) fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 15.0;'));
  if (fs.existsSync(pf)) fs.writeFileSync(pf, fs.readFileSync(pf, 'utf8').replace(/platform :ios, '[0-9.]+'/, "platform :ios, '15.0'"));
  console.log('iOS deployment target set to 15.0');
} else { console.error('usage: node patch-native.js android|ios'); process.exit(1); }
