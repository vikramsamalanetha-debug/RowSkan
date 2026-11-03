@echo off
cd /d "%~dp0"
where flutter >nul 2>nul
if errorlevel 1 (
 echo Flutter SDK is required. Install Flutter and Visual Studio Desktop development with C++.
 echo Instructions: https://docs.flutter.dev/install
 pause
 exit /b 1
)
call flutter create --org net.litamerica --project-name rowskan --platforms android,ios,windows,macos .
if errorlevel 1 goto fail
python tool\configure.py
if errorlevel 1 goto fail
if exist test\widget_test.dart del test\widget_test.dart
call flutter pub get
if errorlevel 1 goto fail
call flutter analyze
if errorlevel 1 goto fail
call flutter test
if errorlevel 1 goto fail
call flutter build windows --release
if errorlevel 1 goto fail
 echo Build ready under build\windows\x64\runner\Release. Keep the whole folder together.
 pause
 exit /b 0
:fail
 echo Build stopped. Copy the error above for troubleshooting.
 pause
 exit /b 1
