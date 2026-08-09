<?php
/**
 * DucKI Agent API v1 - Simplified Direct Access
 * Use: api/v1.php?action=tools, api/v1.php?action=skills, etc.
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Handle preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Get action from query parameter
$action = $_GET['action'] ?? $_POST['action'] ?? 'health';
$id = $_GET['id'] ?? $_POST['id'] ?? null;
$type = $_GET['type'] ?? null;
$search = $_GET['search'] ?? null;
$category = $_GET['category'] ?? null;

// Data directory
$data_dir = __DIR__ . '/data';
$tools_file = $data_dir . '/tools.json';
$skills_file = $data_dir . '/skills.json';
$plugins_file = $data_dir . '/plugins.json';

/**
 * Helper: Load JSON file
 */
function load_json($file) {
    if (!file_exists($file)) {
        return null;
    }
    try {
        $content = file_get_contents($file);
        return json_decode($content, true);
    } catch (Exception $e) {
        return null;
    }
}

/**
 * Helper: Response
 */
function json_response($data, $success = true, $message = null) {
    $response = [
        'success' => $success,
        'timestamp' => date('c')
    ];
    if ($data !== null) {
        $response['data'] = $data;
    }
    if ($message !== null) {
        $response['message'] = $message;
    }
    echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit();
}

/**
 * Helper: Error response
 */
function error_response($message, $code = 'ERROR', $status = 400) {
    http_response_code($status);
    json_response(null, false, $message);
}

