<?php
/**
 * SyncController - Sync actual skills from the repo `skills/` dir into skills.json,
 * generate per-skill tar.gz bundles, and record agentskills.io-spec metadata.
 *
 * This is the distribution source for the ducki skill catalog: the Node server
 * imports skills by downloading the bundles produced here.
 *
 * NOTE (deployment): building bundles uses PharData and therefore needs the
 * `phar` extension with `phar.readonly=0`. If bundling is unavailable the sync
 * still succeeds; skills fall back to inline `content` (single-file only).
 */

class SyncController {
    private $api_dir;        // .../landing/api
    private $sources;        // [ ['dir' => path, 'origin' => 'agent'|'community'], ... ]
    private $tools_file;
    private $skills_file;
    private $bundles_dir;    // .../landing/api/data/bundles
    private $public_base;    // public URL of v1.php

    public function __construct($base_path = null) {
        // Derive paths from this file's location so they are stable regardless
        // of how the controller is instantiated:
        //   __FILE__ = .../landing/api/controllers/SyncController.php
        $this->api_dir = dirname(__DIR__);                       // .../landing/api
        $landing_dir = dirname($this->api_dir);                  // .../landing
        $community_skills = $landing_dir . '/catalog-skills';    // catalog-only skills

        // The catalog is generated in the DEV environment, where the agent's own
        // skills live at repo-root/skills (sibling of landing). It is then deployed
        // as static skills.json + bundles. The agent only ever *reads* the catalog
        // API and installs into its own skills folder — it is never sourced from a
        // skills copy inside landing. `base_path` allows an explicit test override.
        $agent_skills = ($base_path && is_dir($base_path . '/skills'))
            ? $base_path . '/skills'
            : dirname($landing_dir) . '/skills';

        // Catalog sources: the agent's live skills PLUS catalog-only community
        // skills that are installable but not active in the agent until imported.
        $this->sources = [
            ['dir' => $agent_skills, 'origin' => 'agent'],
            ['dir' => $community_skills, 'origin' => 'community'],
        ];

        $this->tools_file = $this->api_dir . '/data/tools.json';
        $this->skills_file = $this->api_dir . '/data/skills.json';
        $this->bundles_dir = $this->api_dir . '/data/bundles';
        $this->public_base = getenv('DUCKI_PUBLIC_API')
            ?: 'https://ducki-ai-agent.davidduckwitz.de/api/v1.php';
    }

    /**
     * Parse SKILL.md YAML-style frontmatter robustly.
     * Handles a leading BOM, CRLF line endings, quoted scalars, inline arrays
     * ([a, b]) and a one-level `metadata:` map.
     */
    public function parseFrontmatter($content) {
        $result = ['metadata' => []];
        // Strip UTF-8 BOM and normalize newlines.
        $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
        $content = str_replace(["\r\n", "\r"], "\n", $content);

        if (strpos($content, '---') !== 0) return $result;
        $end = strpos($content, "\n---", 3);
        if ($end === false) return $result;

        $block = substr($content, 4, $end - 4);
        $lines = explode("\n", $block);
        $in_metadata = false;

        foreach ($lines as $line) {
            if (trim($line) === '' || strpos(trim($line), '#') === 0) continue;

            $indented = preg_match('/^\s+/', $line) === 1;
            if ($in_metadata && $indented) {
                $trim = trim($line);
                $ci = strpos($trim, ':');
                if ($ci !== false) {
                    $k = trim(substr($trim, 0, $ci));
                    $v = $this->unquote(trim(substr($trim, $ci + 1)));
                    $result['metadata'][$k] = $v;
                }
                continue;
            }
            if (!$indented) $in_metadata = false;

            $ci = strpos($line, ':');
            if ($ci === false) continue;
            $key = trim(substr($line, 0, $ci));
            $val = trim(substr($line, $ci + 1));

            if ($key === 'metadata' && $val === '') { $in_metadata = true; continue; }

            if ($val === '') continue;
            if (strlen($val) >= 2 && $val[0] === '[' && substr($val, -1) === ']') {
                $inner = trim(substr($val, 1, -1));
                $arr = $inner === '' ? [] : array_map(function ($x) { return $this->unquote(trim($x)); }, explode(',', $inner));
                $result[$key] = $arr;
            } else {
                $result[$key] = $this->unquote($val);
            }
        }
        return $result;
    }

    private function unquote($v) {
        $v = trim($v);
        if (strlen($v) >= 2) {
            $f = $v[0]; $l = $v[strlen($v) - 1];
            if (($f === '"' && $l === '"') || ($f === "'" && $l === "'")) {
                return substr($v, 1, -1);
            }
        }
        return $v;
    }

    /** Read a field from top-level or metadata (top-level wins). */
    private function pick($fm, $key) {
        if (isset($fm[$key]) && $fm[$key] !== '') return $fm[$key];
        if (isset($fm['metadata'][$key]) && $fm['metadata'][$key] !== '') return $fm['metadata'][$key];
        return null;
    }

    private function toArray($v) {
        if (is_array($v)) return array_values(array_filter(array_map('trim', $v)));
        if (is_string($v) && trim($v) !== '') return array_values(array_filter(array_map('trim', explode(',', $v))));
        return [];
    }

    /** agentskills.io name/description validation. */
    private function isSpecCompliant($id, $name, $description) {
        if (!$name || !$description) return false;
        if (strlen($name) > 64 || strlen($description) > 1024) return false;
        if (!preg_match('/^[a-z0-9]+(-[a-z0-9]+)*$/', $name)) return false;
        if ($name !== $id) return false;
        return true;
    }

