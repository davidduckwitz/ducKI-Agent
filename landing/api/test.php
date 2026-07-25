<?php
/**
 * API Debug & Test Script
 * Teste: https://domain.com/api/test.php
 */

header('Content-Type: application/json');

$result = [
    'test' => 'API Debug Test',
    'timestamp' => date('c'),
    'php_version' => phpversion(),
    'files' => []
];

// Check if files exist
$files_to_check = [
    'tools.json' => __DIR__ . '/data/tools.json',
    'skills.json' => __DIR__ . '/data/skills.json',
    'JsonLoader.php' => __DIR__ . '/lib/JsonLoader.php',
    'InstallController.php' => __DIR__ . '/controllers/InstallController.php',
];

foreach ($files_to_check as $name => $path) {
    $result['files'][$name] = [
        'exists' => file_exists($path),
        'path' => $path,
        'readable' => file_exists($path) ? is_readable($path) : false
    ];
}

// Try to load tools.json
try {
    $tools_json = __DIR__ . '/data/tools.json';
    if (file_exists($tools_json)) {
        $content = file_get_contents($tools_json);
        $data = json_decode($content, true);
        $result['tools_load'] = [
            'success' => $data !== null,
            'tools_count' => isset($data['tools']) ? count($data['tools']) : 0,
            'json_error' => json_last_error_msg()
        ];
    } else {
        $result['tools_load'] = ['error' => 'File not found'];
    }
} catch (Exception $e) {
    $result['tools_load'] = ['error' => $e->getMessage()];
}

// Try to load skills.json
try {
    $skills_json = __DIR__ . '/data/skills.json';
    if (file_exists($skills_json)) {
        $content = file_get_contents($skills_json);
        $data = json_decode($content, true);
        $result['skills_load'] = [
            'success' => $data !== null,
            'skills_count' => isset($data['skills']) ? count($data['skills']) : 0,
            'json_error' => json_last_error_msg()
        ];
    } else {
        $result['skills_load'] = ['error' => 'File not found'];
    }
} catch (Exception $e) {
    $result['skills_load'] = ['error' => $e->getMessage()];
}

// Check if config loads
try {
    $result['config_loads'] = file_exists(__DIR__ . '/config.php') ? 'yes' : 'no';
} catch (Exception $e) {
    $result['config_loads'] = 'error: ' . $e->getMessage();
}

echo json_encode($result, JSON_PRETTY_PRINT);
?>
