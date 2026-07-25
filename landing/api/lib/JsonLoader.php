<?php
/**
 * JSON Loader Helper
 */

class JsonLoader {
    /**
     * Load JSON file and return array
     */
    public static function load($file_path) {
        if (!file_exists($file_path)) {
            throw new Exception("File not found: {$file_path}");
        }

        $content = file_get_contents($file_path);
        $data = json_decode($content, true);

        if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
            throw new Exception("Invalid JSON in {$file_path}: " . json_last_error_msg());
        }

        return $data;
    }

    /**
     * Get item by ID from array
     */
    public static function getById($items, $id, $id_key = 'id') {
        foreach ($items as $item) {
            if (isset($item[$id_key]) && $item[$id_key] === $id) {
                return $item;
            }
        }
        return null;
    }

    /**
     * Filter items by category
     */
    public static function filterByCategory($items, $category) {
        return array_filter($items, function($item) use ($category) {
            return isset($item['category']) && $item['category'] === $category;
        });
    }

    /**
     * Search items by query string
     */
    public static function search($items, $query) {
        $query = strtolower($query);
        return array_filter($items, function($item) use ($query) {
            $searchable = [
                $item['id'] ?? '',
                $item['name'] ?? '',
                $item['description'] ?? '',
                implode(' ', $item['useCase'] ?? []),
            ];
            $text = strtolower(implode(' ', $searchable));
            return strpos($text, $query) !== false;
        });
    }
}
?>
