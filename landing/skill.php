<?php
/**
 * DucKI Agent - Dynamische Skill-Detailseite
 */

require_once 'api/config.php';
require_once 'api/lib/JsonLoader.php';

// Get skill ID from URL
$skill_id = $_GET['id'] ?? null;
if (!$skill_id) {
    header('Location: skills.html');
    exit;
}

// Load skill data
try {
    $data = JsonLoader::load('api/data/skills.json');
    $skill = JsonLoader::getById($data['skills'], $skill_id);

    if (!$skill) {
        http_response_code(404);
        $error = true;
        $error_msg = "Skill nicht gefunden: $skill_id";
    } else {
        $error = false;
    }
} catch (Exception $e) {
    http_response_code(500);
    $error = true;
    $error_msg = $e->getMessage();
}

// Icon mapping
$skill_icons = [
    'plan' => '📋',
    'auto-plan' => '🤖',
    'workflow-orchestrator' => '🕸️',
    'plan-import' => '📥',
    'coding-system' => '💻',
    'code-review' => '👀',
    'test-driven-development' => '🧪',
    'security-skill' => '🔒',
    'llm-wiki' => '📚',
    'history-search' => '🔍',
    'shared-workspace-ops' => '📁',
    'shared-workspace-api-first' => '🔌',
    'cronjobs' => '⏰',
    'discord' => '💬',
    'mcp-integration' => '🔗',
    'browser-control' => '🌐',
    'datum-uhrzeit-tag' => '📅',
    'tool-orchestration' => '⚙️',
    'tasks-kanban' => '📊',
    'json-tool-format' => '{}',
    'fast-answer' => '⚡',
    'btc-puzzle-solver' => '₿',
    'btc-puzzle-solve' => '₿',
];

