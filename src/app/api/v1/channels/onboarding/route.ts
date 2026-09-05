import QRCode from "qrcode";
import { channelSetups } from "@/lib/channel-onboarding";

// Public bot entry links only. No account identifiers or bot credentials.
export async function GET() {
  const providers = await Promise.all(channelSetups().map(async (provider) => ({
    ...provider,
    qrDataUrl: provider.entryUrl ? await QRCode.toDataURL(provider.entryUrl, { width: 232, margin: 4, errorCorrectionLevel: "M" }) : undefined,
  })));
  return Response.json({ providers }, { headers: { "Cache-Control": "no-store" } });
}
