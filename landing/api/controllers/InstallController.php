<?php
/**
 * Installation Controller für Tools & Skills
 */

class InstallController {
    private $tools_file;
    private $skills_file;
    private $installations_file;

    public function __construct() {
        $this->tools_file = __DIR__ . '/../data/tools.json';
        $this->skills_file = __DIR__ . '/../data/skills.json';
        $this->installations_file = __DIR__ . '/../data/installations.json';
    }

    /**
     * Install a Tool
     */
    public function installTool($tool_id) {
        try {
            // Validate tool exists
            $tools_data = json_decode(file_get_contents($this->tools_file), true);
            $tool = null;
            foreach ($tools_data['tools'] as $t) {
                if ($t['id'] === $tool_id) {
                    $tool = $t;
                    break;
                }
            }

            if (!$tool) {
                return [
                    'success' => false,
                    'error' => 'Tool not found',
                    'code' => 'TOOL_NOT_FOUND'
                ];
            }

            // Create installation record
            $installation = [
                'id' => 'tool-' . $tool_id . '-' . time(),
                'type' => 'tool',
                'item_id' => $tool_id,
                'item_name' => $tool['name'],
                'version' => $tool['version'],
                'status' => 'installed',
                'installed_at' => date('c'),
                'source' => $tool['repository'],
                'auto_install' => true
            ];

            $this->recordInstallation($installation);

            return [
                'success' => true,
                'message' => 'Tool erfolgreich installiert',
                'data' => [
                    'tool_id' => $tool_id,
                    'tool_name' => $tool['name'],
                    'version' => $tool['version'],
                    'installation_id' => $installation['id'],
                    'installed_at' => $installation['installed_at']
                ]
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'code' => 'INSTALL_ERROR'
            ];
        }
    }

    /**
     * Install a Skill
     */
    public function installSkill($skill_id) {
        try {
            // Validate skill exists
            $skills_data = json_decode(file_get_contents($this->skills_file), true);
            $skill = null;
            foreach ($skills_data['skills'] as $s) {
                if ($s['id'] === $skill_id) {
                    $skill = $s;
                    break;
                }
            }

            if (!$skill) {
                return [
                    'success' => false,
                    'error' => 'Skill nicht gefunden',
                    'code' => 'SKILL_NOT_FOUND'
                ];
            }

            // Create installation record
            $installation = [
                'id' => 'skill-' . $skill_id . '-' . time(),
                'type' => 'skill',
                'item_id' => $skill_id,
                'item_name' => $skill['name'],
                'version' => $skill['version'],
                'status' => 'installed',
                'installed_at' => date('c'),
                'source' => $skill['repository'],
                'dependencies' => $skill['dependencies'] ?? [],
                'auto_install' => true
            ];

            $this->recordInstallation($installation);

            return [
                'success' => true,
                'message' => 'Skill erfolgreich installiert',
                'data' => [
                    'skill_id' => $skill_id,
                    'skill_name' => $skill['name'],
                    'version' => $skill['version'],
                    'dependencies' => $skill['dependencies'] ?? [],
                    'installation_id' => $installation['id'],
                    'installed_at' => $installation['installed_at']
                ]
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'code' => 'INSTALL_ERROR'
            ];
        }
    }

    /**
     * Get installation history
     */
    public function getInstallations($type = null, $limit = 50) {
        try {
            if (!file_exists($this->installations_file)) {
                return [
                    'success' => true,
                    'data' => [
                        'installations' => [],
                        'total' => 0
                    ]
                ];
            }

            $data = json_decode(file_get_contents($this->installations_file), true);
            $installations = $data['installations'] ?? [];

            // Filter by type if provided
            if ($type) {
                $installations = array_filter($installations, function($inst) use ($type) {
                    return $inst['type'] === $type;
                });
            }

            // Sort by date descending
            usort($installations, function($a, $b) {
                return strtotime($b['installed_at']) - strtotime($a['installed_at']);
            });

            // Limit results
            $installations = array_slice($installations, 0, $limit);

            return [
                'success' => true,
                'data' => [
                    'installations' => $installations,
                    'total' => count($installations)
                ]
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'code' => 'LOAD_ERROR'
            ];
        }
    }

    /**
     * Uninstall Tool or Skill
     */
    public function uninstall($installation_id) {
        try {
            if (!file_exists($this->installations_file)) {
                return [
                    'success' => false,
                    'error' => 'Installation not found',
                    'code' => 'NOT_FOUND'
                ];
            }

            $data = json_decode(file_get_contents($this->installations_file), true);
            $installations = $data['installations'] ?? [];

            // Find and remove installation
            $found = false;
            foreach ($installations as $key => $inst) {
                if ($inst['id'] === $installation_id) {
                    $removed = array_splice($installations, $key, 1);
                    $found = true;

                    // Save updated file
                    file_put_contents(
                        $this->installations_file,
                        json_encode(['installations' => $installations], JSON_PRETTY_PRINT)
                    );
                    break;
                }
            }

            if (!$found) {
                return [
                    'success' => false,
                    'error' => 'Installation nicht gefunden',
                    'code' => 'NOT_FOUND'
                ];
            }

            return [
                'success' => true,
                'message' => 'Installation erfolgreich entfernt'
            ];
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'code' => 'UNINSTALL_ERROR'
            ];
        }
    }

    /**
     * Record installation in history
     */
    private function recordInstallation($installation) {
        $data = [];
        if (file_exists($this->installations_file)) {
            $data = json_decode(file_get_contents($this->installations_file), true);
        }

        if (!isset($data['installations'])) {
            $data['installations'] = [];
        }

        $data['installations'][] = $installation;

        file_put_contents(
            $this->installations_file,
            json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }
}
?>
