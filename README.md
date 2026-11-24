

# WinRM-VPN

IPv4-туннель. Проект реализует стелс-мимикрию под типовой корпоративный трафик: **Linux-клиент с Ansible (`pywinrm` / OpenSSL 3.x)**, управляющий удалённым сервером **Windows Server 2022/2025 по WinRM over HTTPS (`5986/TCP`)**.

- **Сервер:** Единый статический бинарник для Linux `x86_64` (Go-бэкенд с userspace TCP/IP стеком gVisor + встроенный фронтенд на Rustls). **Не требует root-прав, не требует `/dev/net/tun` и не требует настройки `iptables`/NAT**

- **Клиент:** Android APK (`VpnService` + Go-ядро с кастомным `uTLS` под профиль Linux OpenSSL 3.x). и характерным для Ansible набором шифров при установлении TLS соединения

---

## Быстрая автоматическая установка сервера (Debian 12 / 13)

Выполните на сервере под `root` одну команду:
```bash
curl -fsSL https://raw.githubusercontent.com/n0nam4ik/wirm-tunnel/main/install.sh | sudo bash
```

## Обновление до последней версии

```bash
curl -fsSL https://raw.githubusercontent.com/n0nam4ik/wirm-tunnel/main/update.sh | sudo bash
```

---
## Ключевые особенности и маскировка

1. **Единый бинарник All-in-One :** Фронтенд на `rustls 0.23` встроен прямо в Go-сервер через `//go:embed`. Никаких скриптов настройки, фоновых демонов или зависимостей.
2. **Точный TLS-отпечаток Schannel (AES-GCM only):** Встроенный Rustls скомпилирован строго **без поддержки `ChaCha20`**. При активном зондировании цензором шифр `TLS_CHACHA20_POLY1305_SHA256` отклоняется ошибкой хендшейка — в точности как на реальном Windows Server 2022/2025.
3. **Userspace Netstack (gVisor):** Маршрутизация трафика происходит в оперативной памяти процесса. Сервер работает на любых VPS (включая LXC/OpenVZ) без привилегий суперпользователя и поддерживает одновременное подключение множества клиентов без конфликтов IP.
4. **Устранение Cross-Layer Fingerprint Mismatch:** Android-клиент отправляет пакеты ядра Linux и TLS `ClientHello` библиотеки OpenSSL 3.x (профиль Ansible `pywinrm`). Внешний DPI видит естественную связку: «Linux-хост администрирует Windows-сервер».
5. **Защита от детекта TLS-in-TLS:** Инспектор пакетов перехватывает вложенные HTTPS-хендшейки (`0x16 0x03`), накладывает случайный динамический паддинг (150–700 байт) и дробит их на несколько внешних TLS-рекордов с микро-джиттером, разрушая сигнатуру браузинга.
6. **Защита от Active Probing:** Любой сканер (Nmap, Shodan, цензор) без знания секретного ключа (PSK) взаимодействует с эмулятором `Microsoft-HTTPAPI/2.0`:
   - На запрос WS-Management `Identify` возвращается XML-ответ `Microsoft Corporation (Stack 3.0)`.
   - На некорректные HTTP-запросы возвращается эталонный `400 Bad Request` от `http.sys`.
   - Имя хоста (`WIN-XXXXXXXXXXX`) генерируется случайно при первом старте и сохраняется в самоподписанный сертификат.

---

## Развёртывание сервера (Linux x86_64)

### 1. Скачивание бинарника
Скачайте готовый `winrm-vpn-server` из раздела **Releases** вашего GitHub-репозитория и скопируйте его на VPS:

```bash
mkdir -p /opt/winrm-vpn
cd /opt/winrm-vpn
# Загрузите winrm-vpn-server в эту папку
chmod +x winrm-vpn-server
```

### 2. Открытие порта в фаерволе
WinRM HTTPS стандартно использует порт `5986/TCP`:

```bash
# Если используется ufw:
ufw allow 5986/tcp

# Если на хостинге (Hetzner, Oracle, AWS и др.) есть внешний Firewall —
# обязательно добавьте входящее правило: TCP 5986, Source: 0.0.0.0/0
```

### 3. Первый запуск и получение Certificate Pin

Сгенерируйте секретный ключ (PSK):
```bash
openssl rand -hex 24
```

Запустите сервер:
```bash
./winrm-vpn-server -listen 0.0.0.0:5986 -psk "ВАШ_СГЕНЕРИРОВАННЫЙ_PSK"
```

При первом запуске сервер сам создаст уникальный самоподписанный сертификат `WIN-XXXXXXXXXXX` и выведет в консоль:

```text
================================================================
WinRM-VPN Server v0.0.7 (All-in-One: Rustls + gVisor) Ready on 0.0.0.0:5986
Emulated Windows Hostname: WIN-B4K9M2P1Q8Z
Loaded PSK keys: 1
Certificate SHA-256 Pin (copy to Android App):
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
================================================================
```

**Скопируйте 64-символьный хэш `Certificate SHA-256 Pin`** — он понадобится для подключения в приложении.

Остановите сервер клавишами `Ctrl + C`.

---

### 4. Настройка автозапуска через systemd

Чтобы сервер работал в фоне и автоматически перезапускался при перезагрузке VPS:

```bash
cat << 'EOF' > /etc/systemd/system/winrm-vpn.service
[Unit]
Description=WinRM-VPN Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/winrm-vpn
ExecStart=/opt/winrm-vpn/winrm-vpn-server -listen 0.0.0.0:5986 -psk "ВАШ_СГЕНЕРИРОВАННЫЙ_PSK"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```
*(Не забудьте вписать ваш ключ вместо `ВАШ_СГЕНЕРИРОВАННЫЙ_PSK`).*

Запустите службу:
```bash
systemctl daemon-reload
systemctl enable --now winrm-vpn
```

Проверьте статус:
```bash
systemctl status winrm-vpn
```

> **Совет для максимальной маскировки (если есть root):** выполните на сервере команду:  
> `sysctl -w net.ipv4.tcp_timestamps=0`  
> Это отключит метки времени TCP, сделав TCP-стек Linux неотличимым от Windows Server 2022.

---

## Подключение с Android

1. Скачайте и установите **`winrm-vpn-client.apk`** из раздела **Releases**.
2. Заполните поля подключения:
   - **Server IP:Port:** `<IP_ВАШЕГО_СЕРВЕРА>:5986`
   - **Pre-Shared Key (PSK):** ваш секретный ключ
   - **Cert SHA-256 Pin:** 64-символьный хэш из шага 3 (защищает от MITM)
3. Нажмите **Connect** и подтвердите запрос системы на создание VPN-профиля.
4. После перехода статуса в `Подключено` используйте встроенные кнопки:
   - **Тест ping 8.8.8.8** — проверка доступности DNS и ICMP.
   - **Проверить IP и страну** — запрос внешнего IP через `ifconfig.io` с выводом флага страны.

---

## Сборка из исходников

Проект настроен на полностью автоматическую облачную сборку через **GitHub Actions** (`.github/workflows/build.yml`). При любом коммите в репозиторий workflow собирает статический бинарник сервера и APK, после чего автоматически публикует их в **GitHub Releases**.

*Проект разработан исключительно в исследовательских целях для тестирования устойчивости систем глубокого анализа пакетов (DPI).*
