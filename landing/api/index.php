<?php
/**
 * DucKI Agent API
 * Main endpoint for tools, skills, and documentation
 */

require_once 'config.php';
require_once 'lib/JsonLoader.php';
require_once 'controllers/InstallController.php';

$install_controller = new InstallController();

// Parse request
$request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$request_path = str_replace('/api', '', $request_uri);

// Route requests
if (empty($request_path) || $request_path === '/') {
    handle_root();
} elseif (preg_match('#^/health/?$#', $request_path)) {
    handle_health();
} elseif (preg_match('#^/tools/?$#', $request_path)) {
    handle_tools();
} elseif (preg_match('#^/skills/?$#', $request_path)) {
    handle_skills();
} elseif (preg_match('#^/tools/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_tool_detail($matches[1]);
} elseif (preg_match('#^/skills/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_skill_detail($matches[1]);
} elseif (preg_match('#^/docs/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_doc($matches[1]);
} elseif (preg_match('#^/categories/?$#', $request_path)) {
    handle_categories();
} elseif (preg_match('#^/install/tool/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_install_tool($matches[1], $install_controller);
} elseif (preg_match('#^/install/skill/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_install_skill($matches[1], $install_controller);
} elseif (preg_match('#^/installations/?$#', $request_path)) {
    handle_get_installations($install_controller);
} elseif (preg_match('#^/uninstall/([a-z0-9\-]+)/?$#', $request_path, $matches)) {
    handle_uninstall($matches[1], $install_controller);
} else {
    error_response('Endpoint not found', 'NOT_FOUND', 404);
}

/**
 * GET /api - API Info
 */
function handle_root() {
    $data = [
        'name' => API_NAME,
        'version' => API_VERSION,
        'description' => 'API for DucKI Agent Tools and Skills',
        'endpoints' => [
            'GET /api/health' => 'Health check',
            'GET /api/tools' => 'List all tools',
            'GET /api/tools/:id' => 'Get specific tool',
            'GET /api/skills' => 'List all skills',
            'GET /api/skills/:id' => 'Get specific skill',
            'GET /api/categories' => 'List all categories',
            'GET /api/docs/:id' => 'Get documentation for tool/skill',
            'GET /api/search?q=query' => 'Search tools and skills',
        ],
        'documentation': 'https://' . $_SERVER['HTTP_HOST'] . '/landing/api-docs.html'
    ];
    success_response($data, 'DucKI Agent API');
}

/**
 * GET /api/health - Health check
 */
function handle_health() {
    $data = [
        'status' => 'healthy',
        'api' => API_NAME,
        'version' => API_VERSION,
        'timestamp' => date('c'),
        'data_files' => [
            'tools' => file_exists(TOOLS_FILE) ? 'ready' : 'missing',
            'skills' => file_exists(SKILLS_FILE) ? 'ready' : 'missing'
        ]
    ];
    success_response($data);
}

/**
 * GET /api/tools - List all tools
 */
function handle_tools() {
    try {
        $data = JsonLoader::load(TOOLS_FILE);

        // Check for query parameters
        if (isset($_GET['category'])) {
            $category = $_GET['category'];
            $data['tools'] = array_values(JsonLoader::filterByCategory($data['tools'], $category));
        }

        if (isset($_GET['search'])) {
            $query = $_GET['search'];
            $data['tools'] = array_values(JsonLoader::search($data['tools'], $query));
        }

        $data['count'] = count($data['tools']);
        success_response($data);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * GET /api/skills - List all skills
 */
function handle_skills() {
    try {
        $data = JsonLoader::load(SKILLS_FILE);

        // Check for query parameters
        if (isset($_GET['category'])) {
            $category = $_GET['category'];
            $data['skills'] = array_values(JsonLoader::filterByCategory($data['skills'], $category));
        }

        if (isset($_GET['search'])) {
            $query = $_GET['search'];
            $data['skills'] = array_values(JsonLoader::search($data['skills'], $query));
        }

        $data['count'] = count($data['skills']);
        success_response($data);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * GET /api/tools/:id - Get specific tool
 */
function handle_tool_detail($id) {
    try {
        $data = JsonLoader::load(TOOLS_FILE);
        $tool = JsonLoader::getById($data['tools'], $id);

        if (!$tool) {
            error_response("Tool not found: {$id}", 'NOT_FOUND', 404);
        }

        success_response($tool);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * GET /api/skills/:id - Get specific skill
 */
function handle_skill_detail($id) {
    try {
        $data = JsonLoader::load(SKILLS_FILE);
        $skill = JsonLoader::getById($data['skills'], $id);

        if (!$skill) {
            error_response("Skill not found: {$id}", 'NOT_FOUND', 404);
        }

        success_response($skill);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * GET /api/docs/:id - Get documentation
 */
function handle_doc($id) {
    try {
        // Try tools first
        $tools_data = JsonLoader::load(TOOLS_FILE);
        $tool = JsonLoader::getById($tools_data['tools'], $id);

        if ($tool) {
            $doc = [
                'type' => 'tool',
                'id' => $tool['id'],
                'name' => $tool['name'],
                'category' => $tool['category'],
                'description' => $tool['description'],
                'version' => $tool['version'],
                'status' => $tool['status'],
                'core' => $tool['core'],
                'dependencies' => $tool['dependencies'],
                'useCase' => $tool['useCase'],
                'examples' => $tool['examples'],
                'repository' => $tool['repository'],
                'docs_url' => $tool['docs_url']
            ];
            success_response($doc);
        }

        // Try skills
        $skills_data = JsonLoader::load(SKILLS_FILE);
        $skill = JsonLoader::getById($skills_data['skills'], $id);

        if ($skill) {
            $doc = [
                'type' => 'skill',
                'id' => $skill['id'],
                'name' => $skill['name'],
                'category' => $skill['category'],
                'description' => $skill['description'],
                'version' => $skill['version'],
                'status' => $skill['status'],
                'dependencies' => $skill['dependencies'],
                'useCase' => $skill['useCase'],
                'examples' => $skill['examples'],
                'repository' => $skill['repository'],
                'docs_url' => $skill['docs_url']
            ];
            success_response($doc);
        }

        error_response("Documentation not found for: {$id}", 'NOT_FOUND', 404);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * GET /api/categories - List all categories
 */
function handle_categories() {
    try {
        $tools_data = JsonLoader::load(TOOLS_FILE);
        $skills_data = JsonLoader::load(SKILLS_FILE);

        $tool_categories = [];
        $skill_categories = [];

        foreach ($tools_data['tools'] as $tool) {
            if (isset($tool['category']) && !in_array($tool['category'], $tool_categories)) {
                $tool_categories[] = $tool['category'];
            }
        }

        foreach ($skills_data['skills'] as $skill) {
            if (isset($skill['category']) && !in_array($skill['category'], $skill_categories)) {
                $skill_categories[] = $skill['category'];
            }
        }

        sort($tool_categories);
        sort($skill_categories);

        $data = [
            'tool_categories' => $tool_categories,
            'skill_categories' => $skill_categories,
            'total_categories' => count($tool_categories) + count($skill_categories)
        ];

        success_response($data);
    } catch (Exception $e) {
        error_response($e->getMessage(), 'LOAD_ERROR', 500);
    }
}

/**
 * POST /api/install/tool/:id - Install Tool
 */
function handle_install_tool($tool_id, $install_controller) {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        error_response('Method not allowed', 'METHOD_NOT_ALLOWED', 405);
    }

    $result = $install_controller->installTool($tool_id);
    if ($result['success']) {
        success_response($result['data'], $result['message']);
    } else {
        error_response($result['error'], $result['code'], 400);
    }
}

/**
 * POST /api/install/skill/:id - Install Skill
 */
function handle_install_skill($skill_id, $install_controller) {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        error_response('Method not allowed', 'METHOD_NOT_ALLOWED', 405);
    }

    $result = $install_controller->installSkill($skill_id);
    if ($result['success']) {
        success_response($result['data'], $result['message']);
    } else {
        error_response($result['error'], $result['code'], 400);
    }
}

/**
 * GET /api/installations - Get installation history
 */
function handle_get_installations($install_controller) {
    $type = $_GET['type'] ?? null;
    $limit = intval($_GET['limit'] ?? 50);

    $result = $install_controller->getInstallations($type, $limit);
    success_response($result['data']);
}

/**
 * DELETE /api/uninstall/:id - Uninstall
 */
function handle_uninstall($installation_id, $install_controller) {
    if ($_SERVER['REQUEST_METHOD'] !== 'DELETE' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
        error_response('Method not allowed', 'METHOD_NOT_ALLOWED', 405);
    }

    $result = $install_controller->uninstall($installation_id);
    if ($result['success']) {
        success_response([], $result['message']);
    } else {
        error_response($result['error'], $result['code'], 400);
    }
}
?>
