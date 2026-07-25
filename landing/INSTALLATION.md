# 🚀 Quick Installation Guide

Schnelle Anleitung zur Installation der DucKI Agent Landingpage.

## ⏱️ 5-Minuten Quick Start

### 1. Voraussetzungen prüfen
```bash
# PHP Version (7.4 oder höher)
php -v

# Webserver (Apache mit mod_rewrite)
apache2ctl -M | grep rewrite

# Oder Nginx (manuell konfigurieren)
nginx -v
```

### 2. Dateien hochladen

**Lokal (auf Ihrem Computer):**
```bash
cd landing
ls -la
# Sollte zeigen: index.html, api/, assets/, .htaccess, etc.
```

**Auf Server (via SCP):**
```bash
scp -r landing/* user@your-server:/var/www/ducki-landing/
```

**Oder via FTP:**
- Verbinden Sie sich mit Ihrem FTP-Client
- Laden Sie alles aus dem `landing/` Verzeichnis hoch

### 3. Permissions (Linux/Unix)
```bash
ssh user@your-server
cd /var/www/ducki-landing

# Verzeichnisse: 755
find . -type d -exec chmod 755 {} \;

# Dateien: 644
find . -type f -exec chmod 644 {} \;

# Special: API data directory für Writes
chmod 775 api/data
```

### 4. Testen

**Browser:**
```
https://ducki-ai-agent.davidduckwitz.de/
```

**Terminal:**
```bash
# API Health
curl https://ducki-ai-agent.davidduckwitz.de/api/health

# Tools
curl https://ducki-ai-agent.davidduckwitz.de/api/tools | jq '.data.tools | length'

# Skills
curl https://ducki-ai-agent.davidduckwitz.de/api/skills | jq '.data.skills | length'
```

**Sollte zeigen:**
- ✅ Hauptseite lädt
- ✅ API antwortet mit 200 OK
- ✅ 17 Tools aufgelistet
- ✅ 23+ Skills aufgelistet

---

## 📋 Detaillierte Installation

### Option A: Shared Hosting

1. **FTP-Zugang öffnen**
   - Host: ftp.your-domain.com
   - Benutzer: your-username
   - Passwort: your-password

2. **Verzeichnis erstellen**
   - Navigieren zu: `/public_html/` oder `/htdocs/`
   - Neuer Ordner: `ducki-agent` (oder ähnlich)

3. **Dateien hochladen**
   - Alle Dateien aus `landing/` hochladen
   - Behalte Verzeichnisstruktur bei

4. **Testen**
   ```
   https://your-domain.com/ducki-agent/
   ```

### Option B: VPS (Apache)

```bash
# SSH verbinden
ssh root@123.45.67.89

# Paket installieren
apt update && apt install -y apache2 php8.1 certbot python3-certbot-apache

# Modul aktivieren
a2enmod rewrite
a2enmod php8.1

# Verzeichnis vorbereiten
mkdir -p /var/www/ducki-landing
chown -R www-data:www-data /var/www/ducki-landing

# Dateien hochladen (lokal)
scp -r landing/* root@123.45.67.89:/var/www/ducki-landing/

# Zurück auf Server
ssh root@123.45.67.89

# Permissions
cd /var/www/ducki-landing
find . -type d -exec chmod 755 {} \;
find . -type f -exec chmod 644 {} \;

# VirtualHost erstellen
cat > /etc/apache2/sites-available/ducki-agent.conf << 'EOF'
<VirtualHost *:80>
    ServerName ducki-ai-agent.davidduckwitz.de
    DocumentRoot /var/www/ducki-landing
    
    <Directory /var/www/ducki-landing>
        AllowOverride All
        Require all granted
    </Directory>
    
    ErrorLog ${APACHE_LOG_DIR}/ducki-agent-error.log
    CustomLog ${APACHE_LOG_DIR}/ducki-agent-access.log combined
</VirtualHost>
EOF

# VirtualHost aktivieren
a2ensite ducki-agent.conf
systemctl reload apache2

# SSL (Let's Encrypt)
certbot --apache -d ducki-ai-agent.davidduckwitz.de
```

### Option C: VPS (Nginx)

```bash
# SSH verbinden
ssh root@123.45.67.89

# Pakete installieren
apt update && apt install -y nginx php8.1-fpm certbot python3-certbot-nginx

# Verzeichnis vorbereiten
mkdir -p /var/www/ducki-landing
chown -R www-data:www-data /var/www/ducki-landing

# Dateien hochladen (lokal)
scp -r landing/* root@123.45.67.89:/var/www/ducki-landing/

# Zurück auf Server
ssh root@123.45.67.89

# Permissions
cd /var/www/ducki-landing
find . -type d -exec chmod 755 {} \;
find . -type f -exec chmod 644 {} \;

# Nginx Config
cat > /etc/nginx/sites-available/ducki-agent << 'EOF'
server {
    listen 80;
    server_name ducki-ai-agent.davidduckwitz.de;
    root /var/www/ducki-landing;
    
    location /api {
        try_files $uri $uri/ /api/index.php?$query_string;
    }
    
    location ~ \.php$ {
        fastcgi_pass unix:/run/php/php8.1-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

# Site aktivieren
ln -s /etc/nginx/sites-available/ducki-agent /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# SSL
certbot --nginx -d ducki-ai-agent.davidduckwitz.de
```

---

## ✅ Verification Checklist

Nach der Installation diese Punkte prüfen:

