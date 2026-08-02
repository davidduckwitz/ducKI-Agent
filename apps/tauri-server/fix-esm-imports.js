#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = (msg) => console.log(`[ESM-Fix] ${msg}`);

// Fix ESM imports in bundled node_modules to include .js extensions
function fixEsmImports(dirPath, maxDepth = 15, currentDepth = 0) {
  if (currentDepth > maxDepth) return;

  try {
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      // Skip common non-code directories
      if (['.bin', '.package-lock.json', 'package-lock.json'].includes(file)) continue;

      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        fixEsmImports(fullPath, maxDepth, currentDepth + 1);
      } else if (file.endsWith('.js')) {
        try {
          let content = fs.readFileSync(fullPath, 'utf8');
          const originalContent = content;

          // Fix relative ESM imports like: import X from "./path"
          // to: import X from "./path.js" (if not already .js or .json)
          content = content.replace(
            /from\s+["'](\.[^"']*?)["']/g,
            (match, importPath) => {
              // Skip if already has extension
              if (importPath.endsWith('.js') || importPath.endsWith('.json') ||
                  importPath.includes('?') || importPath.startsWith('http')) {
                return match;
              }
              // Add .js extension
              return `from "${importPath}.js"`;
            }
          );

          // Also fix import statements
          content = content.replace(
            /import\s+["'](\.[^"']*?)["']/g,
            (match, importPath) => {
              if (importPath.endsWith('.js') || importPath.endsWith('.json') ||
                  importPath.includes('?') || importPath.startsWith('http')) {
                return match;
              }
              return `import "${importPath}.js"`;
            }
          );

          if (content !== originalContent) {
            fs.writeFileSync(fullPath, content);
            log(`✓ Fixed: ${path.relative(__dirname, fullPath)}`);
          }
        } catch (err) {
          // Silently skip files that can't be processed
        }
      }
    }
  } catch (err) {
    // Silently skip directories that can't be read
  }
}

// Main
const resourcesDir = path.join(__dirname, 'src-tauri/resources/node_modules');

if (!fs.existsSync(resourcesDir)) {
  log('⚠ Resources directory not found, skipping ESM import fixes');
  process.exit(0);
}

log('Starting ESM import fixes for bundled node_modules...');
log(`Target: ${resourcesDir}`);

fixEsmImports(resourcesDir);

log('✅ ESM import fixes complete');
