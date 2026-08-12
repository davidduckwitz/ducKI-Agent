import { useState, useEffect, useRef } from "react";
import { Play, Pause, StopCircle, RefreshCw, Copy, Check, Plus, Trash2, Eye } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";

interface PuzzleItem {
  id: string;
  name: string;
  targetAddress: string;
  infoUrl?: string;
  createdAt: string;
  status: string;
  generatedAddresses: number;
  triedCombinationsCount: number;
  found: boolean;
}

interface AttemptRecord {
  mnemonic: string;
  address: string;
}

interface SearchResult {
  puzzleId: string;
  puzzleName: string;
  mnemonic: string;
  address: string;
}

interface PuzzleDetail extends Omit<PuzzleItem, "found" | "triedCombinationsCount"> {
  found?: boolean;
  triedCombinationsCount?: number;
  elapsedSeconds: number;
  addressesPerSecond: number;
  isRunning: boolean;
  foundAddress: string | null;
  foundMnemonic: string | null;
  error: string | null;
  lastUpdate: string;
  currentCombinationMode?: string;
  recentAttempts?: AttemptRecord[];
}

interface BitcoinPuzzleManagerProps {
  initialSelectedPuzzleId?: string | null;
}

export function BitcoinPuzzleManager({ initialSelectedPuzzleId }: BitcoinPuzzleManagerProps = {}) {
  const { t } = useI18n();
  const [puzzles, setPuzzles] = useState<PuzzleItem[]>([]);
  const [selectedPuzzleId, setSelectedPuzzleId] = useState<string | null>(initialSelectedPuzzleId || null);
  const [selectedPuzzleDetail, setSelectedPuzzleDetail] = useState<PuzzleDetail | null>(null);

  // Neue Puzzle Form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    targetAddress: "",
    infoUrl: "",
    startMnemonic: "",
  });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"address" | "mnemonic" | null>(null);

  // Live Event Log
  const [liveEvents, setLiveEvents] = useState<Array<{ timestamp: string; message: string; type: string }>>([]);

  // Recent Attempts Expand/Collapse
  const [showRecentAttempts, setShowRecentAttempts] = useState(false);

  // Global Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  // Track if default puzzle initialization has already started to prevent race conditions
  const initializingRef = useRef(false);;

  // Edit Mode
  const [editingPuzzleId, setEditingPuzzleId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", infoUrl: "", manualPhrase: "", manualAddress: "" });

  // Load Puzzles
  const loadPuzzles = async () => {
    try {
      const data = await api.bitcoinPuzzle.list();
      // Ensure all puzzles have triedCombinationsCount
      const puzzlesWithDefaults = (data.puzzles || []).map((p: any) => ({
        ...p,
        triedCombinationsCount: p.triedCombinationsCount ?? 0,
      }));
      setPuzzles(puzzlesWithDefaults);

      // Aktualisiere ausgewähltes Puzzle wenn noch aktiv
      if (selectedPuzzleId) {
        const detail = data.puzzles.find((p) => p.id === selectedPuzzleId);
        if (detail) {
          try {
            const fullDetail = await api.bitcoinPuzzle.get(selectedPuzzleId);
            setSelectedPuzzleDetail(fullDetail);
          } catch (err) {
            // Puzzle was deleted, clear selection
            setSelectedPuzzleId(null);
            setSelectedPuzzleDetail(null);
          }
        } else {
          // Puzzle not in list, clear selection
          setSelectedPuzzleId(null);
          setSelectedPuzzleDetail(null);
        }
      }
    } catch (error) {
      console.error("Failed to load puzzles:", error);
    }
  };

  // Edit Puzzle Handler
  const handleEditPuzzle = async () => {
    if (!editingPuzzleId) return;

    try {
      // Update metadata (name, infoUrl) - only if values are provided
      if (editForm.name || editForm.infoUrl) {
        await api.bitcoinPuzzle.update(editingPuzzleId, {
          name: editForm.name,
          infoUrl: editForm.infoUrl,
        });
        console.log("Puzzle metadata updated");
      }

      // Mark manual phrase as tried if provided
      if (editForm.manualPhrase.trim()) {
        console.log("Marking phrase:", editForm.manualPhrase.substring(0, 30) + "...");
        const phraseResult = await api.bitcoinPuzzle.markPhrase(
          editingPuzzleId,
          editForm.manualPhrase,
          editForm.manualAddress
        );
        console.log("Phrase marked successfully:", phraseResult);
        const resultMsg = phraseResult.isPartial
          ? `✅ ${phraseResult.generatedCount} Kombinationen generiert!`
          : `✅ Phrase markiert!`;
        alert(resultMsg);
      }

      await loadPuzzles();
      setEditingPuzzleId(null);
      setEditForm({ name: "", infoUrl: "", manualPhrase: "", manualAddress: "" });
    } catch (error) {
      console.error("Error updating puzzle:", error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      alert(`❌ Fehler: ${errorMsg}`);
    }
  };

  // Lade Puzzles beim Mount (mit Race-Condition Protection)
  useEffect(() => {
    const initializePuzzles = async () => {
      // Verhindere mehrfaches Initialisieren durch race conditions
      if (initializingRef.current) return;
      initializingRef.current = true;

      try {
        // Lade einfach die bestehenden Puzzles, ohne automatisch eins zu erstellen
        await loadPuzzles();
      } catch (error) {
        console.error("Failed to load puzzles:", error);
      } finally {
        // Reset flag so the ref can be garbage collected properly if component unmounts
        initializingRef.current = false;
      }
    };

    initializePuzzles();
  }, []);

  // Auto-refresh und Event Tracking
  useEffect(() => {
    loadPuzzles();
    const interval = setInterval(() => {
      loadPuzzles().then(() => {
        // Wenn Puzzle läuft, emittiere Logs
        if (selectedPuzzleDetail?.isRunning) {
          const newEvent = {
            timestamp: new Date().toLocaleTimeString("de-DE"),
            type: selectedPuzzleDetail.currentCombinationMode === "ordered" ? "ordered" : "random",
            message: `${selectedPuzzleDetail.generatedAddresses.toLocaleString()} Kombinationen | ${(selectedPuzzleDetail.triedCombinationsCount ?? 0).toLocaleString()} versucht | ${selectedPuzzleDetail.addressesPerSecond}/sec`,
          };
          setLiveEvents((prev) => [newEvent, ...prev.slice(0, 9)]);
        }
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [selectedPuzzleId, selectedPuzzleDetail?.isRunning]);

  // Wähle Puzzle aus wenn URL Query-Parameter vorhanden ist
  useEffect(() => {
    if (initialSelectedPuzzleId && puzzles.length > 0) {
      const puzzle = puzzles.find((p) => p.id === initialSelectedPuzzleId);
      if (puzzle) {
        handleSelectPuzzle(initialSelectedPuzzleId);
      }
    }
  }, [initialSelectedPuzzleId, puzzles]);

  const handleCreatePuzzle = async () => {
    if (!formData.targetAddress.trim()) {
      alert("Bitte geben Sie eine Ziel-Bitcoin-Adresse ein");
      return;
    }

    setLoading(true);
    try {
      const result = await api.bitcoinPuzzle.create({
        targetAddress: formData.targetAddress.trim(),
        startMnemonic: formData.startMnemonic.trim() || undefined,
        name: formData.name.trim() || undefined,
        infoUrl: formData.infoUrl.trim() || undefined,
      });

      if (result.success) {
        setFormData({ name: "", targetAddress: "", infoUrl: "", startMnemonic: "" });
        setShowCreateForm(false);
        await loadPuzzles();
        setSelectedPuzzleId(result.id);
      }
    } catch (error) {
      alert("Fehler: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPuzzle = async (puzzleId: string) => {
    try {
      const detail = await api.bitcoinPuzzle.get(puzzleId);
      setSelectedPuzzleId(puzzleId);
      setSelectedPuzzleDetail(detail);
    } catch (error) {
      console.error("Failed to load puzzle detail:", error);
      // Puzzle wurde gelöscht, entferne es aus der Liste
      setPuzzles((prev) => prev.filter((p) => p.id !== puzzleId));
      setSelectedPuzzleId(null);
      setSelectedPuzzleDetail(null);
      alert("Dieses Puzzle wurde gelöscht oder existiert nicht mehr.");
    }
  };

  const handlePause = async () => {
    if (!selectedPuzzleId) return;
    try {
      await api.bitcoinPuzzle.pause(selectedPuzzleId);
      await loadPuzzles();
    } catch (error) {
      console.error("Pause failed:", error);
    }
  };

  const handleResume = async () => {
    if (!selectedPuzzleId) return;
    try {
      await api.bitcoinPuzzle.resume(selectedPuzzleId);
      await loadPuzzles();
    } catch (error) {
      console.error("Resume failed:", error);
    }
  };

  const handleStop = async () => {
    if (!selectedPuzzleId) return;
    if (!window.confirm("Diesen Puzzle wirklich stoppen?")) return;

    try {
      await api.bitcoinPuzzle.stop(selectedPuzzleId);
      setSelectedPuzzleId(null);
      setSelectedPuzzleDetail(null);
      await loadPuzzles();
    } catch (error) {
      console.error("Stop failed:", error);
    }
  };

  const copyToClipboard = (text: string, type: "address" | "mnemonic") => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  // Globale Suche
  const handleSearch = async (query: string) => {
    try {
      // Nutze Backend API um ALLE Puzzles zu durchsuchen
      const data = await api.bitcoinPuzzle.searchAll(query);

      // Flatten results: jedes Match wird ein eigenes Result-Element
      const flattened: Array<{ puzzleId: string; puzzleName: string; mnemonic: string; address: string }> = [];

      data.results.forEach((puzzleResult) => {
        puzzleResult.matches.forEach((attempt) => {
          flattened.push({
            puzzleId: puzzleResult.puzzleId,
            puzzleName: puzzleResult.puzzleName,
            mnemonic: attempt.mnemonic,
            address: attempt.address,
          });
        });
      });

      setSearchResults(flattened);
    } catch (error) {
      console.error("Search error:", error);
      setSearchResults([]);
    }
  };

  return (
    <div className="p-3 sm:p-4 space-y-6 bg-gray-950/40">
      {/* Header Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-100">Bitcoin Puzzle Solver</h2>
            <p className="text-xs text-gray-500 mt-1">Verwalte und löse Bitcoin BIP39 Puzzles</p>
          </div>
          <div className="text-xs text-gray-500">
            API: {api.bitcoinPuzzle ? "✓" : "✗"}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={async () => {
              if (loading) return;
              setLoading(true);
              try {
                console.log("Creating 0.2 BTC Puzzle...");

                const createPromise = api.bitcoinPuzzle.create({
                  targetAddress: "1KfZGvwZxsvSmemoCmEV75uqcNzYBHjkHZ",
                  name: "0.2 BTC Puzzle",
                  infoUrl: "https://privatekeys.pw/puzzles/0.2-btc-puzzle",
                });

                console.log("API call initiated, waiting for response...");
                const result = await Promise.race([
                  createPromise,
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("API Timeout nach 30 Sekunden")), 30000)
                  ),
                ]);

                console.log("Puzzle created:", result);
                if (result && typeof result === 'object' && 'id' in result) {
                  console.log("Setting selected puzzle ID:", (result as any).id);
                  setSelectedPuzzleId((result as any).id);
                  // Reload puzzles
                  console.log("Loading puzzles list...");
                  const data = await api.bitcoinPuzzle.list();
                  console.log("Puzzles loaded:", data);
                  const puzzlesWithDefaults = (data.puzzles || []).map((p: any) => ({
                    ...p,
                    triedCombinationsCount: p.triedCombinationsCount ?? 0,
                  }));
                  setPuzzles(puzzlesWithDefaults);
                  // Load detail
                  console.log("Loading puzzle detail...");
                  const detail = await api.bitcoinPuzzle.get((result as any).id);
                  console.log("Detail loaded:", detail);
                  setSelectedPuzzleDetail(detail);
                } else {
                  console.warn("Invalid result structure:", result);
                  alert("Fehler: Ungültige API-Antwort");
                }
              } catch (error) {
                console.error("Error creating puzzle:", error);
                alert("Fehler: " + (error instanceof Error ? error.message : String(error)));
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading}
            className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            📍 0.2 BTC Puzzle
          </button>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Neuer Puzzle
          </button>
        </div>
      </div>

      {/* Search Section */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-200">🔍 Globale Suche</h3>
        <input
          type="text"
          placeholder="Suche nach Adresse oder Mnemonic (über alle Puzzle)..."
          value={searchQuery}
          onChange={(e) => {
            const query = e.target.value;
            setSearchQuery(query);
            if (!query.trim()) {
              setSearchResults([]);
              return;
            }
            // Rufe async Suche auf ohne zu warten
            handleSearch(query);
          }}
          className="input text-sm w-full"
        />
        {searchResults.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-y-auto bg-gray-950/40 p-3 rounded border border-gray-800/50">
            <div className="text-xs text-gray-400 font-semibold">Gefunden: {searchResults.length} Treffer</div>
            <div className="space-y-2">
              {searchResults.map((result, idx) => (
                <div key={idx} className="text-xs bg-gray-800/50 p-3 rounded border border-gray-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-blue-400">{result.puzzleName}</span>
                    <button
                      onClick={() => {
                        setSelectedPuzzleId(result.puzzleId);
                        handleSelectPuzzle(result.puzzleId);
                      }}
                      className="text-xs text-blue-400 hover:text-blue-300 font-semibold"
                    >
                      → Öffnen
                    </button>
                  </div>
                  <div className="font-mono text-gray-300 break-all text-[11px]">{result.mnemonic}</div>
                  <div className="font-mono text-gray-500 break-all text-[11px]">📍 {result.address}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Create Form Section */}
      {showCreateForm && (
        <div className="rounded-lg border border-blue-800/50 bg-blue-900/10 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-blue-200">➕ Neuen Puzzle erstellen</h3>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 font-semibold">Puzzle Name (optional)</label>
              <input
                type="text"
                placeholder="z.B. 'Alpha Puzzle'"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input text-sm w-full mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-semibold">Ziel Bitcoin-Adresse *</label>
              <input
                type="text"
                placeholder="1A1z7agoat... oder bc1q..."
                value={formData.targetAddress}
                onChange={(e) => setFormData({ ...formData, targetAddress: e.target.value })}
                className="input text-sm w-full mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-semibold">Info URL (optional)</label>
              <input
                type="text"
                placeholder="https://example.com/puzzle-info"
                value={formData.infoUrl}
                onChange={(e) => setFormData({ ...formData, infoUrl: e.target.value })}
                className="input text-sm w-full mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-semibold">Start-Mnemonics (optional)</label>
              <textarea
                placeholder="z.B. 'abandon ability able about...'"
                value={formData.startMnemonic}
                onChange={(e) => setFormData({ ...formData, startMnemonic: e.target.value })}
                className="input text-xs w-full min-h-12 font-mono mt-1"
              />
            </div>
          </div>

          <div className="flex gap-2 pt-2 border-t border-blue-800/30">
            <button
              onClick={handleCreatePuzzle}
              disabled={loading || !formData.targetAddress.trim()}
              className="btn-primary flex-1 disabled:opacity-50"
            >
              Erstellen
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="btn-secondary flex-1"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Edit Form Section */}
      {editingPuzzleId && (
        <div className="rounded-lg border border-yellow-800/50 bg-yellow-900/10 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm text-yellow-200">✏️ Puzzle bearbeiten</h3>
            <button
              onClick={() => setEditingPuzzleId(null)}
              className="text-xs text-gray-400 hover:text-gray-300"
            >
              ✕
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-400 font-semibold">Name</label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="input text-sm w-full mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-semibold">Info URL (optional)</label>
              <input
                type="text"
                value={editForm.infoUrl}
                onChange={(e) => setEditForm({ ...editForm, infoUrl: e.target.value })}
                className="input text-sm w-full mt-1"
                placeholder="https://..."
              />
            </div>
          </div>

          <div className="border-t border-yellow-800/30 pt-4 space-y-3">
            <div>
              <label className="text-xs text-gray-400 font-semibold block mb-2">🔍 Phrase manuell hinzufügen</label>
              <div className="text-xs text-gray-500 mb-3 bg-gray-800/30 p-2 rounded border border-gray-800">
                Vollständige Mnemonic oder mit <code className="bg-gray-900 px-1 rounded">__</code> / <code className="bg-gray-900 px-1 rounded">?</code> für fehlende Wörter
                {editForm.manualPhrase && (editForm.manualPhrase.includes("__") || editForm.manualPhrase.includes("?")) && (
                  <span className="text-blue-300 block mt-1">
                    ℹ️ Wird zu Kombinationen erweitert
                  </span>
                )}
              </div>
              <textarea
                value={editForm.manualPhrase}
                onChange={(e) => setEditForm({ ...editForm, manualPhrase: e.target.value })}
                className="input text-sm w-full font-mono"
                placeholder="z.B. 'word1 word2 __ word4 __ word6' oder nur 'word1 word2 word3 ... word12'"
                rows={3}
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 font-semibold">Zugehörige Adresse (optional)</label>
              <input
                type="text"
                value={editForm.manualAddress}
                onChange={(e) => setEditForm({ ...editForm, manualAddress: e.target.value })}
                className="input text-sm w-full mt-1"
                placeholder="Adresse..."
              />
            </div>
          </div>

          <div className="flex gap-2 pt-2 border-t border-yellow-800/30">
            <button
              onClick={handleEditPuzzle}
              className="btn-primary flex-1"
            >
              Speichern
            </button>
            <button
              onClick={() => setEditingPuzzleId(null)}
              className="btn-secondary flex-1"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Puzzles List & Detail Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-gray-100">📋 Puzzle Übersicht</h3>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Puzzles List */}
          <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3 max-h-[500px] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm">Alle Puzzles</h4>
              <span className="text-xs bg-gray-800 px-2 py-1 rounded-full">{puzzles.length}</span>
            </div>

          {puzzles.length === 0 ? (
            <div className="text-xs text-gray-500 py-4 text-center">Keine Puzzles</div>
          ) : (
            puzzles.map((puzzle) => (
              <button
                key={puzzle.id}
                onClick={() => handleSelectPuzzle(puzzle.id)}
                className={`w-full text-left rounded px-2 py-2 text-xs transition ${
                  selectedPuzzleId === puzzle.id
                    ? "border border-blue-500 bg-blue-500/10"
                    : "border border-gray-800 hover:border-gray-700"
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold truncate flex-1">{puzzle.name}</div>
                    <div
                      className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${
                        puzzle.status === "running"
                          ? "bg-green-500/20 text-green-300"
                          : puzzle.status === "paused"
                            ? "bg-yellow-500/20 text-yellow-300"
                            : puzzle.status === "completed"
                              ? "bg-blue-500/20 text-blue-300"
                              : puzzle.found
                                ? "bg-purple-500/20 text-purple-300"
                                : "bg-gray-700/20 text-gray-300"
                      }`}
                    >
                      {puzzle.found ? "✓" : puzzle.status}
                    </div>
                  </div>
                  <div className="text-gray-400 text-[10px] truncate">{puzzle.targetAddress}</div>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-gray-500">
                    <div>{puzzle.generatedAddresses.toLocaleString()} Adressen</div>
                    <div>{puzzle.triedCombinationsCount.toLocaleString()} Versucht</div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

          {/* Puzzle Detail */}
          {selectedPuzzleDetail && (
            <div className="lg:col-span-2 rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold">{selectedPuzzleDetail.name}</h4>
                  <div className="flex items-center gap-3">
                  <a
                    href={`/api/bitcoin-puzzle/${selectedPuzzleId}/attempts.csv`}
                    download
                    className="text-xs text-yellow-400 hover:text-yellow-300"
                    title="CSV Download"
                  >
                    [CSV ↓]
                  </a>
                  <a
                    href={`#puzzle-${selectedPuzzleId}-all-attempts`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(`puzzle-${selectedPuzzleId}-all-attempts`)?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className="text-xs text-green-400 hover:text-green-300"
                    title="Zur vollständigen Liste"
                  >
                    [Liste →]
                  </a>
                  <button
                    onClick={() => {
                      setEditForm({
                        name: selectedPuzzleDetail.name,
                        infoUrl: selectedPuzzleDetail.infoUrl || "",
                        manualPhrase: "",
                        manualAddress: "",
                      });
                      setEditingPuzzleId(selectedPuzzleId);
                    }}
                    className="text-xs text-purple-400 hover:text-purple-300"
                    title="Bearbeiten"
                  >
                    [✏️]
                  </button>
                  <button
                    onClick={async () => {
                      if (selectedPuzzleId && confirm(`Sind Sie sicher, dass Sie das Puzzle "${selectedPuzzleDetail.name}" löschen möchten? Dies kann nicht rückgängig gemacht werden.`)) {
                        try {
                          await api.bitcoinPuzzle.delete(selectedPuzzleId);
                          // Entferne das Puzzle sofort aus der Liste
                          setPuzzles((prev) => prev.filter((p) => p.id !== selectedPuzzleId));
                          setSelectedPuzzleId(null);
                          setSelectedPuzzleDetail(null);
                        } catch (error) {
                          alert(`Fehler beim Löschen: ${error}`);
                        }
                      }
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                    title="Löschen"
                  >
                    [🗑️]
                  </button>
                  </div>
                </div>

                {selectedPuzzleDetail.infoUrl && (
                  <a
                    href={selectedPuzzleDetail.infoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                  >
                    <Eye className="w-3 h-3" />
                    Info anzeigen
                  </a>
                )}

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">Kombinationen</div>
                  <div className="font-mono font-semibold">
                    {selectedPuzzleDetail.generatedAddresses.toLocaleString()}
                  </div>
                </div>
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">Versucht</div>
                  <div className="font-mono font-semibold">
                    {(selectedPuzzleDetail.triedCombinationsCount ?? 0).toLocaleString()}
                  </div>
                </div>
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">Strategie</div>
                  <div className="font-mono font-semibold capitalize">
                    {selectedPuzzleDetail.currentCombinationMode}
                  </div>
                </div>
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">/Sek</div>
                  <div className="font-mono font-semibold">
                    {selectedPuzzleDetail.addressesPerSecond.toLocaleString()}
                  </div>
                </div>
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">Laufzeit</div>
                  <div className="font-mono font-semibold">{selectedPuzzleDetail.elapsedSeconds}s</div>
                </div>
                <div className="bg-gray-800/50 p-2 rounded">
                  <div className="text-gray-400">Status</div>
                  <div
                    className={`font-semibold text-xs ${
                      selectedPuzzleDetail.isRunning ? "text-green-400" : "text-gray-400"
                    }`}
                  >
                    {selectedPuzzleDetail.status}
                  </div>
                </div>
                </div>

                {/* Live Event Log */}
                {liveEvents.length > 0 && (
                  <div className="bg-gray-800/30 border border-gray-700 rounded p-2 max-h-32 overflow-y-auto">
                    <div className="text-xs font-semibold text-gray-300 mb-1">Live Events</div>
                    <div className="space-y-1 font-mono text-xs">
                      {liveEvents.map((event, idx) => (
                        <div key={idx} className="flex items-start gap-2">
                          <span className="text-gray-500 flex-shrink-0">{event.timestamp}</span>
                          <span className={`flex-shrink-0 w-12 ${event.type === "ordered" ? "text-orange-400" : "text-blue-400"}`}>
                            [{event.type}]
                          </span>
                          <span className="text-gray-400 truncate">{event.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent Attempts */}
                {selectedPuzzleDetail?.recentAttempts && selectedPuzzleDetail.recentAttempts.length > 0 && (
                  <div id={`puzzle-${selectedPuzzleId}-all-attempts`} className="bg-gray-800/30 border border-gray-700 rounded p-2">
                    <div className="flex items-center justify-between mb-2">
                      <button
                        onClick={() => setShowRecentAttempts(!showRecentAttempts)}
                        className="flex items-center gap-2 text-xs font-semibold text-gray-300 hover:text-gray-200"
                      >
                        <span>{showRecentAttempts ? "▼" : "▶"}</span>
                        Letzte 50 Versuche ({selectedPuzzleDetail.recentAttempts.length})
                      </button>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          setShowRecentAttempts(true);
                        }}
                        className="text-xs text-blue-400 hover:text-blue-300"
                        title="Liste der Versuche anzeigen"
                      >
                        [Öffnen →]
                      </a>
                    </div>
                    {showRecentAttempts && (
                      <div className="mt-2 max-h-80 overflow-y-auto space-y-1">
                        {selectedPuzzleDetail.recentAttempts.map((attempt, idx) => (
                          <div key={idx} className="text-xs bg-gray-900/50 rounded hover:bg-gray-900/80 p-1.5">
                            <div className="text-gray-500 mb-0.5">#{idx + 1}</div>
                            <div className="font-mono text-gray-300 break-all text-xs">{attempt.mnemonic}</div>
                            <div className="font-mono text-gray-500 break-all text-xs mt-0.5">📍 {attempt.address}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Controls */}
                <div className="flex gap-2 pt-2">
                  {!selectedPuzzleDetail.isRunning ? (
                    <button
                      onClick={handleResume}
                      className="btn-secondary flex items-center gap-2 flex-1"
                    >
                      <Play className="w-4 h-4" />
                      Weiter
                    </button>
                  ) : (
                    <button
                      onClick={handlePause}
                      className="btn-secondary flex items-center gap-2 flex-1"
                    >
                      <Pause className="w-4 h-4" />
                      Pause
                    </button>
                  )}
                  <button
                    onClick={handleStop}
                    className="btn-secondary flex items-center gap-2 text-red-300"
                  >
                    <StopCircle className="w-4 h-4" />
                  </button>
                </div>

                {/* Error */}
                {selectedPuzzleDetail.error && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded p-2">
                    <div className="text-xs text-red-300">{selectedPuzzleDetail.error}</div>
                  </div>
                )}

                {/* Success */}
                {selectedPuzzleDetail.foundMnemonic && (
                  <div className="bg-green-500/10 border border-green-500/30 rounded p-3 space-y-2">
                    <div className="font-semibold text-sm text-green-300">✓ Gelöst!</div>

                    <div className="space-y-1">
                      <div className="text-xs text-gray-400">Zieladresse (Zielwert)</div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-gray-800 px-2 py-1 rounded flex-1 truncate font-mono">
                          {selectedPuzzleDetail.targetAddress}
                        </code>
                        <button
                          onClick={() =>
                            copyToClipboard(selectedPuzzleDetail.targetAddress!, "address")
                          }
                          className="p-1 hover:bg-gray-700 rounded"
                        >
                          {copied === "address" ? (
                            <Check className="w-4 h-4 text-green-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs text-gray-400">Gefundene Bitcoin-Adresse</div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-gray-800 px-2 py-1 rounded flex-1 truncate font-mono">
                          {selectedPuzzleDetail.foundAddress}
                        </code>
                        <button
                          onClick={() =>
                            copyToClipboard(selectedPuzzleDetail.foundAddress!, "address")
                          }
                          className="p-1 hover:bg-gray-700 rounded"
                        >
                          {copied === "address" ? (
                            <Check className="w-4 h-4 text-green-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs text-gray-400">Mnemonic (Seed Phrase)</div>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-gray-800 px-2 py-1 rounded flex-1 font-mono overflow-x-auto whitespace-nowrap">
                          {selectedPuzzleDetail.foundMnemonic}
                        </code>
                        <button
                          onClick={() =>
                            copyToClipboard(selectedPuzzleDetail.foundMnemonic!, "mnemonic")
                          }
                          className="p-1 hover:bg-gray-700 rounded shrink-0"
                        >
                          {copied === "mnemonic" ? (
                            <Check className="w-4 h-4 text-green-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Info Section */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-200">ℹ️ Informationen</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-gray-400">
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Mehrere Puzzles können gleichzeitig gelöst werden</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Keine Duplikate: Versuchte Kombinationen werden trackiert</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Verschiedene Strategien: Random & Ordered Combinations</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Detaillierte Statistiken: Versuche, Strategie, Geschwindigkeit</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Jeder Puzzle mit Info URL verlinkt</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-gray-500 mt-0.5">•</span>
            <span>Löser können pausiert und fortgesetzt werden</span>
          </div>
        </div>
      </div>
    </div>
  );
}
