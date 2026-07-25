# DucKI Agent Landingpage - Deployment Anleitung

Vollständige Anleitung zur Bereitstellung der neuen Landingpage mit API.

## 📋 Inhaltsverzeichnis

1. [Voraussetzungen](#voraussetzungen)
2. [Dateistruktur](#dateistruktur)
3. [Deployment-Szenarien](#deployment-szenarien)
4. [Server-Konfiguration](#server-konfiguration)
5. [Sicherheit](#sicherheit)
6. [Troubleshooting](#troubleshooting)

## Voraussetzungen

### System-Anforderungen
- **PHP:** 7.4 oder höher (8.0+ empfohlen)
- **Webserver:** Apache (mit mod_rewrite) oder Nginx
- **Speicherplatz:** ~10 MB
- **Bandbreite:** Minimal (statische Seiten + kleine JSON-Dateien)

### Domain
- `ducki-ai-agent.davidduckwitz.de` (hauptseite & api)
- SSL/TLS Zertifikat erforderlich (Let's Encrypt kostenlos)

## Dateistruktur

```
/var/www/ducki-landing/
├── index.html                    # Hauptseite
├── tools.html                    # Tools-Katalog
├── skills.html                   # Skills-Katalog
├── tool.php                      # Dynamic Tool Details
├── skill.php                     # Dynamic Skill Details
├── documentation.html            # Dokumentation
├── api-docs.html                 # API-Dokumentation
├── about.html                    # About/Contact
│
├── api/
│   ├── index.php                # API Entry Point
│   ├── config.php               # Configuration
│   ├── controllers/
│   │   ├── ToolsController.php  (if needed)
│   │   └── InstallController.php # Installation Management
│   ├── lib/
│   │   └── JsonLoader.php       # Utilities
│   └── data/
│       ├── tools.json           # Tools Metadata (17)
│       ├── skills.json          # Skills Metadata (23+)
│       └── installations.json   # Installation History
│
├── assets/
│   ├── css/
│   │   └── style.css            # Custom Styles
│   └── js/
│       └── main.js              # JavaScript Utilities
│
├── README.md                     # Landing Page Readme
├── DEPLOYMENT.md                 # This File
└── AGENT-INTEGRATION.md          # Agent Integration Guide
```

## Deployment-Szenarien

### Szenario 1: Shared Hosting (Einfach)

**Schritt 1: FTP Upload**
```bash
# Auf Ihrem lokalen Computer
scp -r landing/* user@server:/public_html/
```

**Schritt 2: Permissions setzen**
```bash
# SSH auf Server
chmod 755 /public_html
chmod 644 /public_html/*.html
chmod 644 /public_html/*.php
chmod 755 /public_html/api
chmod 755 /public_html/api/data
chmod 644 /public_html/api/data/*.json
```

**Schritt 3: Testen**
- Besuchen Sie `https://ducki-ai-agent.davidduckwitz.de/`
- Testen Sie API: `https://ducki-ai-agent.davidduckwitz.de/api/health`

---

### Szenario 2: VPS/Dedicated Server (Empfohlen)

**Schritt 1: Server vorbereiten**
```bash
# SSH auf Server verbinden
ssh user@your-server

# Update system
sudo apt update && sudo apt upgrade -y

# Install Apache & PHP
sudo apt install -y apache2 php8.1 php8.1-fpm
sudo apt install -y certbot python3-certbot-apache

# Enable modules
sudo a2enmod rewrite
sudo a2enmod php8.1
sudo systemctl restart apache2
```

**Schritt 2: Verzeichnis erstellen**
```bash
sudo mkdir -p /var/www/ducki-landing
sudo chown -R www-data:www-data /var/www/ducki-landing
```

**Schritt 3: Dateien uploaden**
```bash
# Auf Ihrem lokalen Computer
scp -r landing/* user@your-server:/var/www/ducki-landing/
```

**Schritt 4: Apache konfigurieren**
```bash
sudo nano /etc/apache2/sites-available/ducki-agent.davidduckwitz.de.conf
```

Inhalt:
```apache
<VirtualHost *:80>
    ServerName ducki-ai-agent.davidduckwitz.de
    ServerAdmin admin@davidduckwitz.de
    DocumentRoot /var/www/ducki-landing

    <Directory /var/www/ducki-landing>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    # PHP-FPM
    <FilesMatch \.php$>
        SetHandler "proxy:unix:/run/php/php8.1-fpm.sock|fcgi://localhost"
    </FilesMatch>

    # Logging
    ErrorLog ${APACHE_LOG_DIR}/ducki-agent-error.log
    CustomLog ${APACHE_LOG_DIR}/ducki-agent-access.log combined

    # Rewrite Rules
    <IfModule mod_rewrite.c>
        RewriteEngine On
        RewriteCond %{REQUEST_FILENAME} !-f
        RewriteCond %{REQUEST_FILENAME} !-d
        RewriteRule ^api(.*)$ api/index.php [QSA,L]
    </IfModule>
</VirtualHost>
```

**Schritt 5: Site aktivieren & HTTPS**
```bash
sudo a2ensite ducki-agent.davidduckwitz.de.conf
sudo certbot --apache -d ducki-ai-agent.davidduckwitz.de
sudo systemctl restart apache2
```

---

### Szenario 3: Nginx (Moderne Alternative)

**Konfigurationsdatei:**
```nginx
upstream php {
    server unix:/run/php/php8.1-fpm.sock;
}

server {
    listen 80;
    listen [::]:80;
    server_name ducki-ai-agent.davidduckwitz.de;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ducki-ai-agent.davidduckwitz.de;

    root /var/www/ducki-landing;
    index index.html index.php;

    # SSL Certificates
    ssl_certificate /etc/letsencrypt/live/ducki-ai-agent.davidduckwitz.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ducki-ai-agent.davidduckwitz.de/privkey.pem;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;

    # Deny access to sensitive files
    location ~ /\. {
        deny all;
    }

    # Static files
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API routing
    location /api {
        try_files $uri $uri/ /api/index.php?$query_string;
    }

    # PHP processing
    location ~ \.php$ {
        try_files $uri =404;
        fastcgi_pass php;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }

    # Default to index.html for SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Logging
    access_log /var/log/nginx/ducki-agent-access.log;
    error_log /var/log/nginx/ducki-agent-error.log;
}
```

---

## Server-Konfiguration

### .htaccess (Apache)

Falls Sie die Nginx-Datei nicht verwenden können:

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /

    # Deny access to directories
    RewriteCond %{REQUEST_FILENAME} -d
    RewriteRule ^ - [L]

    # Deny access to files
    RewriteCond %{REQUEST_FILENAME} -f
    RewriteRule ^ - [L]

    # Route API requests
    RewriteCond %{REQUEST_URI} ^/api
    RewriteRule ^(.*)$ api/index.php [QSA,L]

    # Protect sensitive files
    RewriteRule "^\.git" - [F]
    RewriteRule "^\.env" - [F]
</IfModule>

<IfModule mod_headers.c>
    # Security Headers
    Header set X-Content-Type-Options "nosniff"
    Header set X-Frame-Options "DENY"
    Header set X-XSS-Protection "1; mode=block"
    Header set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
```

### Datei-Permissions

```bash
# Verzeichnisse
find /var/www/ducki-landing -type d -exec chmod 755 {} \;

# Dateien
find /var/www/ducki-landing -type f -exec chmod 644 {} \;

# API data directory (for write access if needed)
chmod 775 /var/www/ducki-landing/api/data
```

## Sicherheit

### SSL/TLS
```bash
# Let's Encrypt (kostenlos)
sudo certbot certonly --standalone -d ducki-ai-agent.davidduckwitz.de
sudo certbot renew --dry-run  # Test auto-renewal
```

### CORS Header (wenn nötig)
```php
// In api/config.php
header('Access-Control-Allow-Origin: https://www.davidduckwitz.de');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
```

### Firewall
```bash
# UFW (Ubuntu)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Monitoring
```bash
# Check site status
curl -I https://ducki-ai-agent.davidduckwitz.de/

# Check API
curl https://ducki-ai-agent.davidduckwitz.de/api/health

# Monitor logs
tail -f /var/log/apache2/ducki-agent-access.log
tail -f /var/log/apache2/ducki-agent-error.log
```

## Troubleshooting

### Problem: API Endpoints geben 404 zurück

**Lösung (Apache):**
```bash
# Prüfen Sie mod_rewrite
sudo a2enmod rewrite
sudo systemctl restart apache2

# .htaccess in Ordnung?
cat .htaccess

# Overrides aktiviert?
# AllowOverride All in VirtualHost config
```

**Lösung (Nginx):**
```bash
# Syntax testen
sudo nginx -t

# Neu laden
sudo systemctl reload nginx
```

### Problem: JSON-Dateien werden nicht gefunden

```bash
# Datei-Berechtigungen prüfen
ls -la api/data/

# Sollte sein: -rw-r--r-- (644)
chmod 644 api/data/*.json

# Dateien erstellen wenn leer
touch api/data/installations.json
echo '{"installations":[]}' > api/data/installations.json
```

### Problem: PHP wird nicht ausgeführt

```bash
# Prüfen Sie PHP-Installation
php -v

# Prüfen Sie PHP-Handler in Apache
# Muss sein: SetHandler application/x-httpd-php

# FPM Status
sudo systemctl status php8.1-fpm
```

### Problem: Hohe Ladezeiten

**Lösungen:**
1. Caching aktivieren
```apache
<IfModule mod_expires.c>
    ExpiresActive On
    ExpiresDefault "access plus 1 week"
    ExpiresByType text/html "access plus 1 day"
</IfModule>
```

2. Gzip aktivieren
```apache
<IfModule mod_deflate.c>
    AddOutputFilterByType DEFLATE text/html text/plain text/xml text/css text/javascript
</IfModule>
```

3. CDN für Assets verwenden (Tailwind bereits via CDN)

## Backup & Wartung

### Tägliches Backup
```bash
#!/bin/bash
# backup.sh
tar -czf /backups/ducki-landing-$(date +%Y%m%d).tar.gz /var/www/ducki-landing/
# Uploads nach S3, 30 Tage aufbewahren
```

### Updater Installation
```bash
# JSON-Dateien aus Repository aktualisieren
cd /var/www/ducki-landing
git pull origin main

# Permissions reset
sudo chown -R www-data:www-data /var/www/ducki-landing
```

## Performance-Optimierung

### Caching-Strategie
- HTML: Cache 1 Tag
- API JSON: Cache 1 Stunde
- Assets (CSS/JS): Cache 1 Jahr
- JSON data files: Keine Cache (immer frisch)

### Empfohlene Plugins/Tools
- **Apache:** mod_pagespeed, mod_cache
- **Nginx:** ngx_http_gzip_module, ngx_http_cache
- **Monitor:** NewRelic, Datadog, oder lokales Monitoring

## Support

- 📧 **Email:** davidduckwitz@googlemail.com
- 🐛 **Issues:** https://github.com/davidduckwitz/ducKI-Agent/issues
- 💡 **Suggestions:** https://github.com/davidduckwitz/ducKI-Agent/discussions

## Lizenz

MIT - Frei verwendbar und modifizierbar
