# Развёртывание и передача на AdminVPS

Документ описывает воспроизводимый deployment для этапа 10. Фактическое подключение к AdminVPS, изменение его сервисов и публикация домена в этом этапе не выполнялись: для них нужны параметры VPS и доступ владельца.

Текущая рабочая версия сохранена в GitHub commit `376066c` на `origin/main`, поэтому команда `git clone` ниже получает этот checkout. Сам deployment на AdminVPS всё ещё не выполнялся.

## Что нужно получить до deployment

- ОС и версия Docker Engine/Compose на VPS, доступ по SSH с правами на запуск Compose;
- доменное имя и доступ к DNS, свободные внешние порты `80` и `443`;
- список уже занятых портов и reverse proxy, чтобы не остановить чужой сервис;
- место для PostgreSQL, документов и локальных временных копий;
- каталог или отдельное хранилище для копий вне VPS, срок хранения и ответственный за восстановление.

Не считайте VPS пустым. Сначала сохраните инвентаризацию:

```bash
docker version
docker compose version
ss -ltnp | grep -E ':(80|443|3000|5432)\b' || true
docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
```

## Первый запуск

Разместите checkout, скопируйте шаблон конфигурации и ограничьте доступ к нему:

```bash
sudo mkdir -p /opt/fssp
sudo chown "$USER":"$USER" /opt/fssp
git clone https://github.com/VIRYS92/FSSP.git /opt/fssp
cd /opt/fssp
cp .env.example .env
chmod 600 .env
```

В `.env` задайте длинный случайный `POSTGRES_PASSWORD`, доменное имя отдельно в reverse proxy, `COOKIE_SECURE=true` при работе через HTTPS и сначала `ALLOW_BOOTSTRAP=true`. Не добавляйте `.env`, копии БД или документы в Git.

Проверьте конфигурацию и запустите PostgreSQL, миграцию, API и worker:

```bash
docker compose config --quiet
docker compose up -d --build
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
docker compose ps
```

Создайте первого администратора через закрытый loopback-порт. Используйте собственный пароль и не сохраняйте команду с ним в истории shell:

```bash
curl --fail --silent -X POST http://127.0.0.1:3000/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"login":"<admin-login>","displayName":"<display-name>","password":"<long-password>"}'
```

Сразу после успешного создания администратора измените `.env` на `ALLOW_BOOTSTRAP=false` и перезапустите приложение:

```bash
docker compose up -d app worker
curl --fail http://127.0.0.1:3000/readyz
```

Повторный bootstrap после этого должен быть закрыт. Рабочие записи из `REESTR.xlsm` и прикреплённые PDF на deployment не импортируются.

## HTTPS и reverse proxy

Приложение публикуется только на loopback `127.0.0.1:3000`; PostgreSQL наружу не открывается. Для Caddy можно взять [ops/Caddyfile.example](../ops/Caddyfile.example), заменить `example.com` на настоящий домен и проверить конфигурацию перед reload. Caddy автоматически получает сертификат, если DNS указывает на VPS и порты `80/443` доступны.

Перед включением HTTPS выставьте `COOKIE_SECURE=true`, затем проверьте снаружи:

```bash
curl --fail -I https://<domain>/healthz
curl --fail https://<domain>/readyz
```

Существующий Nginx/Traefik можно использовать вместо Caddy с теми же границами: TLS завершается на proxy, API получает только внутренний трафик, порт PostgreSQL не публикуется.

## Резервные копии

`ops/backup.sh` сохраняет custom-format `pg_dump`, архив постоянного тома документов, manifest версий и SHA-256. Скрипт не сохраняет `.env` и секреты. Он рассчитан на запущенный Compose и удаляет каталоги старше `RETENTION_DAYS` (по умолчанию 14 дней).

```bash
cd /opt/fssp
set -a
. ./.env
set +a
BACKUP_ROOT=/var/backups/fssp RETENTION_DAYS=14 ./ops/backup.sh
```

Каталог `/var/backups/fssp` должен иметь права только для оператора и регулярно копироваться за пределы VPS. После копирования проверяйте `SHA256SUMS`; хотя бы одну копию нужно восстановить в отдельной среде до передачи системы в эксплуатацию.

Скрипт не шифрует содержимое backup: перед передачей за пределы VPS используйте шифрование выбранного хранилища или отдельный проверенный `age`/GPG-процесс. Не отправляйте raw backup в публичные или общие каталоги.

## Восстановление и откат

Восстановление заменяет содержимое БД и документов. Перед ним создайте свежую защитную копию и остановите операции пользователей. Скрипт требует явного подтверждения и проверяет SHA-256:

```bash
cd /opt/fssp
set -a
. ./.env
set +a
CONFIRM_RESTORE=YES BACKUP_DIR=/var/backups/fssp/<timestamp> ./ops/restore.sh
```

Миграции имеют только прямое применение. Обновление не должно пытаться «откатить» SQL автоматически: при проблеме остановите API/worker, восстановите последнюю проверенную копию через `ops/restore.sh`, затем верните предыдущий образ/checkout и проверьте `/readyz`.

## Обновление

Перед обновлением создайте резервную копию и зафиксируйте текущий commit. После получения проверенного commit выполните:

```bash
cd /opt/fssp
set -a
. ./.env
set +a
./ops/backup.sh
git fetch --ff-only origin
git checkout <release-commit-or-tag>
docker compose config --quiet
docker compose build
docker compose run --rm migrate
docker compose up -d app worker
curl --fail http://127.0.0.1:3000/readyz
```

Если миграция не прошла, `app` не должен считаться обновлённым. Сохраните логи `docker compose logs migrate`, не удаляйте старый backup и восстановите отдельную копию в тестовой среде перед повтором.

## Критерии передачи

Передача считается готовой после проверки на самом VPS: чистый checkout запускается, миграции проходят, `/healthz` и `/readyz` отвечают, HTTPS обслуживает домен, `ALLOW_BOOTSTRAP=false`, viewer/editor/admin проверены, backup копируется вне VPS и отдельное восстановление возвращает readiness. До этих проверок нельзя заявлять, что приложение опубликовано или что восстановление подтверждено.
