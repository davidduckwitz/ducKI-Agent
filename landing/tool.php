<?php
/**
 * DucKI Agent - Dynamische Tool-Detailseite
 */

require_once 'api/config.php';
require_once 'api/lib/JsonLoader.php';

// Get tool ID from URL
$tool_id = $_GET['id'] ?? null;
if (!$tool_id) {
    header('Location: tools.html');
    exit;
}

// Load tool data
try {
    $data = JsonLoader::load('api/data/tools.json');
    $tool = JsonLoader::getById($data['tools'], $tool_id);

    if (!$tool) {
        http_response_code(404);
        $error = true;
        $error_msg = "Tool nicht gefunden: $tool_id";
    } else {
        $error = false;
    }
} catch (Exception $e) {
    http_response_code(500);
    $error = true;
    $error_msg = $e->getMessage();
}

// Icon mapping
$tool_icons = [
    'filesystem' => '📁',
    'browser' => '🌐',
    'git' => '📚',
    'shell' => '⌨️',
    'http' => '🔌',
    'task' => '✓',
    'memory' => '💾',
    'workflow' => '🕸️',
    'cronjob' => '⏰',
    'skill_manage' => '⚡',
    'mcp' => '🔗',
    'project' => '📊',
    'tool_factory' => '🛠️',
    'history' => '📜',
    'gateway' => '💬',
    'plan' => '📋',
    'weather_summary' => '🌤️',
];