### Frontend
- [ ] Homepage lädt (`/`)
- [ ] Navigation funktioniert
- [ ] Tools-Seite lädt und Tools sind sichtbar
- [ ] Skills-Seite lädt und Skills sind sichtbar
- [ ] Tool-Details laden (`tool.php?id=browser`)
- [ ] Skill-Details laden (`skill.php?id=code-review`)
- [ ] Suchfunktion funktioniert
- [ ] Dark Mode Toggle funktioniert
- [ ] Links zu GitHub/About funktionieren

### API
```bash
# Health Check (sollte 200 OK geben)
curl -I https://ducki-ai-agent.davidduckwitz.de/api/health

# Tools zählen (sollte 17 zeigen)
curl https://ducki-ai-agent.davidduckwitz.de/api/tools 2>/dev/null | \
  jq '.data.tools | length'

# Skills zählen (sollte 23+ zeigen)
curl https://ducki-ai-agent.davidduckwitz.de/api/skills 2>/dev/null | \
  jq '.data.skills | length'

# Installation testen (sollte success: true geben)
curl -X POST https://ducki-ai-agent.davidduckwitz.de/api/install/tool/filesystem \
  2>/dev/null | jq '.success'

# Installationsverlauf (sollte Einträge zeigen)
curl https://ducki-ai-agent.davidduckwitz.de/api/installations 2>/dev/null | \
  jq '.data.total'
```

---

## 🔧 Troubleshooting

### Problem: API gibt 404 zurück

**Apache Lösung:**
```bash
# .htaccess Datei prüfen
cat /var/www/ducki-landing/.htaccess

# mod_rewrite aktivieren
a2enmod rewrite
systemctl restart apache2

# VirtualHost Config prüfen (AllowOverride All muss gesetzt sein)
grep "AllowOverride" /etc/apache2/sites-available/ducki-agent.conf
```

**Nginx Lösung:**
```bash
# Config prüfen
cat /etc/nginx/sites-available/ducki-agent

# Syntax testen
nginx -t

# Neu laden
systemctl reload nginx
```

### Problem: JSON-Dateien fehlen

```bash
# Dateien sind da?
ls -la /var/www/ducki-landing/api/data/

# Falls nicht, erstellen
touch /var/www/ducki-landing/api/data/installations.json
echo '{"installations":[]}' > /var/www/ducki-landing/api/data/installations.json

# Permissions
chmod 644 /var/www/ducki-landing/api/data/*.json
```

### Problem: PHP wird nicht ausgeführt

```bash
# PHP-FPM läuft?
systemctl status php8.1-fpm

# PHP-CLI testen
php -v

# Apache: php8.1 module laden
a2enmod php8.1
systemctl restart apache2
```

### Problem: 403 Forbidden

```bash
# Permissions prüfen
ls -l /var/www/ducki-landing/

# Sollte sein: drwxr-xr-x www-data www-data

# Falls nicht, beheben
chown -R www-data:www-data /var/www/ducki-landing
chmod 755 /var/www/ducki-landing
find /var/www/ducki-landing -type d -exec chmod 755 {} \;
find /var/www/ducki-landing -type f -exec chmod 644 {} \;
```

---

## 📊 Performance-Check

Nach Installation empfohlen:

```bash
# Page Speed Test
curl -w "@curl-format.txt" -o /dev/null -s https://ducki-ai-agent.davidduckwitz.de/

# API Response Time
curl -w "Time: %{time_total}s\n" -o /dev/null -s https://ducki-ai-agent.davidduckwitz.de/api/tools

# Ziel: < 100ms API, < 1s Page Load
```

---

## 🔐 Nach-Installation Sicherheit

```bash
# SSL/TLS testen
curl -I https://ducki-ai-agent.davidduckwitz.de/ | grep "Strict-Transport"

# Security Headers prüfen
curl -I https://ducki-ai-agent.davidduckwitz.de/ | grep -E "X-Frame-Options|X-Content-Type"

# HSTS aktiviert?
curl -I https://ducki-ai-agent.davidduckwitz.de/ | grep "Strict-Transport-Security"
```

---

## 📝 Konfigurationsbeispiel

Minimale `.env` falls nötig (optional):

```env
# Optional für zukünftige Features
APP_NAME=DucKI-Agent-Landing
APP_ENV=production
API_URL=https://api.ducki-agent.davidduckwitz.de/api

# Installation Tracking (optional)
TRACK_INSTALLATIONS=true
LOG_DIR=/var/www/ducki-landing/logs
```

---

## 📞 Support

Falls Probleme:

1. **Logs prüfen:**
   ```bash
   tail -50 /var/log/apache2/ducki-agent-error.log
   tail -50 /var/log/nginx/ducki-agent-error.log
   ```

2. **Syntax prüfen:**
   ```bash
   php -l api/index.php
   php -l api/controllers/InstallController.php
   ```

3. **Kurz-Test:**
   ```bash
   # Lokal auf Server
   php -S localhost:8000 -t /var/www/ducki-landing/
   ```

4. **Support kontaktieren:**
   - Email: davidduckwitz@googlemail.com
   - GitHub: https://github.com/davidduckwitz/ducKI-Agent/issues

---

## 🎉 Fertig!

Die Landingpage ist nun live und der Agent kann automatisch Tools/Skills installieren.

**Nächste Schritte:**
1. ✅ Alle Seiten testen
2. ✅ API testen
3. ✅ Installation testen
4. ✅ Monitoring einrichten
5. ✅ Backups konfigurieren

Viel Erfolg! 🚀
