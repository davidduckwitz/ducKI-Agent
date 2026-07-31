# .htaccess Configuration Guide

## Problem Diagnosis

**Error:** `https://ducki-ai-agent.davidduckwitz.de/api/` returns error

**Likely Cause:** `.htaccess` RewriteBase doesn't match your actual deployment path

---

## Solution: Fix RewriteBase

### Check Your Deployment Path First

```bash
# If your site loads at:
https://ducki-ai-agent.davidduckwitz.de/          → ROOT deployment
https://ducki-ai-agent.davidduckwitz.de/landing/  → /landing subpath
```

---

## Option 1: Root Deployment

**If landing page is at domain root: `https://ducki-ai-agent.davidduckwitz.de/`**

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /

    # Block hidden files
    <FilesMatch "^\." >
        Order allow,deny
        Deny from all
    </FilesMatch>

    # Pass through existing files/directories
    RewriteCond %{REQUEST_FILENAME} -f [OR]
    RewriteCond %{REQUEST_FILENAME} -d
    RewriteRule ^ - [L]

    # Allow all .html files
    RewriteRule ^.*\.html$ - [L]

    # API routing: /api/* -> api/v1.php
    RewriteCond %{REQUEST_URI} ^/api/
    RewriteRule ^api/(.*)$ api/v1.php [QSA,L]

    # Fallback to index.html
    RewriteCond %{REQUEST_URI} !\.php$
    RewriteCond %{REQUEST_URI} !\.html$
    RewriteCond %{REQUEST_URI} !/api/
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^ index.html [QSA,L]
</IfModule>
```

**Expected URLs:**
- `https://ducki-ai-agent.davidduckwitz.de/api/v1.php?action=skills` ✓
- `https://ducki-ai-agent.davidduckwitz.de/skills.html` ✓

---

## Option 2: /landing Subpath Deployment

**If landing page is at: `https://ducki-ai-agent.davidduckwitz.de/landing/`**

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteBase /landing/

    # Block hidden files
    <FilesMatch "^\." >
        Order allow,deny
        Deny from all
    </FilesMatch>

    # Pass through existing files/directories
    RewriteCond %{REQUEST_FILENAME} -f [OR]
    RewriteCond %{REQUEST_FILENAME} -d
    RewriteRule ^ - [L]

    # Allow all .html files
    RewriteRule ^.*\.html$ - [L]

    # API routing: /api/* -> api/v1.php
    RewriteCond %{REQUEST_URI} ^/landing/api/
    RewriteRule ^api/(.*)$ api/v1.php [QSA,L]

    # Fallback to index.html
    RewriteCond %{REQUEST_URI} !\.php$
    RewriteCond %{REQUEST_URI} !\.html$
    RewriteCond %{REQUEST_URI} !/api/
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^ index.html [QSA,L]
</IfModule>
```

**Expected URLs:**
- `https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php?action=skills` ✓
- `https://ducki-ai-agent.davidduckwitz.de/landing/skills.html` ✓

---

## How to Update

### 1. Determine Your Deployment Path

```bash
# SSH into your server
ssh user@ducki-ai-agent.davidduckwitz.de

# Check where landing page files are
ls /var/www/html/
# If you see 'landing/' directory → use Option 2
# If you see 'api/', 'skills.html' directly → use Option 1
```

### 2. Update .htaccess

```bash
# Edit the file
nano /var/www/html/landing/.htaccess
# OR
nano /var/www/html/.htaccess

# Find the line: RewriteBase /
# Change to appropriate path based on your deployment
```

### 3. Test the API

```bash
# Root deployment
curl https://ducki-ai-agent.davidduckwitz.de/api/v1.php?action=health

# /landing deployment
curl https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php?action=health
```

---

## Quick Fix

**Most common issue:** RewriteBase is `/` but landing page is deployed to `/landing/`

**Quick fix:**
```bash
# SSH to server
ssh user@ducki-ai-agent.davidduckwitz.de

# Update RewriteBase
sed -i 's|RewriteBase /|RewriteBase /landing/|' /var/www/html/landing/.htaccess

# Test
curl https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php?action=health
```

---

## Verify After Fix

### Test 1: API Health
```bash
curl https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php?action=health
# Should return: {"success":true,"timestamp":"...","data":{"status":"healthy",...}}
```

### Test 2: Skills List
```bash
curl https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php?action=skills
# Should return: array of 29 skills
```

### Test 3: Browser
```
Navigate to: https://ducki-ai-agent.davidduckwitz.de/landing/skills.html
Should display: 29 skills with search/filter
```

---

## Troubleshooting

### Still getting 404 on /api/

1. **Check mod_rewrite is enabled:**
   ```bash
   apache2ctl -M | grep rewrite
   # Should show: rewrite_module
   ```

2. **Check .htaccess is being read:**
   ```bash
   # Add this to .htaccess temporarily to test
   Header set X-htaccess-loaded "yes"
   
   # Then check response headers
   curl -I https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php
   # Should show: X-htaccess-loaded: yes
   ```

3. **Check PHP is working:**
   ```bash
   curl https://ducki-ai-agent.davidduckwitz.de/landing/api/v1.php
   # Should return JSON, not error page
   ```

### CSS/Images not loading

- Check if assets/ directory exists
- Verify image paths in HTML (may need /landing/ prefix)
- Test: `curl https://ducki-ai-agent.davidduckwitz.de/landing/assets/`

---

## Summary

| Check | Status |
|-------|--------|
| RewriteBase matches deployment path | ❌ FIX THIS |
| mod_rewrite enabled | ✓ Usually yes |
| .htaccess permissions | ✓ Usually 644 |
| api/v1.php exists | ✓ Should be there |
| api/data/ readable | ✓ Should be there |

---

**Next Step:** Run the curl commands above to verify the fix works.