// Route requests
switch ($action) {
    case 'health':
        json_response([
            'status' => 'healthy',
            'api' => 'DucKI Agent API v1',
            'version' => '1.0.0',
            'files' => [
                'tools' => file_exists($tools_file) ? 'ready' : 'missing',
                'skills' => file_exists($skills_file) ? 'ready' : 'missing'
            ]
        ]);
        break;

    case 'tools':
        $data = load_json($tools_file);
        if (!$data) {
            error_response('Could not load tools data', 'LOAD_ERROR', 500);
        }
        $tools = $data['tools'] ?? [];

        // Filter by category
        if ($category) {
            $tools = array_filter($tools, function($t) use ($category) {
                return ($t['category'] ?? null) === $category;
            });
        }

        // Search
        if ($search) {
            $search = strtolower($search);
            $tools = array_filter($tools, function($t) use ($search) {
                $text = strtolower(($t['name'] ?? '') . ' ' . ($t['description'] ?? ''));
                return strpos($text, $search) !== false;
            });
        }

        json_response([
            'tools' => array_values($tools),
            'count' => count($tools)
        ]);
        break;

    case 'tool':
        if (!$id) {
            error_response('Tool ID required', 'MISSING_ID', 400);
        }
        $data = load_json($tools_file);
        if (!$data) {
            error_response('Could not load tools data', 'LOAD_ERROR', 500);
        }
        $tool = null;
        foreach ($data['tools'] ?? [] as $t) {
            if ($t['id'] === $id) {
                $tool = $t;
                break;
            }
        }
        if (!$tool) {
            error_response('Tool not found: ' . $id, 'NOT_FOUND', 404);
        }
        json_response($tool);
        break;

    case 'skills':
        $data = load_json($skills_file);
        if (!$data) {
            error_response('Could not load skills data', 'LOAD_ERROR', 500);
        }
        $skills = $data['skills'] ?? [];

        // Filter by category
        if ($category) {
            $skills = array_filter($skills, function($s) use ($category) {
                return ($s['category'] ?? null) === $category;
            });
        }

        // Search
        if ($search) {
            $search = strtolower($search);
            $skills = array_filter($skills, function($s) use ($search) {
                $text = strtolower(($s['name'] ?? '') . ' ' . ($s['description'] ?? ''));
                return strpos($text, $search) !== false;
            });
        }

        json_response([
            'skills' => array_values($skills),
            'count' => count($skills)
        ]);
        break;

    case 'skill':
        if (!$id) {
            error_response('Skill ID required', 'MISSING_ID', 400);
        }
        $data = load_json($skills_file);
        if (!$data) {
            error_response('Could not load skills data', 'LOAD_ERROR', 500);
        }
        $skill = null;
        foreach ($data['skills'] ?? [] as $s) {
            if ($s['id'] === $id) {
                $skill = $s;
                break;
            }
        }
        if (!$skill) {
            error_response('Skill not found: ' . $id, 'NOT_FOUND', 404);
        }
        json_response($skill);
        break;

    case 'plugins':
        // List installable plugins (file-first bundles the Node agent can install).
        $data = load_json($plugins_file);
        if (!$data) {
            json_response(['plugins' => [], 'count' => 0]);
            break;
        }
        $plugins = $data['plugins'] ?? [];
        if ($category) {
            $plugins = array_filter($plugins, function($p) use ($category) {
                return ($p['category'] ?? null) === $category;
            });
        }
        if ($search) {
            $needle = strtolower($search);
            $plugins = array_filter($plugins, function($p) use ($needle) {
                $text = strtolower(($p['name'] ?? '') . ' ' . ($p['description'] ?? ''));
                return strpos($text, $needle) !== false;
            });
        }
        json_response([
            'plugins' => array_values($plugins),
            'count' => count($plugins)
        ]);
        break;

    case 'plugin':
        if (!$id) {
            error_response('Plugin ID required', 'MISSING_ID', 400);
        }
        $data = load_json($plugins_file);
        $plugin = null;
        foreach ($data['plugins'] ?? [] as $p) {
            if (($p['id'] ?? null) === $id) {
                $plugin = $p;
                break;
            }
        }
        if (!$plugin) {
            error_response('Plugin not found: ' . $id, 'NOT_FOUND', 404);
        }
        json_response($plugin);
        break;

    case 'categories':
        $tools_data = load_json($tools_file);
        $skills_data = load_json($skills_file);

        $tool_cats = [];
        $skill_cats = [];

        foreach ($tools_data['tools'] ?? [] as $t) {
            $cat = $t['category'] ?? null;
            if ($cat && !in_array($cat, $tool_cats)) {
                $tool_cats[] = $cat;
            }
        }

        foreach ($skills_data['skills'] ?? [] as $s) {
            $cat = $s['category'] ?? null;
            if ($cat && !in_array($cat, $skill_cats)) {
                $skill_cats[] = $cat;
            }
        }

        sort($tool_cats);
        sort($skill_cats);

        json_response([
            'tool_categories' => $tool_cats,
            'skill_categories' => $skill_cats
        ]);
        break;

    case 'download':
        // Serve a bundle for the Node importer. For plugins we return a JSON bundle
        // ({name, files:[{path,content}]}) the agent writes into plugins/<name>/; for skills
        // we stream the legacy tar.gz.
        if (!$id) {
            error_response('ID required', 'MISSING_ID', 400);
        }
        // Strict id sanitization to prevent path traversal.
        if (!preg_match('/^[a-z0-9][a-z0-9-]*$/', $id)) {
            error_response('Invalid ID', 'INVALID_ID', 400);
        }
        if ($type === 'plugin') {
            $bundle_file = $data_dir . '/plugin-bundles/' . $id . '.json';
            $real = realpath($bundle_file);
            $bundles_root = realpath($data_dir . '/plugin-bundles');
            if ($real === false || $bundles_root === false || strpos($real, $bundles_root) !== 0) {
                error_response('Plugin bundle not found: ' . $id, 'NOT_FOUND', 404);
            }
            // Return the raw bundle object (NOT wrapped) so the agent can consume it directly.
            header('Content-Type: application/json; charset=utf-8');
            readfile($real);
            exit();
        }
        $bundle_file = $data_dir . '/bundles/' . $id . '.tar.gz';
        $real = realpath($bundle_file);
        $bundles_root = realpath($data_dir . '/bundles');
        if ($real === false || $bundles_root === false || strpos($real, $bundles_root) !== 0) {
            error_response('Bundle not found: ' . $id . '. Run action=sync first.', 'NOT_FOUND', 404);
        }
        header('Content-Type: application/gzip');
        header('Content-Disposition: attachment; filename="' . $id . '.tar.gz"');
        header('Content-Length: ' . filesize($real));
        readfile($real);
        exit();
        break;

    case 'sync':
        require_once(__DIR__ . '/controllers/SyncController.php');
        $sync = new SyncController(__DIR__);
        $result = $sync->fullSync();

        if (isset($result['error'])) {
            error_response($result['error'], 'SYNC_ERROR', 500);
        }

        json_response($result, true, 'Sync completed successfully');
        break;

    case 'audit':
        $tools_data = load_json($tools_file);
        $skills_data = load_json($skills_file);

        $tools_count = count($tools_data['tools'] ?? []);
        $skills_count = count($skills_data['skills'] ?? []);

        json_response([
            'tools' => [
                'documented' => $tools_count,
                'status' => $tools_count > 0 ? 'OK' : 'MISSING'
            ],
            'skills' => [
                'documented' => $skills_count,
                'status' => $skills_count > 0 ? 'OK' : 'MISSING'
            ],
            'last_sync' => file_exists($skills_file) ? date('c', filemtime($skills_file)) : 'Never',
            'recommendation' => $skills_count < 25 ? 'Run /api/v1.php?action=sync to update skills' : 'System up to date'
        ]);
        break;

    default:
        error_response('Unknown action: ' . $action, 'UNKNOWN_ACTION', 400);
}
?>
