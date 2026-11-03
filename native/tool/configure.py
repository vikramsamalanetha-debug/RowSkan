"""Apply RowSkan platform permissions after flutter create. Safe to rerun."""
from pathlib import Path
import plistlib
root=Path(__file__).resolve().parents[1]
p=root/'android/app/src/main/AndroidManifest.xml'
s=p.read_text()
for permission in ['android.permission.INTERNET','android.permission.CAMERA']:
    tag=f'<uses-permission android:name="{permission}"/>'
    if permission not in s:s=s.replace('<application',tag+'\n    <application',1)
s=s.replace('android:label="rowskan"','android:label="RowSkan"');p.write_text(s)
for rel in ['ios/Runner/Info.plist','macos/Runner/Info.plist']:
    p=root/rel
    if not p.exists():continue
    with p.open('rb') as f:d=plistlib.load(f)
    d['CFBundleDisplayName']='RowSkan'
    d['NSCameraUsageDescription']='Scan vehicle VIN barcodes and take inventory photos.'
    d['NSPhotoLibraryUsageDescription']='Choose vehicle photographs for your local inventory.'
    with p.open('wb') as f:plistlib.dump(d,f)
for rel in ['macos/Runner/DebugProfile.entitlements','macos/Runner/Release.entitlements']:
    p=root/rel
    if not p.exists():continue
    with p.open('rb') as f:d=plistlib.load(f)
    d['com.apple.security.network.client']=True
    d['com.apple.security.files.user-selected.read-write']=True
    with p.open('wb') as f:plistlib.dump(d,f)
# Plugin minimum deployment targets. Xcode may require updating its target too.
p=root/'ios/Podfile'
if p.exists():
    import re
    s=p.read_text();s=re.sub(r"#?\s*platform :ios, '[^']+'", "platform :ios, '15.5'",s);p.write_text(s)
print('RowSkan permissions configured. Review Apple deployment target in Xcode.')