$icon = $tool_icons[$tool_id] ?? '🔧';
$title = $error ? 'Tool nicht gefunden' : ($tool['name'] ?? 'Tool Details');
?>
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?php echo htmlspecialchars($title); ?> - DucKI Agent</title>
    <meta name="description" content="<?php echo htmlspecialchars($tool['description'] ?? ''); ?>">
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="assets/css/style.css">
</head>
<body class="bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
    <!-- Navigation -->
    <nav class="sticky top-0 z-50 bg-white dark:bg-slate-900 shadow-sm">
        <div class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
            <div class="flex items-center gap-2">
                <div class="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center text-white font-bold text-lg">🦆</div>
                <a href="index.html" class="text-xl font-bold text-slate-900 dark:text-white">DucKI Agent</a>
            </div>
            <div class="flex items-center gap-4">
                <a href="tools.html" class="text-sm font-medium text-blue-600 dark:text-blue-400">Tools</a>
                <a href="skills.html" class="text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600">Skills</a>
                <a href="documentation.html" class="text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600">Docs</a>
                <a href="https://github.com/davidduckwitz/ducKI-Agent" target="_blank" class="text-sm font-medium text-blue-600">GitHub</a>
            </div>
        </div>
    </nav>

    <!-- Breadcrumb -->
    <nav class="bg-white dark:bg-slate-900 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div class="max-w-6xl mx-auto text-sm text-slate-600 dark:text-slate-400">
            <a href="index.html" class="hover:text-blue-600">Startseite</a>
            <span> / </span>
            <a href="tools.html" class="hover:text-blue-600">Tools</a>
            <span> / </span>
            <span class="text-slate-900 dark:text-white font-medium"><?php echo htmlspecialchars($title); ?></span>
        </div>
    </nav>

    <?php if ($error): ?>
    <!-- Error Message -->
    <section class="py-20 px-4">
        <div class="max-w-4xl mx-auto">
            <div class="bg-red-50 dark:bg-red-900/20 p-8 rounded-lg border border-red-200 dark:border-red-800">
                <h1 class="text-3xl font-bold mb-4 text-red-600 dark:text-red-400">Tool nicht gefunden</h1>
                <p class="text-slate-600 dark:text-slate-400 mb-6"><?php echo htmlspecialchars($error_msg); ?></p>
                <a href="tools.html" class="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors">
                    Zurück zu Tools
                </a>
            </div>
        </div>
    </section>
    <?php else: ?>

    <!-- Header -->
    <section class="bg-gradient-to-br from-blue-50 dark:from-slate-900 to-slate-50 dark:to-slate-800 py-12 px-4 border-b border-slate-200 dark:border-slate-800">
        <div class="max-w-4xl mx-auto">
            <div class="flex items-start gap-4 mb-6">
                <div class="text-5xl"><?php echo $icon; ?></div>
                <div>
                    <h1 class="text-4xl font-bold mb-2"><?php echo htmlspecialchars($tool['name']); ?></h1>
                    <div class="flex gap-2 flex-wrap">
                        <span class="px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-sm font-medium"><?php echo htmlspecialchars($tool['category']); ?></span>
                        <span class="px-3 py-1 rounded-full bg-<?php echo ($tool['status'] === 'stable' ? 'green' : 'yellow'); ?>-100 dark:bg-<?php echo ($tool['status'] === 'stable' ? 'green' : 'yellow'); ?>-900/30 text-<?php echo ($tool['status'] === 'stable' ? 'green' : 'yellow'); ?>-700 dark:text-<?php echo ($tool['status'] === 'stable' ? 'green' : 'yellow'); ?>-300 text-sm font-medium"><?php echo ucfirst($tool['status']); ?></span>
                        <?php if ($tool['core']): ?>
                        <span class="px-3 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-sm font-medium">Core Tool</span>
                        <?php endif; ?>
                    </div>
                </div>
            </div>
            <p class="text-lg text-slate-600 dark:text-slate-300"><?php echo htmlspecialchars($tool['description']); ?></p>
        </div>
    </section>

    <!-- Main Content -->
    <section class="py-12 px-4">
        <div class="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
            <!-- Main Content -->
            <div class="lg:col-span-2 space-y-8">
                <!-- Use Cases -->
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Anwendungsfälle</h2>
                    <ul class="space-y-2">
                        <?php foreach ($tool['useCase'] as $usecase): ?>
                        <li class="flex gap-2 text-slate-600 dark:text-slate-400">
                            <span class="flex-shrink-0 text-green-500">✓</span>
                            <span><?php echo htmlspecialchars($usecase); ?></span>
                        </li>
                        <?php endforeach; ?>
                    </ul>
                </div>

                <!-- Examples -->
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Beispiele</h2>
                    <div class="space-y-4">
                        <?php foreach ($tool['examples'] as $example): ?>
                        <div class="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">
                            <pre><?php echo htmlspecialchars($example); ?></pre>
                        </div>
                        <?php endforeach; ?>
                    </div>
                </div>

                <!-- Dependencies -->
                <?php if (!empty($tool['dependencies'])): ?>
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Abhängigkeiten</h2>
                    <div class="space-y-2 text-slate-600 dark:text-slate-400">
                        <?php foreach ($tool['dependencies'] as $dep): ?>
                        <div class="flex gap-2">
                            <span class="flex-shrink-0">→</span>
                            <span><?php echo htmlspecialchars($dep); ?></span>
                        </div>
                        <?php endforeach; ?>
                    </div>
                </div>
                <?php endif; ?>

                <!-- Setup -->
                <div class="bg-blue-50 dark:bg-blue-900/20 p-8 rounded-lg border border-blue-200 dark:border-blue-800">
                    <h2 class="text-2xl font-bold mb-4">⚙️ Verwendung</h2>
                    <p class="text-slate-600 dark:text-slate-400 mb-4">
                        Dieses Tool ist in den Settings unter "Tools" verfügbar. <?php echo $tool['core'] ? 'Als Core-Tool ist es standardmäßig aktiviert.' : 'Aktivieren Sie es in den Einstellungen, um es zu verwenden.'; ?>
                    </p>
                    <div class="space-y-2">
                        <p class="font-semibold text-slate-900 dark:text-white">Aktivierung:</p>
                        <ol class="space-y-2 text-slate-600 dark:text-slate-400 list-decimal list-inside">
                            <li>Gehen Sie zu <code class="bg-white dark:bg-slate-900 px-2 py-1 rounded">/settings</code></li>
                            <li>Wählen Sie "Tools" Tab</li>
                            <li>Aktivieren Sie "<?php echo htmlspecialchars($tool['name']); ?>"</li>
                            <li>Speichern Sie die Änderungen</li>
                        </ol>
                    </div>
                </div>
            </div>

            <!-- Sidebar -->
            <div class="space-y-6">
                <!-- Info Card -->
                <div class="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800 sticky top-20">
                    <h3 class="font-semibold mb-4">Tool Information</h3>
                    <dl class="space-y-3 text-sm">
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Version</dt>
                            <dd class="text-slate-900 dark:text-white"><?php echo htmlspecialchars($tool['version']); ?></dd>
                        </div>
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Status</dt>
                            <dd class="text-slate-900 dark:text-white capitalize"><?php echo htmlspecialchars($tool['status']); ?></dd>
                        </div>
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Kategorie</dt>
                            <dd class="text-slate-900 dark:text-white"><?php echo htmlspecialchars($tool['category']); ?></dd>
                        </div>
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Typ</dt>
                            <dd class="text-slate-900 dark:text-white"><?php echo $tool['core'] ? 'Core Tool' : 'Optional Tool'; ?></dd>
                        </div>
                    </dl>
                    <div class="mt-6 space-y-2">
                        <a href="<?php echo htmlspecialchars($tool['repository']); ?>" target="_blank" class="block w-full px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-700 text-white text-center font-medium transition-colors text-sm">
                            GitHub Repository →
                        </a>
                        <a href="tools.html" class="block w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 text-center font-medium transition-colors text-sm">
                            Alle Tools ansehen
                        </a>
                    </div>
                </div>

                <!-- Links -->
                <div class="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h3 class="font-semibold mb-4">Dokumentation</h3>
                    <ul class="space-y-2 text-sm">
                        <li><a href="documentation.html" class="text-blue-600 hover:text-blue-700">→ Setup Guide</a></li>
                        <li><a href="api-docs.html" class="text-blue-600 hover:text-blue-700">→ API Referenz</a></li>
                        <li><a href="https://github.com/davidduckwitz/ducKI-Agent" target="_blank" class="text-blue-600 hover:text-blue-700">→ GitHub</a></li>
                    </ul>
                </div>
            </div>
        </div>
    </section>

    <?php endif; ?>

    <!-- Footer -->
    <footer class="bg-slate-900 dark:bg-slate-950 text-slate-400 py-12 px-4 mt-12">
        <div class="max-w-6xl mx-auto text-center">
            <p>© 2024 DucKI Agent. <a href="about.html" class="hover:text-white">Über uns</a> · <a href="https://github.com/davidduckwitz/ducKI-Agent" class="hover:text-white">GitHub</a></p>
        </div>
    </footer>

    <script src="assets/js/main.js"></script>
</body>
</html>
