import { Bitcoin, Zap, Waves } from "lucide-react";

interface CurrencyIconProps {
  currency: "BTC" | "ETH" | "XRP";
  size?: number;
  className?: string;
}

export function CurrencyIcon({
  currency,
  size = 20,
  className = "",
}: CurrencyIconProps) {
  const iconProps = { size, className };

  switch (currency) {
    case "BTC":
      return <Bitcoin {...iconProps} />;
    case "ETH":
      return <Zap {...iconProps} />;
    case "XRP":
      return <Waves {...iconProps} />;
    default:
      return null;
  }
}

export function getCurrencyColor(currency: "BTC" | "ETH" | "XRP"): string {
  switch (currency) {
    case "BTC":
      return "text-orange-500";
    case "ETH":
      return "text-purple-500";
    case "XRP":
      return "text-blue-500";
    default:
      return "text-gray-500";
  }
}

export function getCurrencyBgColor(currency: "BTC" | "ETH" | "XRP"): string {
  switch (currency) {
    case "BTC":
      return "bg-orange-500/10";
    case "ETH":
      return "bg-purple-500/10";
    case "XRP":
      return "bg-blue-500/10";
    default:
      return "bg-gray-500/10";
  }
}

export function getCurrencyEmoji(currency: "BTC" | "ETH" | "XRP"): string {
  switch (currency) {
    case "BTC":
      return "₿";
    case "ETH":
      return "Ξ";
    case "XRP":
      return "✕";
    default:
      return "¤";
  }
}
