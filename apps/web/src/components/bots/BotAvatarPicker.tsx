/**
 * Avatar picker for the bot builder: reuses the same visual gallery the Settings ->
 * Character tab uses for desk pets (BUILT_IN_PETS + plugin pets + imported sprite pets),
 * plus the character gallery, plus a custom image upload that goes through the existing
 * shared-workspace upload endpoint (POST /shared/upload) - no new backend route needed.
 */

import { useRef, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { PetView } from "../pet/PetView";
import { BUILT_IN_PETS } from "../pet/petRegistry";
import { usePluginPets } from "../pet/usePluginPets";
import { usePetStore } from "../../lib/petStore";
import { characterRegistry, DynamicCharacter } from "../chat/characters";
import { BotAvatar } from "./BotAvatar";
import "../pet/pet.css";

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function BotAvatarPicker({ value, onChange }: { value?: string; onChange: (avatar: string) => void }) {
  const { t } = useI18n();
  const pluginPets = usePluginPets();
  const customPets = usePetStore((s) => s.customPets);
  const allPets = [...BUILT_IN_PETS, ...pluginPets, ...customPets];
  const allCharacters = characterRegistry.getAllCharacters();

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setUploadError(t("bots.builder.avatar.uploadInvalid"));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(t("bots.builder.avatar.uploadTooLarge"));
      return;
    }
    setUploadError(undefined);
    setUploading(true);
    try {
      const contentBase64 = await fileToBase64(file);
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const fileName = `bot-avatar-${Date.now()}.${ext}`;
      const result = await api.shared.uploadFile({ fileName, contentBase64, folder: "bot-avatars" });
      onChange(api.shared.viewUrl(result.path));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card/40 p-3">
        <div className="pet-checker flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-border">
          <BotAvatar avatar={value} size={48} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("bots.builder.avatar.currentLabel")}</p>
          <p className="truncate text-xs text-muted-foreground">{value || t("bots.builder.avatar.none")}</p>
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("bots.builder.avatar.gallery")}</p>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {allPets.map((pet) => {
            const active = value === pet.id;
            return (
              <button
                key={pet.id}
                type="button"
                title={pet.name}
                onClick={() => onChange(pet.id)}
                className={`pet-checker relative flex aspect-square items-center justify-center rounded-lg border p-1 transition ${
                  active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40"
                }`}
              >
                <PetView pet={pet} state={active ? "wave" : "idle"} size={40} />
                {active ? (
                  <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                ) : null}
              </button>
            );
          })}
          {allCharacters.map((character) => {
            const active = value === character.id;
            return (
              <button
                key={character.id}
                type="button"
                title={character.name}
                onClick={() => onChange(character.id)}
                className={`relative flex aspect-square items-center justify-center rounded-lg border bg-gray-950 p-1 transition ${
                  active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/40"
                }`}
              >
                <DynamicCharacter characterId={character.id} isWorking={active} size={36} />
                {active ? (
                  <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("bots.builder.avatar.uploadLabel")}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="btn-secondary flex w-full items-center justify-center gap-2 py-2 text-xs disabled:opacity-60"
        >
          {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {uploading ? t("bots.builder.avatar.uploading") : t("bots.builder.avatar.uploadButton")}
        </button>
        {uploadError ? <p className="mt-1 text-xs text-destructive">{uploadError}</p> : null}
        <p className="mt-1 text-[11px] text-muted-foreground">{t("bots.builder.avatar.uploadHint")}</p>
      </div>
    </div>
  );
}
