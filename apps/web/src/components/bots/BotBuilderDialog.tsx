/**
 * Bot builder: a tabbed create/edit dialog for custom bots (Persona / Avatar / Skills &
 * Tools / Model), replacing the old flat one-Card form. Reuses existing app primitives
 * (Dialog, Tabs) and existing data-fetching patterns (ProviderModelSelector for
 * provider/model, the same api.skills/api.tools listings SkillManager/ToolManager use)
 * instead of inventing new ones.
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import type { BotInfo, BotInput } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ProviderModelSelector } from "../chat/ProviderModelSelector";
import { BotAvatarPicker } from "./BotAvatarPicker";
import { BotAvatar } from "./BotAvatar";
import { SkillMultiSelect } from "./SkillMultiSelect";
import { ToolMultiSelect } from "./ToolMultiSelect";

const EMPTY_FORM: BotInput = {
  name: "",
  description: "",
  systemPrompt: "",
  avatar: "",
  providerId: "",
  modelId: "",
  skillWhitelist: [],
  toolWhitelist: [],
};

function botToForm(bot: BotInfo): BotInput {
  return {
    name: bot.name,
    description: bot.description ?? "",
    systemPrompt: bot.systemPrompt ?? "",
    avatar: bot.avatar ?? "",
    providerId: bot.providerId ?? "",
    modelId: bot.modelId ?? "",
    skillWhitelist: bot.skillWhitelist ? (JSON.parse(bot.skillWhitelist) as string[]) : [],
    toolWhitelist: bot.toolWhitelist ? (JSON.parse(bot.toolWhitelist) as string[]) : [],
  };
}

export function BotBuilderDialog({
  open,
  onOpenChange,
  editingBot,
  onSubmit,
  submitting,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = create mode, a bot = edit mode (pre-fills the form). */
  editingBot?: BotInfo;
  onSubmit: (data: BotInput) => void;
  submitting?: boolean;
  error?: string;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<BotInput>(EMPTY_FORM);
  const [tab, setTab] = useState("persona");

  useEffect(() => {
    if (!open) return;
    setForm(editingBot ? botToForm(editingBot) : EMPTY_FORM);
    setTab("persona");
  }, [open, editingBot]);

  const isEdit = Boolean(editingBot);
  const canSubmit = form.name.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            {isEdit ? t("bots.builder.editTitle").replace("{name}", editingBot?.name ?? "") : t("bots.builder.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("bots.builder.subtitle")}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="persona">{t("bots.builder.tabs.persona")}</TabsTrigger>
            <TabsTrigger value="avatar">{t("bots.builder.tabs.avatar")}</TabsTrigger>
            <TabsTrigger value="access">{t("bots.builder.tabs.access")}</TabsTrigger>
            <TabsTrigger value="model">{t("bots.builder.tabs.model")}</TabsTrigger>
          </TabsList>

          <TabsContent value="persona" className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bot-name">{t("bots.builder.persona.name")}</Label>
              <Input
                id="bot-name"
                placeholder={t("bots.builder.persona.namePlaceholder")}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-description">{t("bots.builder.persona.description")}</Label>
              <Input
                id="bot-description"
                placeholder={t("bots.builder.persona.descriptionPlaceholder")}
                value={form.description ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bot-system-prompt">{t("bots.builder.persona.systemPrompt")}</Label>
              <textarea
                id="bot-system-prompt"
                className="flex min-h-32 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={t("bots.builder.persona.systemPromptPlaceholder")}
                value={form.systemPrompt ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              />
            </div>
          </TabsContent>

          <TabsContent value="avatar">
            <BotAvatarPicker value={form.avatar} onChange={(avatar) => setForm((f) => ({ ...f, avatar }))} />
          </TabsContent>

          <TabsContent value="access" className="space-y-4">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t("bots.builder.access.skillsLabel")}</p>
              <SkillMultiSelect
                value={form.skillWhitelist ?? []}
                onChange={(skillWhitelist) => setForm((f) => ({ ...f, skillWhitelist }))}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t("bots.builder.access.toolsLabel")}</p>
              <ToolMultiSelect
                value={form.toolWhitelist ?? []}
                onChange={(toolWhitelist) => setForm((f) => ({ ...f, toolWhitelist }))}
              />
            </div>
          </TabsContent>

          <TabsContent value="model" className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("bots.builder.model.hint")}</p>
            <ProviderModelSelector
              selectedProvider={form.providerId || undefined}
              selectedModel={form.modelId || undefined}
              onProviderChange={(providerId) => setForm((f) => ({ ...f, providerId: providerId ?? "" }))}
              onModelChange={(modelId) => setForm((f) => ({ ...f, modelId: modelId ?? "" }))}
            />
          </TabsContent>
        </Tabs>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <BotAvatar avatar={form.avatar} size={28} />
            <span className="text-xs text-muted-foreground">{form.name.trim() || t("bots.builder.persona.namePlaceholder")}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("bots.builder.cancel")}
            </Button>
            <Button disabled={!canSubmit} onClick={() => onSubmit(form)}>
              {isEdit ? t("bots.builder.save") : t("bots.builder.create")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
