@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%

set "PATH=C:\Users\Dmitry\.cargo\bin;%PATH%"

npm run tauri build
