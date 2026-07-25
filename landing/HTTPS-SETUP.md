# 🔒 HTTPS Setup für ducki-ai-agent.davidduckwitz.de

Anleitung zur Konfiguration von HTTPS mit automatischer HTTP-Umleitung.

## 🚀 Quick Setup (10 Minuten)

### Option 1: Apache + Let's Encrypt (Empfohlen)

```bash
# 1. SSH auf Server
ssh user@your-server

# 2. Let's Encrypt installieren
sudo apt update
sudo apt install -y certbot python3-certbot-apache

# 3. Zertifikat generieren (Apache plugin)
sudo certbot --apache -d ducki-ai-agent.davidduckwitz.de

# 4. Follow the prompts:
# - Email eingeben
# - Terms akzeptieren
# - Redirect: "2" (redirect HTTP to HTTPS)

# 5. Auto-renewal aktivieren
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# 6. Testen
curl -I https://ducki-ai-agent.davidduckwitz.de/
```

### Option 2: Nginx + Let's Encrypt

```bash
# 1. SSH auf Server
ssh user@your-server

# 2. Nginx & Certbot installieren
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

# 3. Zertifikat generieren (Nginx plugin)
sudo certbot --nginx -d ducki-ai-agent.davidduckwitz.de

# 4. Follow the prompts:
# - Email eingeben
# - Terms akzeptieren
# - Redirect: "2" (redirect HTTP to HTTPS)

# 5. Auto-renewal aktivieren
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# 6. Testen
curl -I https://ducki-ai-agent.davidduckwitz.de/
```

### Option 3: Manuelles Nginx Setup

```bash
# 1. SSH auf Server
ssh user@your-server

# 2. Nginx & Certbot installieren
sudo apt update
sudo apt install -y nginx certbot

# 3. Temporäre HTTP-Config für Let's Encrypt
sudo mkdir -p /var/www/certbot

# 4. Zertifikat generieren (Webroot method)
sudo certbot certonly --webroot -w /var/www/certbot \
  -d ducki-ai-agent.davidduckwitz.de

# 5. Nginx Config kopieren
sudo cp nginx-https.conf /etc/nginx/sites-available/ducki-agent.conf

# 6. Site aktivieren
sudo ln -s /etc/nginx/sites-available/ducki-agent.conf \
  /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# 7. Nginx testen & laden
sudo nginx -t
sudo systemctl reload nginx

# 8. Auto-renewal aktivieren
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer

# 9. Testen
curl -I https://ducki-ai-agent.davidduckwitz.de/
```

---

## ✅ Verification

Nach dem Setup diese Punkt prüfen:

```bash
# 1. HTTPS Redirect funktioniert
curl -I http://ducki-ai-agent.davidduckwitz.de/
# Sollte zeigen: HTTP/1.1 301 Moved Permanently
# Location: https://ducki-ai-agent.davidduckwitz.de/

# 2. HTTPS funktioniert
curl -I https://ducki-ai-agent.davidduckwitz.de/
# Sollte zeigen: HTTP/2 200

# 3. API funktioniert
curl https://ducki-ai-agent.davidduckwitz.de/api/health
# Sollte zeigen: {"success":true,...}

# 4. HSTS Header vorhanden
curl -I https://ducki-ai-agent.davidduckwitz.de/ | grep Strict-Transport
# Sollte zeigen: Strict-Transport-Security: max-age=31536000

# 5. Security Headers vorhanden
curl -I https://ducki-ai-agent.davidduckwitz.de/ | grep -E "X-Frame|X-Content-Type|X-XSS"
```

---

## 🔐 SSL Certificate Check

```bash
# Zertifikat-Details anzeigen
sudo certbot certificates

# Zertifikat expiry prüfen
sudo certbot renew --dry-run

# Erneuerungsstatus anschauen
sudo systemctl status certbot.timer
sudo journalctl -u certbot.timer -n 20
```

---

## 🛠️ Troubleshooting

### Problem: "connection refused" auf HTTPS

```bash
# 1. Port 443 offen?
sudo ufw status
sudo ufw allow 443/tcp

# 2. Nginx läuft?
sudo systemctl status nginx
sudo systemctl restart nginx

# 3. Nginx Config prüfen
sudo nginx -t
```

### Problem: "certificate verify failed"

```bash
# Zertifikat neu generieren
sudo certbot renew --force-renewal

# Oder komplett neu
sudo certbot delete --cert-name ducki-ai-agent.davidduckwitz.de
sudo certbot certonly --webroot -w /var/www/certbot \
  -d ducki-ai-agent.davidduckwitz.de
```

### Problem: "too many redirects"

