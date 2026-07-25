<?php
/**
 * DucKI Agent API Configuration
 */

define('API_VERSION', '1.0.0');
define('API_NAME', 'DucKI Agent API');

// Data paths
define('DATA_DIR', __DIR__ . '/data');
define('TOOLS_FILE', DATA_DIR . '/tools.json');
define('SKILLS_FILE', DATA_DIR . '/skills.json');

// CORS Headers
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Content-Type: application/json; charset=utf-8');

// Handle preflight requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// API response helper
function json_response($data, $status_code = 200) {
    http_response_code($status_code);
    echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit();
}

// Error response helper
function error_response($message, $code = 'ERROR', $status_code = 400) {
    json_response([
        'error' => true,
        'code' => $code,
        'message' => $message,
        'timestamp' => date('c')
    ], $status_code);
}

// Success response helper
function success_response($data, $message = null) {
    $response = [
        'success' => true,
        'data' => $data,
        'timestamp' => date('c')
    ];
    if ($message) {
        $response['message'] = $message;
    }
    json_response($response, 200);
}
?>
