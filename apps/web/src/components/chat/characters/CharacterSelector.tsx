/**
 * Character Selector Modal
 * Browse and select available characters with live preview
 */

import React, { useState } from "react";
import { X, Search } from "lucide-react";
import { characterRegistry } from "./CharacterRegistry";
import { DynamicCharacter } from "./DynamicCharacter";
import type { CharacterDefinition } from "./types";

interface CharacterSelectorProps {
  onSelect: (characterId: string) => void;
  onClose: () => void;
  selectedId?: string;
}

export function CharacterSelector({ onSelect, onClose, selectedId = "duck-matrix" }: CharacterSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [previewId, setPreviewId] = useState(selectedId);

  const allCharacters = characterRegistry.getAllCharacters();

  // Filter characters by search query
  const filtered = allCharacters.filter((char) => {
    const query = searchQuery.toLowerCase();
    return (
      char.name.toLowerCase().includes(query) ||
      char.description?.toLowerCase().includes(query) ||
      char.id.toLowerCase().includes(query)
    );
  });

  const previewCharacter = allCharacters.find((c) => c.id === previewId);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] rounded-xl border border-gray-800 bg-gray-950 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-xl font-semibold">🎨 Character Gallery</h2>
          <button className="text-gray-400 hover:text-white transition" onClick={onClose}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: Character List */}
          <div className="w-64 border-r border-gray-800 flex flex-col bg-gray-900/50">
            {/* Search */}
            <div className="p-4 border-b border-gray-800">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search characters..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input pl-10 w-full text-sm"
                />
              </div>
            </div>

            {/* Character List */}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-4 text-sm text-gray-400 text-center">No characters found</div>
              ) : (
                <div className="space-y-2 p-3">
                  {filtered.map((char) => (
                    <button
                      key={char.id}
                      onClick={() => setPreviewId(char.id)}
                      className={`w-full text-left p-3 rounded-lg transition border ${
                        previewId === char.id
                          ? "border-blue-500/50 bg-blue-500/10 text-blue-100"
                          : "border-gray-700/50 bg-gray-800/30 text-gray-300 hover:bg-gray-800/50"
                      }`}
                    >
                      <div className="font-medium text-sm">{char.name}</div>
                      {char.description && <div className="text-xs text-gray-400 mt-1 line-clamp-2">{char.description}</div>}
                      {char.author && <div className="text-xs text-gray-500 mt-1">by {char.author}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Preview & Details */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {previewCharacter ? (
              <>
                {/* Preview Area */}
                <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-gray-800/50 to-gray-900/50 border-b border-gray-800 p-8">
                  <div className="flex flex-col items-center gap-4">
                    <DynamicCharacter characterId={previewCharacter.id} isWorking={true} size={120} />
                    <div className="text-sm text-gray-400">Preview (Working State)</div>
                  </div>
                </div>

                {/* Details & Actions */}
                <div className="p-6 space-y-4 overflow-y-auto">
                  <div>
                    <h3 className="text-lg font-semibold mb-2">{previewCharacter.name}</h3>
                    {previewCharacter.description && (
                      <p className="text-sm text-gray-300">{previewCharacter.description}</p>
                    )}
                  </div>

                  {/* Metadata */}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {previewCharacter.author && (
                      <div>
                        <div className="text-gray-400">Author</div>
                        <div className="text-gray-100">{previewCharacter.author}</div>
                      </div>
                    )}
                    {previewCharacter.version && (
                      <div>
                        <div className="text-gray-400">Version</div>
                        <div className="text-gray-100">{previewCharacter.version}</div>
                      </div>
                    )}
                    {previewCharacter.type && (
                      <div>
                        <div className="text-gray-400">Type</div>
                        <div className="text-gray-100 capitalize">{previewCharacter.type}</div>
                      </div>
                    )}
                    {previewCharacter.animations && (
                      <div>
                        <div className="text-gray-400">Animations</div>
                        <div className="text-gray-100">{previewCharacter.animations.length}</div>
                      </div>
                    )}
                  </div>

                  {/* Customizable Options */}
                  {previewCharacter.metadata?.customizable && previewCharacter.metadata.customizable.length > 0 && (
                    <div>
                      <div className="text-sm font-medium text-gray-300 mb-2">Customizable</div>
                      <div className="flex gap-2 flex-wrap">
                        {previewCharacter.metadata.customizable.map((opt) => (
                          <span
                            key={opt}
                            className="px-2 py-1 text-xs rounded-full bg-purple-500/20 text-purple-200 border border-purple-500/30"
                          >
                            {opt}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Select Button */}
                  <button
                    onClick={() => {
                      onSelect(previewCharacter.id);
                      onClose();
                    }}
                    className={`w-full py-2 px-4 rounded-lg font-medium transition ${
                      previewId === selectedId
                        ? "bg-gray-700 text-gray-300 cursor-default"
                        : "btn-primary"
                    }`}
                    disabled={previewId === selectedId}
                  >
                    {previewId === selectedId ? "✓ Currently Selected" : "Select Character"}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-400">
                Select a character to preview
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
