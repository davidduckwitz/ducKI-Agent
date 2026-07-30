import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Download, Copy } from "lucide-react";

interface QRCodeModalProps {
  address: string;
  label?: string;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QRCodeModal({
  address,
  label,
  currency,
  open,
  onOpenChange,
}: QRCodeModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");

  useEffect(() => {
    if (!open) return;

    // Dynamically import qrcode library and generate as data URL
    import("qrcode")
      .then((QRCode) => {
        // Generate QR code as data URL
        const options = {
          errorCorrectionLevel: "H" as const,
          type: "image/png" as const,
          margin: 2,
          width: 300,
          color: {
            dark: "#000000",
            light: "#FFFFFF",
          },
        };
        return QRCode.toDataURL(address, options);
      })
      .then((dataUrl: string) => {
        if (typeof dataUrl === "string") {
          setQrDataUrl(dataUrl);

          // Also render to canvas for download functionality
          if (canvasRef.current) {
            const img = new Image();
            img.onload = () => {
              const ctx = canvasRef.current?.getContext("2d");
              if (ctx && canvasRef.current) {
                canvasRef.current.width = 300;
                canvasRef.current.height = 300;
                ctx.drawImage(img, 0, 0);
              }
            };
            img.src = dataUrl;
          }
        }
      })
      .catch((error) => {
        console.error("QR Code generation failed:", error);
        setQrDataUrl("");
      });
  }, [open, address]);

  const handleDownload = () => {
    if (!qrDataUrl) return;

    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `${currency}-${label || "address"}-qr.png`;
    link.click();
  };

  const handleCopyAddress = () => {
    navigator.clipboard.writeText(address);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{currency} - QR Code</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* QR Code Display */}
          <div className="flex justify-center p-4 bg-white rounded-lg">
            {qrDataUrl ? (
              <img
                ref={imgRef}
                src={qrDataUrl}
                alt="QR Code"
                className="max-w-xs w-full h-auto"
              />
            ) : (
              <canvas
                ref={canvasRef}
                className="max-w-xs"
              />
            )}
          </div>

          {/* Label & Address Info */}
          <div className="space-y-2">
            {label && (
              <div>
                <div className="text-sm text-muted-foreground">Label</div>
                <div className="font-medium">{label}</div>
              </div>
            )}
            <div>
              <div className="text-sm text-muted-foreground">Address</div>
              <div className="font-mono text-sm break-all p-2 bg-muted rounded">
                {address}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-4">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={handleCopyAddress}
            >
              <Copy className="h-4 w-4" />
              Kopieren
            </Button>
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={handleDownload}
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
          </div>

          {/* Info */}
          <div className="text-xs text-muted-foreground text-center p-2 bg-muted rounded">
            Dieser QR-Code kann zum Senden von Kryptowährungen an diese Adresse verwendet werden.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
