#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v flutter >/dev/null || { echo 'Install Flutter first: https://docs.flutter.dev/install'; exit 1; }
flutter create --org net.litamerica --project-name rowskan --platforms android,ios,windows,macos .
python3 tool/configure.py
rm -f test/widget_test.dart
flutter pub get
flutter analyze
flutter test
flutter build macos --release
printf '\nBuilt application is in build/macos/Build/Products/Release/.\n'