```bash
# Apache: .htaccess prüfen
cat /var/www/ducki-landing/.htaccess | grep "RewriteCond %{HTTPS}"

# Nginx: nginx.conf prüfen
cat /etc/nginx/sites-enabled/ducki-agent.conf | grep "return 301"

# Falls beide aktiviert: einen deaktivieren!
```

### Problem: API gibt 502 Bad Gateway

```bash
# 1. PHP-FPM läuft?
sudo systemctl status php8.1-fpm
sudo systemctl restart php8.1-fpm

# 2. Socket-Verbindung prüfen
ls -l /run/php/php8.1-fpm.sock

# 3. Logs prüfen
tail -50 /var/log/nginx/error.log
```

---

## 📋 Regelmäßige Wartung

### Täglich (automatisch)
- Zertifikat Auto-Renewal läuft täglich
- Let's Encrypt prüft ~60 Tage vor Ablauf

### Wöchentlich
```bash
# SSL Status prüfen
sudo certbot certificates

# API HTTPS Test
curl -I https://ducki-ai-agent.davidduckwitz.de/api/health
```

### Monatlich
```bash
# Zertifikat Details
openssl s_client -connect ducki-ai-agent.davidduckwitz.de:443 -servername ducki-ai-agent.davidduckwitz.de

# Ablaufdatum
openssl s_client -connect ducki-ai-agent.davidduckwitz.de:443 -servername ducki-ai-agent.davidduckwitz.de | openssl x509 -noout -dates
```

---

## 🔑 Zertifikat Renewal

### Automatisch (empfohlen)
```bash
# Status prüfen
sudo systemctl status certbot.timer
sudo systemctl enable certbot.timer

# Logs
sudo journalctl -u certbot -n 50
```

### Manuell
```bash
# Dry-run (Test, keine Änderung)
sudo certbot renew --dry-run

# Tatsächliche Erneuerung
sudo certbot renew

# Mit Force (bei Problemen)
sudo certbot renew --force-renewal
```

---

## 📊 SSL/TLS Test

### Online Tools
- https://www.ssllabs.com/ssltest/ - Vollständiger SSL-Test
- https://cipherli.st/ - Cipher-Suiten testen

### Lokal
```bash
# openssl Test
openssl s_client -connect ducki-ai-agent.davidduckwitz.de:443 -servername ducki-ai-agent.davidduckwitz.de

# curl Test
curl -v https://ducki-ai-agent.davidduckwitz.de/

# Nmap Test
nmap -p 443 --script ssl-enum-ciphers ducki-ai-agent.davidduckwitz.de
```

---

## 🚨 Emergency: Zertifikat abgelaufen

Falls Zertifikat abgelaufen ist:

```bash
# 1. Sofort erneuern
sudo certbot renew --force-renewal

# 2. Nginx/Apache neu laden
sudo systemctl reload nginx
# oder
sudo systemctl reload apache2

# 3. Verify
curl -I https://ducki-ai-agent.davidduckwitz.de/

# 4. If still fails, restart services
sudo systemctl restart nginx
# oder
sudo systemctl restart apache2
```

---

## 📌 Wichtige Dateien

### Let's Encrypt
```
/etc/letsencrypt/live/ducki-ai-agent.davidduckwitz.de/
├── cert.pem        # Zertifikat
├── chain.pem       # Chain
├── fullchain.pem   # Vollständige Kette
└── privkey.pem     # Private Key
```

### Nginx Config
```
/etc/nginx/sites-available/ducki-agent.conf
/etc/nginx/sites-enabled/ducki-agent.conf (symlink)
```

### Apache Config
```
/var/www/ducki-landing/.htaccess
/etc/apache2/sites-available/ducki-agent.conf
/etc/apache2/sites-enabled/ducki-agent.conf
```

---

## 🎯 Final Checklist

- [ ] Zertifikat generiert
- [ ] HTTP → HTTPS Redirect funktioniert
- [ ] HTTPS funktioniert (curl/Browser)
- [ ] API antwortet (https://domain/api/health)
- [ ] Security Headers vorhanden
- [ ] HSTS aktiviert
- [ ] Auto-renewal konfiguriert
- [ ] Logs überwachen

---

## 📞 Support

Falls Probleme:

1. **Logs prüfen:**
   ```bash
   sudo journalctl -u certbot -n 50
   tail -50 /var/log/nginx/error.log
   tail -50 /var/log/apache2/error.log
   ```

2. **Let's Encrypt Docs:** https://certbot.eff.org/

3. **Nginx Docs:** https://nginx.org/

4. **Apache Docs:** https://httpd.apache.org/

---

**Zertifikat aktuell und sicher? Dann herzlichen Glückwunsch! 🎉**