    /**
     * Build a tar.gz bundle for one skill. Returns [source_url, checksum] or null.
     */
    private function buildBundle($skill_dir, $id) {
        if (!class_exists('PharData')) return null;
        if (!is_dir($this->bundles_dir)) {
            @mkdir($this->bundles_dir, 0755, true);
        }
        $tar = $this->bundles_dir . '/' . $id . '.tar';
        $gz = $tar . '.gz';
        @unlink($tar);
        @unlink($gz);
        try {
            $phar = new PharData($tar);
            // Whitelist: SKILL.md, script.js, LICENSE/README, and scripts|references|assets subtrees.
            $pattern = '#(SKILL\.md|script\.js|LICENSE(\.txt)?|README\.md|[\\\\/](scripts|references|assets)[\\\\/])#';
            $phar->buildFromDirectory($skill_dir, $pattern);
            $phar->compress(Phar::GZ);
            unset($phar);
            @unlink($tar); // keep only the .gz
            if (!file_exists($gz)) return null;
            $checksum = 'sha256:' . hash_file('sha256', $gz);
            $source_url = $this->public_base . '?action=download&id=' . rawurlencode($id);
            return [$source_url, $checksum];
        } catch (Exception $e) {
            @unlink($tar);
            return null;
        }
    }

    /** Scan all catalog sources and generate the catalog records. */
    public function syncSkillsFromFileSystem() {
        $skills = [];
        $seen = [];
        $agent_dir = $this->sources[0]['dir'] ?? null;
        if (!$agent_dir || !is_dir($agent_dir)) {
            return ['error' => 'Skills directory not found', 'path' => $agent_dir];
        }

        foreach ($this->sources as $src) {
            $skills_dir = $src['dir'];
            $origin = $src['origin'];
            if (!is_dir($skills_dir)) continue;
            $skill_dirs = array_diff(scandir($skills_dir), ['.', '..']);

            foreach ($skill_dirs as $id) {
            $skill_path = $skills_dir . '/' . $id;
            if (!is_dir($skill_path)) continue;
            $skill_file = $skill_path . '/SKILL.md';
            if (!file_exists($skill_file)) continue;
            if (isset($seen[$id])) continue; // agent source wins on id collision
            $seen[$id] = true;

            $content = file_get_contents($skill_file);
            $fm = $this->parseFrontmatter($content);

            $name = $this->pick($fm, 'name') ?: $id;
            $description = $this->pick($fm, 'description') ?: ('Agent skill for ' . $id);
            $spec_compliant = $this->isSpecCompliant($id, $this->pick($fm, 'name'), $this->pick($fm, 'description'));

            $has_scripts = is_dir($skill_path . '/scripts') || file_exists($skill_path . '/script.js');

            $bundle = $this->buildBundle($skill_path, $id);
            $source_url = $bundle ? $bundle[0] : null;
            $checksum = $bundle ? $bundle[1] : null;

            $record = [
                'id' => $id,
                'name' => $name,
                'description' => $description,
                'category' => $this->pick($fm, 'category') ?: $this->guessCategory($id),
                'tags' => $this->toArray($this->pick($fm, 'tags')),
                'version' => $this->pick($fm, 'version'),
                'license' => $this->pick($fm, 'license'),
                'compatibility' => $this->pick($fm, 'compatibility'),
                'dependencies' => $this->toArray($this->pick($fm, 'dependencies')),
                'spec_compliant' => $spec_compliant,
                'has_scripts' => $has_scripts,
                'origin' => $origin,
                'source_url' => $source_url,
                'checksum' => $checksum,
                'status' => 'active',
                'lines' => count(file($skill_file)),
                'updated' => date('c', filemtime($skill_file)),
            ];
            // Inline content fallback for single-file skills when no bundle exists.
            if (!$source_url && !$has_scripts) {
                $record['content'] = $content;
            }

            $skills[] = $record;
            }
        }

        usort($skills, fn($a, $b) => strcmp($a['name'], $b['name']));

        return ['success' => true, 'count' => count($skills), 'skills' => $skills];
    }

    /** Guess category from id (fallback when frontmatter has none). */
    private function guessCategory($slug) {
        $categories = [
            'btc' => 'Blockchain', 'crypto' => 'Blockchain', 'puzzle' => 'Crypto',
            'git' => 'Development', 'filesystem' => 'Development', 'shell' => 'Development',
            'code' => 'Development', 'test' => 'Development', 'browser' => 'Automation',
            'http' => 'Integration', 'discord' => 'Integration', 'workflow' => 'Orchestration',
            'task' => 'Orchestration', 'cronjob' => 'Orchestration', 'plan' => 'AI',
            'memory' => 'AI', 'mcp' => 'Integration',
        ];
        foreach ($categories as $key => $cat) {
            if (strpos($slug, $key) !== false) return $cat;
        }
        return 'Utility';
    }

    /** Save skills to JSON. */
    public function saveSkills($skills) {
        $data = ['skills' => $skills];
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if (!is_dir(dirname($this->skills_file))) {
            mkdir(dirname($this->skills_file), 0755, true);
        }
        return file_put_contents($this->skills_file, $json) !== false;
    }

    /** Full sync: update skills from filesystem. */
    public function fullSync() {
        $skills_result = $this->syncSkillsFromFileSystem();
        if (isset($skills_result['error'])) {
            return ['error' => 'Skills sync failed: ' . $skills_result['error']];
        }
        $this->saveSkills($skills_result['skills']);

        $bundled = count(array_filter($skills_result['skills'], fn($s) => !empty($s['source_url'])));
        $compliant = count(array_filter($skills_result['skills'], fn($s) => !empty($s['spec_compliant'])));

        return [
            'success' => true,
            'skills_synced' => count($skills_result['skills']),
            'bundled' => $bundled,
            'spec_compliant' => $compliant,
            'bundling_available' => class_exists('PharData'),
            'timestamp' => date('c'),
        ];
    }
}
?>