$icon = $skill_icons[$skill_id] ?? '⭐';
$title = $error ? 'Skill nicht gefunden' : ($skill['name'] ?? 'Skill Details');
?>
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?php echo htmlspecialchars($title); ?> - DucKI Agent</title>
    <meta name="description" content="<?php echo htmlspecialchars($skill['description'] ?? ''); ?>">
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
                <a href="tools.html" class="text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-blue-600">Tools</a>
                <a href="skills.html" class="text-sm font-medium text-blue-600 dark:text-blue-400">Skills</a>
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
            <a href="skills.html" class="hover:text-blue-600">Skills</a>
            <span> / </span>
            <span class="text-slate-900 dark:text-white font-medium"><?php echo htmlspecialchars($title); ?></span>
        </div>
    </nav>

    <?php if ($error): ?>
    <!-- Error Message -->
    <section class="py-20 px-4">
        <div class="max-w-4xl mx-auto">
            <div class="bg-red-50 dark:bg-red-900/20 p-8 rounded-lg border border-red-200 dark:border-red-800">
                <h1 class="text-3xl font-bold mb-4 text-red-600 dark:text-red-400">Skill nicht gefunden</h1>
                <p class="text-slate-600 dark:text-slate-400 mb-6"><?php echo htmlspecialchars($error_msg); ?></p>
                <a href="skills.html" class="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors">
                    Zurück zu Skills
                </a>
            </div>
        </div>
    </section>
    <?php else: ?>

    <!-- Header -->
    <section class="bg-gradient-to-br from-purple-50 dark:from-slate-900 to-slate-50 dark:to-slate-800 py-12 px-4 border-b border-slate-200 dark:border-slate-800">
        <div class="max-w-4xl mx-auto">
            <div class="flex items-start gap-4 mb-6">
                <div class="text-5xl"><?php echo $icon; ?></div>
                <div>
                    <h1 class="text-4xl font-bold mb-2"><?php echo htmlspecialchars($skill['name']); ?></h1>
                    <div class="flex gap-2 flex-wrap">
                        <span class="px-3 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-sm font-medium"><?php echo htmlspecialchars($skill['category']); ?></span>
                        <span class="px-3 py-1 rounded-full bg-<?php echo ($skill['status'] === 'stable' ? 'green' : 'yellow'); ?>-100 dark:bg-<?php echo ($skill['status'] === 'stable' ? 'green' : 'yellow'); ?>-900/30 text-<?php echo ($skill['status'] === 'stable' ? 'green' : 'yellow'); ?>-700 dark:text-<?php echo ($skill['status'] === 'stable' ? 'green' : 'yellow'); ?>-300 text-sm font-medium"><?php echo ucfirst($skill['status']); ?></span>
                    </div>
                </div>
            </div>
            <p class="text-lg text-slate-600 dark:text-slate-300"><?php echo htmlspecialchars($skill['description']); ?></p>
        </div>
    </section>

    <!-- Main Content -->
    <section class="py-12 px-4">
        <div class="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
            <!-- Main Content -->
            <div class="lg:col-span-2 space-y-8">
                <!-- Beschreibung -->
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Beschreibung</h2>
                    <p class="text-slate-600 dark:text-slate-400">
                        Dieses Skill unterstützt Sie bei spezialisierten Aufgaben innerhalb des DucKI-Agent Ökosystems.
                        Es können mehrere damit verbundene Tools und Workflows verwendet werden, um Ihre Produktivität zu maximieren.
                    </p>
                </div>

                <!-- Anwendungsfälle -->
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Anwendungsfälle</h2>
                    <ul class="space-y-2">
                        <?php foreach ($skill['useCase'] as $usecase): ?>
                        <li class="flex gap-2 text-slate-600 dark:text-slate-400">
                            <span class="flex-shrink-0 text-green-500">✓</span>
                            <span><?php echo htmlspecialchars($usecase); ?></span>
                        </li>
                        <?php endforeach; ?>
                    </ul>
                </div>

                <!-- Beispiele -->
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Beispiele & Tipps</h2>
                    <div class="space-y-4">
                        <?php foreach ($skill['examples'] as $example): ?>
                        <div class="bg-slate-900 text-slate-100 p-4 rounded-lg text-sm overflow-x-auto">
                            <pre><?php echo htmlspecialchars($example); ?></pre>
                        </div>
                        <?php endforeach; ?>
                    </div>
                </div>

                <!-- Abhängigkeiten -->
                <?php if (!empty($skill['dependencies'])): ?>
                <div class="bg-white dark:bg-slate-900 p-8 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h2 class="text-2xl font-bold mb-4">Abhängigkeiten</h2>
                    <div class="space-y-2 text-slate-600 dark:text-slate-400">
                        <p class="mb-4">Dieses Skill benötigt folgende Komponenten:</p>
                        <?php foreach ($skill['dependencies'] as $dep): ?>
                        <div class="flex gap-2">
                            <span class="flex-shrink-0">→</span>
                            <span><?php echo htmlspecialchars($dep); ?></span>
                        </div>
                        <?php endforeach; ?>
                    </div>
                </div>
                <?php endif; ?>

                <!-- Aktivierung -->
                <div class="bg-blue-50 dark:bg-blue-900/20 p-8 rounded-lg border border-blue-200 dark:border-blue-800">
                    <h2 class="text-2xl font-bold mb-4">⚙️ Aktivierung & Verwendung</h2>
                    <p class="text-slate-600 dark:text-slate-400 mb-4">
                        Skills können nach Bedarf aktiviert oder deaktiviert werden. Sie beeinflussen das Verhalten des Agenten.
                    </p>
                    <div class="space-y-4">
                        <div>
                            <p class="font-semibold text-slate-900 dark:text-white mb-2">1. Skill aktivieren:</p>
                            <ol class="space-y-1 text-slate-600 dark:text-slate-400 text-sm list-decimal list-inside">
                                <li>Öffnen Sie <code class="bg-white dark:bg-slate-900 px-2 py-1 rounded">/skills</code></li>
                                <li>Finden Sie "<?php echo htmlspecialchars($skill['name']); ?>"</li>
                                <li>Klicken Sie auf "Aktivieren"</li>
                            </ol>
                        </div>
                        <div>
                            <p class="font-semibold text-slate-900 dark:text-white mb-2">2. Skill verwenden:</p>
                            <p class="text-sm text-slate-600 dark:text-slate-400">
                                Das Skill wird automatisch vom Agent verwendet, wenn es relevant für die aktuelle Aufgabe ist.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Sidebar -->
            <div class="space-y-6">
                <!-- Info Card -->
                <div class="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800 sticky top-20">
                    <h3 class="font-semibold mb-4">Skill Information</h3>
                    <dl class="space-y-3 text-sm">
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Version</dt>
                            <dd class="text-slate-900 dark:text-white"><?php echo htmlspecialchars($skill['version']); ?></dd>
                        </div>
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Status</dt>
                            <dd class="text-slate-900 dark:text-white capitalize"><?php echo htmlspecialchars($skill['status']); ?></dd>
                        </div>
                        <div>
                            <dt class="font-medium text-slate-500 dark:text-slate-400">Kategorie</dt>
                            <dd class="text-slate-900 dark:text-white"><?php echo htmlspecialchars($skill['category']); ?></dd>
                        </div>
                    </dl>
                    <div class="mt-6 space-y-2">
                        <a href="<?php echo htmlspecialchars($skill['repository']); ?>" target="_blank" class="block w-full px-4 py-2 rounded-lg bg-slate-600 hover:bg-slate-700 text-white text-center font-medium transition-colors text-sm">
                            GitHub Repository →
                        </a>
                        <a href="skills.html" class="block w-full px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 text-center font-medium transition-colors text-sm">
                            Alle Skills ansehen
                        </a>
                    </div>
                </div>

                <!-- Related Skills -->
                <?php if (!empty($skill['dependencies'])): ?>
                <div class="bg-white dark:bg-slate-900 p-6 rounded-lg border border-slate-200 dark:border-slate-800">
                    <h3 class="font-semibold mb-4">Benötigte Komponenten</h3>
                    <div class="space-y-2 text-sm">
                        <?php foreach ($skill['dependencies'] as $dep): ?>
                        <div class="p-2 bg-slate-50 dark:bg-slate-800 rounded">
                            <div class="font-medium"><?php echo htmlspecialchars($dep); ?></div>
                        </div>
                        <?php endforeach; ?>
                    </div>
                </div>
                <?php endif; ?>

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
