import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { PortfolioOverview } from "../../components/crypto/PortfolioOverview";
import { AddressesList } from "../../components/crypto/AddressesList";
import { TransactionsList } from "../../components/crypto/TransactionsList";
import { CryptoSettingsPanel } from "../../components/crypto/CryptoSettingsPanel";
import { useAddresses } from "../../hooks/useCrypto";
import { Wallet, History, Settings, BarChart3, Target } from "lucide-react";

export function CryptoPaymentPage() {
  const { data: addresses } = useAddresses();
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState("portfolio");

  // Select first address by default
  const displayAddressId = selectedAddressId || addresses?.[0]?.id;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">💰 Crypto Payment</h1>
        <p className="text-muted-foreground">
          Verwalten Sie Ihre Bitcoin-, Ethereum- und XRP-Adressen
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="portfolio" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            <span className="hidden sm:inline">Portfolio</span>
          </TabsTrigger>
          <TabsTrigger value="addresses" className="gap-2">
            <Wallet className="h-4 w-4" />
            <span className="hidden sm:inline">Adressen</span>
          </TabsTrigger>
          <TabsTrigger value="transactions" className="gap-2">
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Transaktionen</span>
          </TabsTrigger>
          <TabsTrigger value="puzzle" className="gap-2">
            <Target className="h-4 w-4" />
            <span className="hidden sm:inline">BTC Puzzle</span>
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-2">
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">Einstellungen</span>
          </TabsTrigger>
        </TabsList>

        {/* Portfolio Tab */}
        <TabsContent value="portfolio" className="space-y-4">
          <PortfolioOverview />
        </TabsContent>

        {/* Addresses Tab */}
        <TabsContent value="addresses" className="space-y-4">
          <AddressesList />
        </TabsContent>

        {/* Transactions Tab */}
        <TabsContent value="transactions" className="space-y-4">
          {displayAddressId ? (
            <TransactionsList addressId={displayAddressId} />
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              Generieren Sie zunächst eine Adresse
            </div>
          )}
        </TabsContent>

        {/* Bitcoin Puzzle Solver moved to its own plugin */}
        <TabsContent value="puzzle" className="space-y-4">
          <div className="rounded-lg border bg-card p-8 text-center space-y-3">
            <Target className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-muted-foreground">
              Der Bitcoin-Puzzle-Solver ist jetzt ein eigenständiges Plugin mit eigenem Dashboard.
            </p>
            <a
              href="/api/plugins/bitcoin-puzzle/ui/frontend"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm font-medium text-primary underline underline-offset-4"
            >
              Zum Bitcoin-Puzzle-Plugin öffnen →
            </a>
          </div>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings" className="space-y-4">
          <CryptoSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
