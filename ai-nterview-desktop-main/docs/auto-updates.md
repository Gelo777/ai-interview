# Автообновления через GitHub Releases

Проект подготовлен под обновления через Tauri Updater и GitHub Releases.

Что уже сделано:

- в приложение встроен публичный ключ обновлений;
- updater-artifacts включены в `src-tauri/tauri.conf.json`;
- при GitHub-сборке endpoint обновлений подставляется автоматически как `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`;
- workflow для релиза лежит в `.github/workflows/release.yml`.

Что нужно сделать один раз:

1. Загрузить проект в GitHub-репозиторий.
2. Добавить в `GitHub -> Settings -> Secrets and variables -> Actions` секреты:
   - `TAURI_SIGNING_PRIVATE_KEY`
     - содержимое файла `C:\Users\Dmitry\.tauri\ai-interview-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
     - пароль от ключа
3. При выпуске новой версии обновить версию в:
   - `package.json`
   - `src-tauri/tauri.conf.json`
4. Создать git tag вида `v0.1.1` и отправить его в GitHub.

Что произойдет дальше:

- GitHub Actions соберет Windows-установщик;
- релиз опубликуется в GitHub Releases;
- `latest.json` загрузится автоматически;
- установленное приложение при запуске сможет предложить обновление пользователю.

Перед публичным запуском лучше сохранить приватный updater-ключ в безопасном месте и не держать его только на одном компьютере.
