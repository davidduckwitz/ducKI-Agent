<?php
/**
 * SyncController - Sync actual tools and skills from Node.js backend to landing page
 */

class SyncController {
    private $base_path;
    private $tools_file;
    private $skills_file;

    public function __construct($base_path = null) {
        $this->base_path = $base_path ?? dirname(dirname(__DIR__));
        $this->tools_file = $this->base_path . '/api/data/tools.json';
        $this->skills_file = $this->base_path . '/api/data/skills.json';
    }

    /**
     * Scan file system for skills and generate JSON
     */
    public function syncSkillsFromFileSystem() {
        $skills_dir = dirname($this->base_path) . '/skills';
        if (!is_dir($skills_dir)) {
            return ['error' => 'Skills directory not found', 'path' => $skills_dir];
        }

        $skills = [];
        $skill_dirs = array_diff(scandir($skills_dir), ['.', '..']);

        foreach ($skill_dirs as $slug) {
            $skill_path = $skills_dir . '/' . $slug;
            if (!is_dir($skill_path)) continue;

            $skill_file = $skill_path . '/SKILL.md';
            if (!file_exists($skill_file)) continue;

            $content = file_get_contents($skill_file);
            $name = $slug;
            $description = '';

            if (preg_match('/^---\s*\n(.*?)\n---/s', $content, $matches)) {
                $frontmatter = $matches[1];
                if (preg_match('/name:\s*(.+)/i', $frontmatter, $m)) {
                    $name = trim($m[1], '\'"');
                }
                if (preg_match('/description:\s*(.+)/i', $frontmatter, $m)) {
                    $description = trim($m[1], '\'"');
                }
            }

            $skills[] = [
                'id' => $slug,
                'name' => $name,
                'description' => $description ?: 'Agent skill for ' . $name,
                'category' => $this->guessCategory($slug),
                'status' => 'active',
                'lines' => count(file($skill_file)),
                'updated' => date('c', filemtime($skill_file))
            ];
        }

        usort($skills, fn($a, $b) => strcmp($a['name'], $b['name']));

        return [
            'success' => true,
            'count' => count($skills),
            'skills' => $skills
        ];
    }

    /**
     * Guess category from slug
     */
    private function guessCategory($slug) {
        $categories = [
            'btc' => 'Blockchain',
            'crypto' => 'Blockchain',
            'puzzle' => 'Crypto',
            'git' => 'Development',
            'filesystem' => 'Development',
            'shell' => 'Development',
            'code' => 'Development',
            'test' => 'Development',
            'browser' => 'Automation',
            'http' => 'Integration',
            'discord' => 'Integration',
            'workflow' => 'Orchestration',
            'task' => 'Orchestration',
            'cronjob' => 'Orchestration',
            'plan' => 'AI',
            'memory' => 'AI',
            'mcp' => 'Integration'
        ];

        foreach ($categories as $key => $cat) {
            if (strpos($slug, $key) !== false) {
                return $cat;
            }
        }

        return 'Utility';
    }

    /**
     * Save skills to JSON
     */
    public function saveSkills($skills) {
        $data = ['skills' => $skills];
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

        if (!is_dir(dirname($this->skills_file))) {
            mkdir(dirname($this->skills_file), 0755, true);
        }

        return file_put_contents($this->skills_file, $json) !== false;
    }

    /**
     * Full sync: update skills from filesystem
     */
    public function fullSync() {
        $skills_result = $this->syncSkillsFromFileSystem();
        if (isset($skills_result['error'])) {
            return ['error' => 'Skills sync failed: ' . $skills_result['error']];
        }

        $this->saveSkills($skills_result['skills']);

        return [
            'success' => true,
            'skills_synced' => count($skills_result['skills']),
            'timestamp' => date('c')
        ];
    }
}
?>
