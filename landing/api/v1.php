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

    default:
        error_response('Unknown action: ' . $action, 'UNKNOWN_ACTION', 400);
}
?>
